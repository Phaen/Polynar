/**
 * Utility functions for packer
 */

import type { ByteRange, Charset } from './types';
import { BLOCK_BITS, DEFAULT_CHARSET } from './constants';

/**
 * The largest digit count (and its state space, size^digits) a block of
 * base-`size` digits can span within 2^BLOCK_BITS. Encoder and decoder both
 * derive block boundaries from this, so it is computed in integer arithmetic —
 * a float log could round differently across engines and desync the two.
 */
const blockCapacityCache = new Map<number, { digits: number; cap: bigint }>();

export function blockCapacity(size: number): { digits: number; cap: bigint } {
  let entry = blockCapacityCache.get(size);

  if (entry == null) {
    const base = BigInt(size);
    const limit = 1n << BigInt(BLOCK_BITS);
    let digits = 1;
    let cap = base;

    while (cap * base <= limit) {
      cap *= base;
      digits++;
    }

    entry = { digits, cap };
    blockCapacityCache.set(size, entry);
  }

  return entry;
}

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

const digitChunkCache = new Map<number, DigitChunk>();

export function digitChunk(size: number): DigitChunk {
  let entry = digitChunkCache.get(size);

  if (entry == null) {
    let digits = 1;
    let num = size;
    while (num * size <= 2 ** 51) {
      num *= size;
      digits++;
    }
    const exponent = log2Exact(size);
    entry = { digits, num, big: BigInt(num), bits: exponent < 0 ? 0 : exponent * digits };
    digitChunkCache.set(size, entry);
  }

  return entry;
}

/** The exponent of a positive integer that is a power of two, else -1. */
export function log2Exact(n: number): number {
  if (n < 2 ** 31) {
    return (n & (n - 1)) === 0 ? 31 - Math.clz32(n) : -1;
  }
  const exponent = Math.round(Math.log2(n));
  return 2 ** exponent === n ? exponent : -1;
}

/** Shift amounts as BigInts, so a power-of-two digit is a mask and a shift. */
export const SHIFTS = Array.from({ length: 54 }, (_, i) => BigInt(i));

/**
 * Digit value by ASCII code unit for a string charset, -1 where the charset
 * has no such character; code units beyond ASCII fall back to `indexOf`.
 */
const charsetLookupCache = new Map<string, Int32Array>();

export function charsetLookup(charset: string): Int32Array {
  let table = charsetLookupCache.get(charset);

  if (table == null) {
    table = new Int32Array(128).fill(-1);
    for (let i = 0; i < charset.length; i++) {
      const code = charset.charCodeAt(i);
      if (code < 128) {
        table[code] = i;
      }
    }
    if (charsetLookupCache.size >= 256) {
      charsetLookupCache.clear();
    }
    charsetLookupCache.set(charset, table);
  }

  return table;
}

/**
 * Validate character set
 */
/** A `[min, max]` byte range: integer endpoints within 0–255, min below max. */
export function validateByteRange([min, max]: ByteRange): ByteRange {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 255 || min >= max) {
    throw new RangeError(
      `Binary range [${min}, ${max}] must be integers within 0–255 with min below max`
    );
  }
  return [min, max];
}

/** String charsets that passed validation, since the duplicate scan is quadratic. */
const validCharsets = new Set<string>();

export function validateCharset(charset?: Charset): Charset {
  if (charset == null) {
    return DEFAULT_CHARSET;
  } else if (typeof charset === 'string') {
    if (validCharsets.has(charset)) {
      return charset;
    }
    // A 1-character charset is base 1, whose digit loop never terminates. The
    // `s` flag makes `.` match line terminators, so a duplicate on either side
    // of a newline is still caught.
    if (charset.length < 2) {
      throw new TypeError(
        `Invalid character set: needs at least 2 characters, got ${charset.length}`
      );
    }
    const repeat = /(.).*\1/s.exec(charset);
    if (repeat) {
      throw new TypeError(`Invalid character set: '${repeat[1]}' appears more than once`);
    }
    if (validCharsets.size >= 256) {
      validCharsets.clear();
    }
    validCharsets.add(charset);
    return charset;
  } else {
    // A fresh array is built so the caller's is never mutated.
    let [min, max] = charset;
    if (min > max) {
      [min, max] = [max, min];
    }

    // String.fromCharCode truncates its argument modulo 2^16, so a range
    // outside the UTF-16 code-unit space (or a fractional endpoint) would
    // round-trip through different characters and corrupt silently.
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 65535) {
      throw new RangeError(
        `Invalid character range: [${min}, ${max}] must be integer codes within 0–65535`
      );
    }

    // Two symbols (base 2) is the floor, same as string charsets and binary
    // mode; a single symbol would be base 1, which carries no digit variation.
    if (max - min < 1) {
      throw new RangeError(`Invalid character range: [${min}, ${max}] holds fewer than 2 codes`);
    }

    return [min, max];
  }
}

/** The number of digit symbols a validated charset holds. */
export function charsetSize(charset: Charset): number {
  return typeof charset === 'string' ? charset.length : charset[1] - charset[0] + 1;
}
