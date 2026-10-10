import { Encoder, Decoder, CorruptInputError } from '../packer';
import { RangePrior, checkIndex, checkRange, priorKind, type Prior } from './weights';

/**
 * One integer index on the shared lattice wire, against optional [min, max]
 * bounds and optionally under a prior: the half of PInt, PDecimal, PDate,
 * p.versioned and every length prefix that is not about mapping a value to
 * its index. Both bounds -> one slot of exact radix; one bound -> a term
 * counting away from it (downward from a max, so the term stays
 * non-negative); unbounded -> sign before magnitude, the order every signed
 * value on the wire reads. Every bounded integer packs through here, so their
 * layouts can never drift apart. The range is validated once here, and
 * `write`/`read` check the bounds and pack the index, uniformly or weighted.
 * `show` spells an index as the value it stands for in an error.
 */
export class IndexRange {
  readonly lo?: number;
  readonly hi?: number;
  readonly prior?: RangePrior;
  /** The one radix an index packs in: both bounds and no prior. */
  readonly radix?: number;
  /** Set with `radix`: the index `digit` steps above min, as a digit read in `radix` stands for. */
  readonly fromDigit?: (digit: number) => number;
  private readonly show: (index: number) => string;

  constructor(
    who: string,
    lo?: number,
    hi?: number,
    prior?: Prior,
    show: (index: number) => string = String
  ) {
    checkRange(who, lo, hi, show);
    if (prior !== undefined) {
      if (lo === undefined || hi === undefined) {
        throw new TypeError(`${who} ${priorKind(prior)} requires both bounds`);
      }
      this.prior = new RangePrior(prior, lo, hi, who, show);
    }
    this.lo = lo;
    // A max of -0 reads back as max - 0, itself -0; stored as 0, no index
    // decodes as -0.
    this.hi = hi === undefined ? undefined : hi + 0;
    if (lo !== undefined && hi !== undefined && prior === undefined) {
      this.radix = hi - lo + 1;
      this.fromDigit = (digit) => lo + digit;
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
    this.writeIndex(enc, index);
  }

  read(dec: Decoder): number {
    return this.prior === undefined ? this.readIndex(dec) : this.prior.read(dec);
  }

  /** Packs `index`, an integer within the bounds as `write` checked. */
  private writeIndex(enc: Encoder, index: number): void {
    const { lo, hi } = this;
    if (lo !== undefined && hi !== undefined) {
      enc.compose(index - lo, hi - lo + 1);
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
      return lo + dec.parse(hi - lo + 1);
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
    // The encoder never signs a zero, so a signed zero is a corrupted input,
    // not a value.
    if (negative && magnitude === 0) {
      throw new CorruptInputError('Non-canonical negative zero in input');
    }
    return negative ? -magnitude : magnitude;
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
 * 0. `noun` names the quantity in an error, as in `p.array weights requires
 * a max count`.
 */
export function lengthRange(bounds: LengthBounds, who: string, noun: string): IndexRange {
  const min = lengthBound(bounds.min, who, 'min');
  const max = lengthBound(bounds.max, who, 'max');
  const { prior } = bounds;
  if (prior !== undefined && max === undefined) {
    throw new TypeError(`${who} ${priorKind(prior)} requires a max ${noun}`);
  }
  return new IndexRange(who, min ?? 0, max, prior);
}

/** Refuses a second `min` or `max` on one node: a bound is set once. */
export function checkUnset(current: unknown, who: string, bound: 'min' | 'max'): void {
  if (current !== undefined) {
    throw new TypeError(`${who} ${bound} is already set`);
  }
}
