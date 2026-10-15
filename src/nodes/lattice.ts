import { Encoder, Decoder, CorruptInputError } from '../packer';
import { RangePrior, checkIndex, checkRange, priorKind, type Prior } from './weights';
import {
  AdaptivePrior,
  checkAdaptation,
  checkAdaptiveMembers,
  type AdaptiveOptions,
} from './adaptive';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/**
 * The two slots of a range of exactly 2^53 values: a radix is a safe
 * integer, and 2^53 is one past the largest, so the offset packs as two
 * digits whose radices multiply to it, at the same 53 bits.
 */
const SPLIT_HIGH = 2 ** 26;
const SPLIT_LOW = 2 ** 27;

/**
 * One integer index on the shared lattice wire, against optional [min, max]
 * bounds and optionally under a prior: the half of PInt, PDecimal, PDate,
 * p.versioned and every length prefix that is not about mapping a value to
 * its index. Both bounds -> one slot of exact radix, or two whose radices
 * multiply to 2^53 for the widest range, one state past what a radix holds;
 * one bound -> a term counting away from it (downward from a max, so the
 * term stays non-negative); unbounded -> sign before magnitude, the order
 * every signed value on the wire reads. Every bounded integer packs through
 * here, so their layouts can never drift apart. The range is validated once
 * here, and `write`/`read` check the bounds and pack the index, uniformly or
 * weighted. `show` spells an index as the value it stands for in an error.
 * Adaptive options turn the prior adaptive: the declared weights, ones when
 * none are, with the values a message writes learned on top.
 */
export class IndexRange {
  readonly lo?: number;
  readonly hi?: number;
  /**
   * The prior as given, in every mode (static, cdf or adaptive), so a node
   * rebuilding the range after a bound change passes it on.
   */
  readonly declared?: Prior;
  readonly prior?: RangePrior;
  /**
   * The adaptive options as given, set when the prior adapts; the weights
   * then live in the learner, not `prior`.
   */
  readonly adaptive?: AdaptiveOptions;
  /** The one radix an index packs in: both bounds, no prior or adaptive options, fewer than 2^53 values. */
  readonly radix?: number;
  /** Set with `radix`: the index `digit` steps above min, as a digit read in `radix` stands for. */
  readonly fromDigit?: (digit: number) => number;
  /**
   * Set with `radix`: the digit `write` composes for `index`, throwing exactly
   * as `write` would.
   */
  readonly toDigit?: (index: number, subject?: () => string) => number;
  /** The adaptive prior and the min its member 0 stands for. */
  private readonly learner?: { readonly prior: AdaptivePrior; readonly lo: number };
  private readonly show: (index: number) => string;

  constructor(
    who: string,
    lo?: number,
    hi?: number,
    prior?: Prior,
    adaptive?: AdaptiveOptions,
    show: (index: number) => string = String
  ) {
    checkRange(who, lo, hi, show);
    if (adaptive !== undefined) {
      const adaptation = checkAdaptation(adaptive, who);
      if (lo === undefined || hi === undefined) {
        throw new TypeError(`${who} adaptive requires both bounds`);
      }
      if (typeof prior === 'function') {
        throw new TypeError(`${who} adaptive takes weights, not a cdf`);
      }
      const n = hi - lo + 1;
      checkAdaptiveMembers(n, who);
      const weights = prior ?? new Array<number>(n).fill(1);
      this.adaptive = adaptive;
      this.learner = { prior: new AdaptivePrior([weights], n, adaptation.window, who), lo };
    } else if (prior !== undefined) {
      if (lo === undefined || hi === undefined) {
        throw new TypeError(`${who} ${priorKind(prior)} requires both bounds`);
      }
      this.prior = new RangePrior(prior, lo, hi, who, show);
    }
    this.declared = prior;
    this.lo = lo;
    // A max of -0 reads back as max - 0, itself -0; stored as 0, no index
    // decodes as -0.
    this.hi = hi === undefined ? undefined : hi + 0;
    if (
      lo !== undefined &&
      hi !== undefined &&
      prior === undefined &&
      adaptive === undefined &&
      hi - lo < MAX_SAFE
    ) {
      this.radix = hi - lo + 1;
      this.fromDigit = (digit) => lo + digit;
      this.toDigit = (index, subject = () => `Value ${show(index)}`) => {
        checkIndex(index, lo, hi, subject, show);
        return index - lo;
      };
    }
    this.show = show;
  }

  /** `subject` names the value in an error, as in `Date 2020-01-01T00:00:00.000Z`. */
  write(
    enc: Encoder,
    index: number,
    subject: () => string = () => `Value ${this.show(index)}`
  ): void {
    if (this.prior !== undefined) {
      this.prior.write(enc, index, subject);
      return;
    }
    checkIndex(index, this.lo, this.hi, subject, this.show);
    if (this.learner !== undefined) {
      this.learner.prior.write(enc, index - this.learner.lo);
      return;
    }
    this.writeIndex(enc, index);
  }

