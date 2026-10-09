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

export function validateCharset(charset?: Charset): Charset {
  if (charset == null) {
    return DEFAULT_CHARSET;
  } else if (typeof charset === 'string') {
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
