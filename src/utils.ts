/**
 * Utility functions for Polynar
 */

import type { Charset, EncodingOptions } from './types';
import { BLOCK_BITS, DEFAULT_CHARSET } from './constants';
import { modules } from './modules/registry';

/**
 * Type checking utilities
 */
export const isObject = (o: any): o is object => o && typeof o === 'object';
export const isArray = (o: any): o is any[] => Array.isArray(o);
export const isDate = (o: any): o is Date => o instanceof Date;

/**
 * Math utilities
 */
export const multiply = (a: number, b: number): number => a * b;

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
 * Validate encoding options
 */
export function validateOptions(optionsObj: EncodingOptions): EncodingOptions {
  if (!isObject(optionsObj)) {
    throw new TypeError(`${optionsObj} is not an object`);
  }

  if (modules[optionsObj.type] == null) {
    throw new TypeError('Invalid encoding type');
  }

  // Shallow copy the options
  const options: any = {};
  for (const i in optionsObj) {
    if (Object.prototype.hasOwnProperty.call(optionsObj, i)) {
      options[i] = (optionsObj as any)[i];
    }
  }

  const validator = modules[options.type].validator;
  if (validator) {
    validator(options);
  }

  if (options.limit != null) {
    if (typeof options.limit !== 'number' || options.limit % 1 !== 0 || options.limit < 0) {
      throw new TypeError('Invalid item limit');
    }
  }

  return options;
}

/**
 * Validate character set
 */
export function validateCharset(charset?: Charset): Charset {
  const errChar = 'Invalid character set';
  const errBin = 'Invalid binary range';

  if (charset == null) {
    return DEFAULT_CHARSET;
  } else if (typeof charset === 'number') {
    if (charset % 1 !== 0 || charset < 2 || charset > 65535) {
      throw new TypeError(errBin);
    }
    return [0, charset];
  } else if (typeof charset === 'string') {
    // A 1-character charset is base 1, whose digit loop never terminates. The
    // `s` flag makes `.` match line terminators, so a duplicate on either side
    // of a newline is still caught.
    if (charset.length < 2 || charset.match(/(.).*\1/s)) {
      throw new Error(errChar);
    }
    return charset;
  } else if (isArray(charset)) {
    if (charset.length !== 2) {
      throw new TypeError(errBin);
    }

    // Normalize into a fresh array so the caller's is never mutated.
    let [min, max] = charset;
    if (min > max) {
      [min, max] = [max, min];
    }

    // String.fromCharCode truncates its argument modulo 2^16, so a range
    // outside the UTF-16 code-unit space (or a fractional endpoint) would
    // round-trip through different characters and corrupt silently.
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 65535) {
      throw new RangeError(errBin);
    }

    if (max - min < 2) {
      throw new Error(errBin);
    }

    return [min, max];
  } else {
    throw new TypeError(errChar);
  }
}
