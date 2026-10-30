import { Encoder, Decoder, CorruptInputError } from '../packer';
import { RangePrior, checkIndex, checkRange, priorKind, type Prior } from './weights';
import {
  AdaptivePrior,
  MAX_COMPRESS_MEMBERS,
  checkAdaptation,
  checkCompressMembers,
  kinOf,
  type AdaptOptions,
} from './adaptive';
import { LearnedMagnitude, type Magnitude } from './magnitude';
import { session } from '../predictor/session';
import type { PlainNumber } from '../predictor/session';
import type { Resolved } from '../predictor/types';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/**
 * The two slots of a range of exactly 2^53 values: a radix is a safe
 * integer, and 2^53 is one past the largest, so the offset packs as two
 * digits whose radices multiply to it, at the same 53 bits.
 */
const SPLIT_HIGH = 2 ** 26;
const SPLIT_LOW = 2 ** 27;

/** A range's learned odds of an offset, coded through and taught apart. */
interface LearnedOdds {
  write(enc: Encoder, offset: number): void;
  read(dec: Decoder): number;
  learn(side: Encoder | Decoder, offset: number): void;
}

/**
 * A narrow range's learned odds: each offset from the range's min a member
 * of an adaptive prior over the range.
 */
class LearnedMembers implements LearnedOdds {
  constructor(private readonly prior: AdaptivePrior) {}

  write(enc: Encoder, offset: number): void {
    this.prior.write(enc, offset);
  }

  read(dec: Decoder): number {
    return this.prior.read(dec);
  }

  learn(side: Encoder | Decoder, offset: number): void {
    this.prior.learn(side, offset);
  }
}

/**
 * A wide or unbounded range's learned scale: each offset on the learned
 * magnitude scale from the range's origin, over the offsets `[low, high]`
 * the range reaches.
 */
class LearnedOffsets implements LearnedOdds {
  constructor(
    private readonly scale: Magnitude,
    private readonly low: number,
    private readonly high: number
  ) {}

  write(enc: Encoder, offset: number): void {
    this.scale.write(enc, offset, 0, this.low, this.high);
  }

  read(dec: Decoder): number {
    return this.scale.read(dec, 0, this.low, this.high);
  }

  learn(side: Encoder | Decoder, offset: number): void {
    this.scale.learn(side, offset, 0, this.low, this.high);
  }
}

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
 * Compress options turn the prior compressed: over a range of at most
 * `MAX_COMPRESS_MEMBERS` values or under declared weights, a compressed
 * prior over the range, the declared weights or even ones, with the values
 * a message codes learned on top; over a wider or unbounded range, the
 * learned magnitude scale from the range's origin. Coding learns nothing:
 * the range's owner teaches it each index through `learn`.
 */
/** What a compressed lattice node codes its indices through: the number predictor at `path`. */
export interface CompressIndex {
  readonly path: object;
  readonly options: Resolved;
}

export class IndexRange {
  readonly lo?: number;
  readonly hi?: number;
  /**
   * The prior as given, in every mode (static, cdf or compress), so a node
   * rebuilding the range after a bound change passes it on.
   */
  readonly declared?: Prior;
  readonly prior?: RangePrior;
  /**
   * What the prior learns under, set when it adapts; the weights then live
   * in `learned`, not `prior`.
   */
  readonly learning?: AdaptOptions;
  /** The one radix an index packs in: both bounds, no prior or compress options, fewer than 2^53 values. */
  readonly radix?: number;
  /** Set with `radix`: the index `digit` steps above min, as a digit read in `radix` stands for. */
  readonly fromDigit?: (digit: number) => number;
  /**
   * Set with `radix`: the digit `write` composes for `index`, throwing exactly
   * as `write` would.
   */
  readonly toDigit?: (index: number, subject?: () => string) => number;
  /**
   * The index offsets count from: the min, else the max, else 0. An offset
   * is a safe integer, so a range reaching past 2^53 - 1 from its origin
   * offsets only the indices within that reach.
   */
  readonly origin: number;
  /** The lowest offset the range reaches: 0 from a min, else the safe integers' end. */
  readonly low: number;
  /** The highest offset the range reaches: the span between both bounds, 0 from a lone max, else the safe integers' end. */
  readonly high: number;
  /** Set with `learning`: the learned odds of an index's offset, which `write` and `read` code through and `learn` teaches. */
  readonly learned?: LearnedOdds;
  /** Set under `.compress()`: the predictor `write` and `read` code through. */
  readonly compress?: CompressIndex;
  /** The range's own spelling, which the predictor falls back on. */
  readonly plain: PlainNumber;
  private readonly show: (index: number) => string;

