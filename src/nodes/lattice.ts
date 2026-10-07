import { Encoder, Decoder, CorruptInputError } from '../packer';

/**
 * The shared integer-lattice wire: one index against optional [min, max]
 * bounds. Both bounds -> one slot of exact radix; one bound -> a term counting
 * away from it (downward from a max, so the term stays non-negative);
 * unbounded -> sign before magnitude, the order every signed value on the
 * wire reads. PInt, PDecimal and PDate all pack through here, so their
 * layouts can never drift apart.
 */
export function writeIndex(enc: Encoder, index: number, min?: number, max?: number): void {
  if (min !== undefined && max !== undefined) {
    enc.compose(index - min, max - min + 1);
  } else if (min !== undefined) {
    const offset = index - min;
    // Float subtraction rounds once the offset passes 2^53, which would
    // silently encode a neighbouring value. Refuse anything that cannot
    // reconstruct exactly — the check IS the decode expression.
    if (min + offset !== index) {
      throw new RangeError(`Value '${index}' is too far from its bound to encode exactly`);
    }
    enc.composeTerm(offset);
  } else if (max !== undefined) {
    const offset = max - index;
    if (max - offset !== index) {
      throw new RangeError(`Value '${index}' is too far from its bound to encode exactly`);
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
    // Mirror of the encode-side exactness guard: an offset whose sum rounds
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

export interface LengthBounds {
  readonly min?: number;
  readonly max?: number;
  readonly length?: number;
}

/**
 * The length prefix of a string or byte run: validated bounds, then one
 * lattice index over `[length ?? min ?? 0, length ?? max]`. A fixed length
 * IS both bounds, so it costs zero bits.
 */
export class LengthPrefix {
  readonly bounds: LengthBounds;
  private readonly lo: number;
  private readonly hi?: number;

  constructor(bounds: LengthBounds, who: string) {
    const { length } = bounds;
    // Combining the two spellings of a fixed length is a contradiction, so
    // it throws instead of silently merging.
    if (length != null && (bounds.min != null || bounds.max != null)) {
      throw new TypeError(`${who} length cannot be combined with min or max`);
    }
    // No inward rounding for a fixed length: no length satisfies a
    // fractional one, so either rounding direction would invent a contract.
    if (length != null && (!Number.isInteger(length) || length < 0)) {
      throw new RangeError(`${who} length must be a non-negative integer`);
    }
    // Round each bound INWARD (ceil the min, floor the max) so a fractional
    // bound never admits a length beyond itself.
    const min = bounds.min == null ? undefined : Math.ceil(bounds.min);
    if (min !== undefined && (!Number.isInteger(min) || min < 0)) {
      throw new RangeError(`${who} min must be a non-negative length`);
    }
    const max = bounds.max == null ? undefined : Math.floor(bounds.max);
    if (max !== undefined && (!Number.isInteger(max) || max < 0)) {
      throw new RangeError(`${who} max must be a non-negative length`);
    }
    if (min !== undefined && max !== undefined && min > max) {
      throw new RangeError(`${who} range is empty: min exceeds max`);
    }
    this.bounds = { min, max, length: length ?? undefined };
    this.lo = length ?? min ?? 0;
    this.hi = length ?? max;
  }

  /** `describe` names the value in an error, built only when one throws. */
  write(enc: Encoder, length: number, describe: () => string): void {
    const { min, max } = this.bounds;
    if (this.bounds.length !== undefined && length !== this.bounds.length) {
      throw new RangeError(`${describe()} differs from the fixed length`);
    }
    if (min !== undefined && length < min) {
      throw new RangeError(`${describe()} is below min length`);
    }
    if (max !== undefined && length > max) {
      throw new RangeError(`${describe()} exceeds max length`);
    }
    writeIndex(enc, length, this.lo, this.hi);
  }

  read(dec: Decoder): number {
    return readIndex(dec, this.lo, this.hi);
  }
}
