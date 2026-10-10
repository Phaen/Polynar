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
        `Value '${show(index)}' is too far from its bound ${show(min)} to encode exactly`
      );
    }
    enc.composeTerm(offset);
  } else if (max !== undefined) {
    const offset = max - index;
    if (max - offset !== index) {
      throw new RangeError(
        `Value '${show(index)}' is too far from its bound ${show(max)} to encode exactly`
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

/** Wording for an index range's errors; each defaults to a plain-number form. */
export interface RangeText {
  /** An index as the value it stands for. */
  readonly show?: (index: number) => string;
  /** Follows the subject when an index lies below `lo`, as in `is below the minimum 3`. */
  readonly below?: string;
  readonly above?: string;
  readonly empty?: string;
  readonly span?: string;
}

/**
 * One bounded integer index on the lattice wire, optionally under a prior:
 * the half of PInt, PDecimal, PDate and every length prefix that is not
 * about mapping a value to its index. The range is validated once here, and
 * `write`/`read` check the bounds and pack the index, uniformly or weighted.
 */
export class IndexRange {
  readonly lo?: number;
  readonly hi?: number;
  readonly prior?: RangePrior;
  private readonly show: (index: number) => string;
  private readonly below: string;
  private readonly above: string;

  constructor(who: string, lo?: number, hi?: number, prior?: Prior, text: RangeText = {}) {
    const show = text.show ?? String;
    if (lo !== undefined && hi !== undefined) {
      if (lo > hi) {
        throw new RangeError(
          text.empty ?? `${who} range is empty: min ${show(lo)} exceeds max ${show(hi)}`
        );
      }
      // Index arithmetic (index - lo) is only exact while the span fits in
      // exact integer range; a wider band would round indices silently.
      if (hi - lo > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(
          text.span ??
            `${who} range [${show(lo)}, ${show(hi)}] is wider than exact integer arithmetic supports`
        );
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
    this.show = show;
    this.below = text.below ?? (lo === undefined ? '' : `is below the minimum ${show(lo)}`);
    this.above = text.above ?? (hi === undefined ? '' : `is above the maximum ${show(hi)}`);
  }

  /** `subject` names the value in an error, as in `Value '3'`. */
  write(enc: Encoder, index: number, subject: () => string): void {
    if (this.lo !== undefined && index < this.lo) {
      throw new RangeError(`${subject()} ${this.below}`);
    }
    if (this.hi !== undefined && index > this.hi) {
      throw new RangeError(`${subject()} ${this.above}`);
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
}

/** The declared bounds of a length or count; a fixed length is min === max. */
export interface LengthBounds {
  readonly min?: number;
  readonly max?: number;
  readonly prior?: Prior;
}

/**
 * The range of a string, byte-run or array length: each bound rounds inward
 * (ceil the min, floor the max) so a fractional bound never admits a length
 * beyond itself, and the floor defaults to 0. `noun` names the quantity in
 * an error, as in `p.array max must be a non-negative count`.
 */
export function lengthRange(bounds: LengthBounds, who: string, noun: string): IndexRange {
  const min = bounds.min == null ? undefined : Math.ceil(bounds.min);
  if (min !== undefined && (!Number.isInteger(min) || min < 0)) {
    throw new RangeError(`${who} min must be a non-negative ${noun}, got ${bounds.min}`);
  }
  const max = bounds.max == null ? undefined : Math.floor(bounds.max);
  if (max !== undefined && (!Number.isInteger(max) || max < 0)) {
    throw new RangeError(`${who} max must be a non-negative ${noun}, got ${bounds.max}`);
  }
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
