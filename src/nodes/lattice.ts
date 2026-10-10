import { Encoder, Decoder, CorruptInputError } from '../packer';
import { RangePrior, priorKind, type Prior } from './weights';

/**
 * The shared integer-lattice wire: one index against optional [min, max]
 * bounds. Both bounds -> one slot of exact radix; one bound -> a term counting
 * away from it (downward from a max, so the term stays non-negative);
 * unbounded -> sign before magnitude, the order every signed value on the
 * wire reads. Every bounded integer (int, decimal, date, and lengths and
 * counts) packs through here, so their layouts can never drift apart.
 */
export function writeIndex(
  enc: Encoder,
  index: number,
  min?: number,
  max?: number,
  show: (index: number) => string = String
): void {
  if (min !== undefined && max !== undefined) {
    enc.compose(index - min, max - min + 1);
  } else if (min !== undefined) {
    const offset = index - min;
    // Float subtraction rounds once the offset passes 2^53, which would
    // silently encode a neighbouring value, so anything that cannot
    // reconstruct exactly is refused; the check IS the decode expression.
    if (min + offset !== index) {
      throw new RangeError(
        `Value ${show(index)} is too far from its bound ${show(min)} to encode exactly`
      );
    }
    enc.composeTerm(offset);
  } else if (max !== undefined) {
    const offset = max - index;
    if (max - offset !== index) {
      throw new RangeError(
        `Value ${show(index)} is too far from its bound ${show(max)} to encode exactly`
      );
    }
    enc.composeTerm(offset);
  } else {
    enc.compose(index < 0 ? 1 : 0, 2);
    enc.composeTerm(Math.abs(index));
  }
}

export function readIndex(dec: Decoder, min?: number, max?: number): number {
  if (min !== undefined && max !== undefined) {
    return min + dec.parse(max - min + 1);
  }
  if (min !== undefined) {
    const offset = dec.parseTerm();
    const index = min + offset;
    // Counterpart of the encode-side exactness guard: an offset whose sum rounds
    // could never have been emitted.
    if (index - min !== offset) {
      throw new CorruptInputError('Term offset is outside the exact range of its bound');
    }
    return index;
  }
  if (max !== undefined) {
    const offset = dec.parseTerm();
    const index = max - offset;
    if (max - index !== offset) {
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

/**
 * One bounded integer index on the lattice wire, optionally under a prior:
 * the half of PInt, PDecimal, PDate and every length prefix that is not
 * about mapping a value to its index. The range is validated once here, and
 * `write`/`read` check the bounds and pack the index, uniformly or weighted.
 * `show` spells an index as the value it stands for in an error.
 */
export class IndexRange {
  readonly lo?: number;
  readonly hi?: number;
  readonly prior?: RangePrior;
  /** The one radix an index packs in: both bounds and no prior. */
  readonly radix?: number;
  private readonly show: (index: number) => string;

  constructor(
    who: string,
    lo?: number,
    hi?: number,
    prior?: Prior,
    show: (index: number) => string = String
  ) {
    if (lo !== undefined && hi !== undefined) {
      if (lo > hi) {
        throw new RangeError(`${who} range is empty: min ${show(lo)} exceeds max ${show(hi)}`);
      }
      // Index arithmetic (index - lo) is only exact while the span fits in
      // exact integer range; a wider band would round indices silently.
      if (hi - lo > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(`${who} range [${show(lo)}, ${show(hi)}] spans more than 2^53 values`);
      }
    }
    if (prior !== undefined) {
      if (lo === undefined || hi === undefined) {
        throw new TypeError(`${who} ${priorKind(prior)} requires both bounds`);
      }
      this.prior = new RangePrior(prior, lo, hi, who);
    }
    this.lo = lo;
    this.hi = hi;
    if (lo !== undefined && hi !== undefined && prior === undefined) {
      this.radix = hi - lo + 1;
    }
    this.show = show;
  }

  /** `subject` names the value in an error, as in `Value 3`. */
  write(enc: Encoder, index: number, subject: () => string): void {
    if (this.lo !== undefined && index < this.lo) {
      throw new RangeError(`${subject()} is below the minimum ${this.show(this.lo)}`);
    }
    if (this.hi !== undefined && index > this.hi) {
      throw new RangeError(`${subject()} is above the maximum ${this.show(this.hi)}`);
    }
    if (this.prior === undefined) {
      writeIndex(enc, index, this.lo, this.hi, this.show);
    } else {
      this.prior.write(enc, index, subject);
    }
  }

  read(dec: Decoder): number {
    return this.prior === undefined ? readIndex(dec, this.lo, this.hi) : this.prior.read(dec);
  }

  /** The index a digit read in `radix` stands for; `radix` is set only with both bounds. */
  fromDigit(digit: number): number {
    return (this.lo as number) + digit;
  }
}

/** The declared bounds of a length or count; a fixed length is min === max. */
export interface LengthBounds {
  readonly min?: number;
  readonly max?: number;
  readonly prior?: Prior;
}

/** A length or count bound: a non-negative integer, checked at definition. */
const lengthBound = (n: number | undefined, who: string, which: string): number | undefined => {
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
  if (current != null) {
    throw new TypeError(`${who} ${bound} is already set`);
  }
}