  constructor(
    who: string,
    lo?: number,
    hi?: number,
    prior?: Prior,
    learning?: AdaptOptions,
    show: (index: number) => string = String,
    compress?: CompressIndex
  ) {
    checkRange(who, lo, hi, show);
    if (prior !== undefined && (lo === undefined || hi === undefined)) {
      throw new TypeError(`${who} ${priorKind(prior)} requires both bounds`);
    }
    this.origin = lo ?? hi ?? 0;
    this.low = lo === undefined ? -MAX_SAFE : 0;
    this.high = hi === undefined ? MAX_SAFE : hi - this.origin;
    if (learning !== undefined) {
      const { window } = checkAdaptation(learning, who);
      if (typeof prior === 'function') {
        throw new TypeError(`${who} adapt takes weights, not a cdf`);
      }
      if (
        lo !== undefined &&
        hi !== undefined &&
        (prior !== undefined || hi - lo < MAX_COMPRESS_MEMBERS)
      ) {
        const n = hi - lo + 1;
        checkCompressMembers(n, who);
        const weights = prior ?? new Array<number>(n).fill(1);
        this.learned = new LearnedMembers(
          new AdaptivePrior([weights], n, window, who, kinOf(learning))
        );
      } else {
        const scale = new LearnedMagnitude(lo === undefined, learning, who);
        this.learned = new LearnedOffsets(scale, this.low, this.high);
      }
      this.learning = learning;
    } else if (prior !== undefined) {
      this.prior = new RangePrior(prior, lo as number, hi as number, who, show);
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
      learning === undefined &&
      compress === undefined &&
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
    this.compress = compress;
    const ranged = this.prior;
    this.plain =
      ranged === undefined
        ? { write: (enc, x) => this.writeIndex(enc, x), read: (dec) => this.readIndex(dec) }
        : {
            write: (enc, x) => ranged.writeChecked(enc, x),
            read: (dec) => ranged.read(dec),
          };
  }

  /** Whether `index` lies a safe integer's offset from the origin, which adds back to it exactly. */
  reaches(index: number): boolean {
    const offset = index - this.origin;
    return Number.isSafeInteger(offset) && this.origin + offset === index;
  }

  /**
   * The offset of `index` from the origin, refusing an index outside the
   * bounds or out of the origin's exact reach; -0 offsets as 0. `subject`
   * names the value in an error, as `write` takes it.
   */
  offset(index: number, subject: () => string = () => `Value ${this.show(index)}`): number {
    checkIndex(index, this.lo, this.hi, subject, this.show);
    if (!this.reaches(index)) {
      throw new RangeError(
        `${subject()} is too far from ${this.show(this.origin)} to encode exactly`
      );
    }
    return index - this.origin + 0;
  }

  /** The index `offset` stands for, read off the wire: a CorruptInputError when it does not add back exactly. */
  fromOffset(offset: number): number {
    const index = this.origin + offset;
    if (index - this.origin !== offset) {
      throw new CorruptInputError('Index offset is outside the exact range of its origin');
    }
    return index;
  }

  /** `subject` names the value in an error, as in `Date 2020-01-01T00:00:00.000Z`. */
  write(
    enc: Encoder,
    index: number,
    subject: () => string = () => `Value ${this.show(index)}`
  ): void {
    if (this.compress !== undefined) {
      // Refused as the plain spelling would refuse it, before the predictor learns from it.
      if (this.prior !== undefined) {
        this.prior.check(index, subject);
      } else {
        checkIndex(index, this.lo, this.hi, subject, this.show);
        this.checkReach(index);
      }
      this.predictor(enc).write(enc, index);
      return;
    }
    if (this.prior !== undefined) {
      this.prior.write(enc, index, subject);
      return;
    }
    if (this.learned !== undefined) {
      this.learned.write(enc, this.offset(index, subject));
      return;
    }
    checkIndex(index, this.lo, this.hi, subject, this.show);
    this.writeIndex(enc, index);
  }

  read(dec: Decoder): number {
    if (this.compress !== undefined) {
      return this.predictor(dec).read(dec);
    }
    if (this.learned !== undefined) {
      return this.fromOffset(this.learned.read(dec));
    }
    return this.prior === undefined ? this.readIndex(dec) : this.prior.read(dec);
  }

  /** Writes `index`, refused as `write` refuses it, and teaches it to the learned odds. */
  writeValue(enc: Encoder, index: number, subject?: () => string): void {
    if (this.learned === undefined) {
      this.write(enc, index, subject);
      return;
    }
    const offset = this.offset(index, subject);
    this.write(enc, index, subject);
    this.learned.learn(enc, offset);
  }

  /** Reads an index `writeValue` wrote, teaching it to the learned odds. */
  readValue(dec: Decoder): number {
    const index = this.read(dec);
    // A learned index came through `fromOffset`, so it lies a safe offset from the origin.
    this.learned?.learn(dec, index - this.origin + 0);
    return index;
  }

  /** Learns `index`, just written or read, where the odds learn. */
  learn(side: Encoder | Decoder, index: number): void {
    this.learned?.learn(side, index - this.origin + 0);
  }

  /** The number predictor of the node, on the session of `side`. */
  private predictor(side: Encoder | Decoder) {
    const { path, options } = this.compress as CompressIndex;
    return session(side).number(
      path,
      options,
      { lo: this.lo, hi: this.hi, prior: this.prior },
      this.plain
    );
  }

  /**
   * Refuses an index a lone bound cannot reach exactly: float subtraction rounds once the offset
   * passes 2^53, which would silently encode a neighbouring value; the check IS the decode
   * expression.
   */
  private checkReach(index: number): void {
    const { lo, hi } = this;
    if (lo !== undefined && hi === undefined && lo + (index - lo) !== index) {
      throw new RangeError(
        `Value ${this.show(index)} is too far from its bound ${this.show(lo)} to encode exactly`
      );
    }
    if (hi !== undefined && lo === undefined && hi - (hi - index) !== index) {
      throw new RangeError(
        `Value ${this.show(index)} is too far from its bound ${this.show(hi)} to encode exactly`
      );
    }
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
      this.checkReach(index);
      enc.composeTerm(index - lo);
    } else if (hi !== undefined) {
      this.checkReach(index);
      enc.composeTerm(hi - index);
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
 * 0, learning under `learning`. `noun` names the quantity in an error, as
 * in `p.array weights requires a max count`.
 */
export function lengthRange(
  bounds: LengthBounds,
  who: string,
  noun: string,
  learning?: AdaptOptions
): IndexRange {
  const min = lengthBound(bounds.min, who, 'min');
  const max = lengthBound(bounds.max, who, 'max');
  const { prior } = bounds;

  if (prior !== undefined && max === undefined) {
    throw new TypeError(`${who} ${priorKind(prior)} requires a max ${noun}`);
  }
  return new IndexRange(who, min ?? 0, max, prior, learning);
}

/** Refuses a second `min`, `max`, prior or other one-off setting on one node: each is set once. */
export function checkUnset(current: unknown, who: string, bound: string): void {
  if (current !== undefined) {
    throw new TypeError(`${who} ${bound} is already set`);
  }
}