  read(dec: Decoder): number {
    if (this.learner !== undefined) {
      return this.learner.lo + this.learner.prior.read(dec);
    }
    return this.prior === undefined ? this.readIndex(dec) : this.prior.read(dec);
  }

  /** Packs `index`, an integer within the bounds as `write` checked. */
  private writeIndex(enc: Encoder, index: number): void {
    const { lo, hi } = this;
    if (lo !== undefined && hi !== undefined) {
      const offset = index - lo;
      if (hi - lo < MAX_SAFE) {
        enc.compose(offset, hi - lo + 1);
      } else {
        enc.compose(Math.floor(offset / SPLIT_LOW), SPLIT_HIGH);
        enc.compose(offset % SPLIT_LOW, SPLIT_LOW);
      }
    } else if (lo !== undefined) {
      const offset = index - lo;
      // Float subtraction rounds once the offset passes 2^53, which would
      // silently encode a neighbouring value, so anything that cannot
      // reconstruct exactly is refused; the check IS the decode expression.
      if (lo + offset !== index) {
        throw new RangeError(
          `Value ${this.show(index)} is too far from its bound ${this.show(lo)} to encode exactly`
        );
      }
      enc.composeTerm(offset);
    } else if (hi !== undefined) {
      const offset = hi - index;
      if (hi - offset !== index) {
        throw new RangeError(
          `Value ${this.show(index)} is too far from its bound ${this.show(hi)} to encode exactly`
        );
      }
      enc.composeTerm(offset);
    } else {
      // -0 fails `index < 0` and packs as 0, as it does through the bounded
      // branches' subtractions, so callers pass it unnormalised.
      enc.compose(index < 0 ? 1 : 0, 2);
      enc.composeTerm(Math.abs(index));
    }
  }

  /** Reads an index without a prior, in the layout `writeIndex` packs. */
  private readIndex(dec: Decoder): number {
    const { lo, hi } = this;
    if (lo !== undefined && hi !== undefined) {
      if (hi - lo < MAX_SAFE) {
        return lo + dec.parse(hi - lo + 1);
      }
      return lo + dec.parse(SPLIT_HIGH) * SPLIT_LOW + dec.parse(SPLIT_LOW);
    }
    if (lo !== undefined) {
      const offset = dec.parseTerm();
      const index = lo + offset;
      // Counterpart of the encode-side exactness guard: an offset whose sum
      // rounds could never have been emitted.
      if (index - lo !== offset) {
        throw new CorruptInputError('Term offset is outside the exact range of its bound');
      }
      return index;
    }
    if (hi !== undefined) {
      const offset = dec.parseTerm();
      const index = hi - offset;
      if (hi - index !== offset) {
        throw new CorruptInputError('Term offset is outside the exact range of its bound');
      }
      return index;
    }
    const negative = dec.parse(2) === 1;
    const magnitude = dec.parseTerm();
    // A signed zero reads as 0; negating zero is the only way -0 could arise.
    return negative && magnitude !== 0 ? -magnitude : magnitude;
  }
}

/** The declared bounds of a length or count; a fixed length is min === max. */
export interface LengthBounds {
  readonly min?: number;
  readonly max?: number;
  readonly prior?: Prior;
  readonly adaptive?: AdaptiveOptions;
}

/** A length or count bound: a non-negative integer, checked at definition. */
export const lengthBound = (
  n: number | undefined,
  who: string,
  which: string
): number | undefined => {
  if (n === undefined) {
    return undefined;
  }
  if (!Number.isInteger(n)) {
    throw new TypeError(`${who} ${which} must be a non-negative integer, got ${n}`);
  }
  if (n < 0) {
    throw new RangeError(`${who} ${which} must be a non-negative integer, got ${n}`);
  }
  return n;
};

/**
 * The range of a string, byte-run or array length, its floor defaulting to
 * 0. `noun` names the quantity in an error, as in `p.array weights requires
 * a max count`.
 */
export function lengthRange(bounds: LengthBounds, who: string, noun: string): IndexRange {
  const min = lengthBound(bounds.min, who, 'min');
  const max = lengthBound(bounds.max, who, 'max');
  const { prior, adaptive } = bounds;
  if (prior !== undefined && max === undefined) {
    throw new TypeError(`${who} ${priorKind(prior)} requires a max ${noun}`);
  }
  if (adaptive !== undefined && max === undefined) {
    throw new TypeError(`${who} adaptive requires a max ${noun}`);
  }
  return new IndexRange(who, min ?? 0, max, prior, adaptive);
}

/** Refuses a second `min`, `max` or order restriction on one node: each is set once. */
export function checkUnset(
  current: unknown,
  who: string,
  bound: 'min' | 'max' | 'sorted' | 'unique' | 'unordered'
): void {
  if (current !== undefined) {
    throw new TypeError(`${who} ${bound} is already set`);
  }
}
