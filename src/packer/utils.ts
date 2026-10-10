/**
 * Utility functions for packer
 */

import type { ByteRange, Charset } from './types';
import { DEFAULT_BLOCK_BITS, DEFAULT_CHARSET } from './constants';

/**
 * The longest run of base-`size` digits whose values fit one safe integer
 * with room to spare: `digits` of them span `num` = size^digits ≤ 2^51
 * states, so a run folds in Number arithmetic and crosses into BigInt once
 * per chunk, not per digit, and a digit splits off by a float division whose
 * rounding a single correction step undoes exactly.
 */
export interface DigitChunk {
  readonly digits: number;
  readonly num: number;
  readonly big: bigint;
  /** log2 of `num` when the size is a power of two, so a chunk is a shift; else 0. */
  readonly bits: number;
}

export function digitChunk(size: number): DigitChunk {
  let digits = 1;
  let num = size;
  while (num * size <= 2 ** 51) {
    num *= size;
    digits++;
  }
  const exponent = log2Exact(size);
  return { digits, num, big: BigInt(num), bits: exponent < 0 ? 0 : exponent * digits };
}

/** The exponent of a positive integer that is a power of two, else -1. */
export function log2Exact(n: number): number {
  if (n < 2 ** 31) {
    return (n & (n - 1)) === 0 ? 31 - Math.clz32(n) : -1;
  }
  const exponent = Math.round(Math.log2(n));
  return 2 ** exponent === n ? exponent : -1;
}

/** Bit length of a positive BigInt. */
export function bitLength(x: bigint): number {
  const hex = x.toString(16);
  return (hex.length - 1) * 4 + (32 - Math.clz32(parseInt(hex[0], 16)));
}

/** Shift amounts as BigInts, so a power-of-two digit is a mask and a shift. */
export const SHIFTS = Array.from({ length: 54 }, (_, i) => BigInt(i));

/** A `[min, max]` byte range: integer endpoints within 0–255, min below max. */
export function validateByteRange([min, max]: ByteRange): ByteRange {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 255 || min >= max) {
    throw new RangeError(
      `Binary range [${min}, ${max}] must be integers within 0–255 with min below max`
    );
  }
  return [min, max];
}

/** The block sizes a message may choose; the ceiling keeps one block's BigInt arithmetic cheap. */
const MIN_BLOCK_BITS = 128;
const MAX_BLOCK_BITS = 65536;

/** A message's block size in bits: an integer within the allowed span. */
export function validateBlockBits(bits: number = DEFAULT_BLOCK_BITS): number {
  if (!Number.isInteger(bits)) {
    throw new TypeError(`Block size must be an integer number of bits, got ${bits}`);
  }
  if (bits < MIN_BLOCK_BITS || bits > MAX_BLOCK_BITS) {
    throw new RangeError(
      `Block size ${bits} bits is outside [${MIN_BLOCK_BITS}, ${MAX_BLOCK_BITS}]`
    );
  }
  return bits;
}

/**
 * The digits of a validated charset, each spelled by one UTF-16 code unit. A
 * string charset finds a code unit's digit in a table indexed by code unit, a
 * range by its offset from the first code. `minSize` is the fewest symbols
 * the charset must hold.
 */
export class Alphabet {
  /** The charset; a range is a fresh copy, never the caller's array. */
  readonly charset: Charset;
  readonly size: number;
  /** Digit by code unit for a string charset, -1 where it has no such character. */
  private readonly table?: Int32Array;
  /** The first code of a range charset. */
  private readonly min: number;

  constructor(charset: Charset = DEFAULT_CHARSET, minSize = 2) {
    if (typeof charset === 'string') {
      if (charset.length < minSize) {
        throw new TypeError(
          `Invalid character set: needs at least ${minSize} character${minSize === 1 ? '' : 's'}, got ${charset.length}`
        );
      }
      let top = 0;
      for (let i = 0; i < charset.length; i++) {
        top = Math.max(top, charset.charCodeAt(i));
      }
      const table = new Int32Array(top + 1).fill(-1);
      for (let i = 0; i < charset.length; i++) {
        const code = charset.charCodeAt(i);
        if (table[code] !== -1) {
          throw new TypeError(
            `Invalid character set: '${charset.charAt(i)}' appears more than once`
          );
        }
        table[code] = i;
      }
      this.charset = charset;
      this.size = charset.length;
      this.table = table;
      this.min = 0;
      return;
    }

    const [min, max] = charset;
    // String.fromCharCode truncates its argument modulo 2^16, so a range
    // outside the UTF-16 code-unit space (or a fractional endpoint) would
    // round-trip through different characters and corrupt silently.
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 65535) {
      throw new RangeError(
        `Invalid character range: [${min}, ${max}] must be integer codes within 0–65535`
      );
    }
    if (max - min + 1 < minSize) {
      throw new RangeError(
        `Invalid character range: [${min}, ${max}] holds fewer than ${minSize} code${minSize === 1 ? '' : 's'}`
      );
    }
    this.charset = [min, max];
    this.size = max - min + 1;
    this.min = min;
  }

  /** The digit a code unit spells, or -1 when the charset has no such character. */
  digitOf(code: number): number {
    const table = this.table;
    if (table !== undefined) {
      return code < table.length ? table[code] : -1;
    }
    const digit = code - this.min;
    return digit >= 0 && digit < this.size ? digit : -1;
  }

  /** The character spelling a digit below `size`. */
  charAt(digit: number): string {
    return typeof this.charset === 'string'
      ? this.charset.charAt(digit)
      : String.fromCharCode(this.min + digit);
  }
}

/** Alphabets of the string charsets seen most recently, since building one walks every character. */
const alphabets = new Map<string, Alphabet>();

/**
 * The alphabet of a transport charset, which needs at least two symbols: a
 * base-1 digit carries nothing, so the digit loops would never end.
 */
export function transportAlphabet(charset: Charset = DEFAULT_CHARSET): Alphabet {
  if (typeof charset !== 'string') {
    return new Alphabet(charset);
  }
  let alphabet = alphabets.get(charset);
  if (alphabet === undefined) {
    alphabet = new Alphabet(charset);
    if (alphabets.size >= 256) {
      alphabets.clear();
    }
    alphabets.set(charset, alphabet);
  }
  return alphabet;
}
