/**
 * Utility functions for packer
 */

import type { Charset, OutputType } from './types';
import { DEFAULT_BLOCK_BITS, DEFAULT_CHARSET } from './constants';

/**
 * The longest run of base-`size` digits whose values stay below 2^53:
 * `digits` of them span `num` = size^digits ≤ 2^53 states, so a run folds in
 * Number arithmetic and crosses into BigInt once per chunk, not per digit.
 * A digit splits off by a float division: for a < 2^53 the float quotient
 * fl(a/b) lies in [q, q+1) around the integer quotient q, so its floor is q.
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
  while (num * size <= 2 ** 53) {
    num *= size;
    digits++;
  }
  const exponent = log2Exact(size);
  return { digits, num, big: BigInt(num), bits: exponent < 0 ? 0 : exponent * digits };
}

/**
 * The exponent of a positive integer that is a power of two, else -1. Below
 * 2^31 a bit test answers, several times faster than a logarithm on the
 * decoder's per-symbol path; above, the rounded logarithm is checked against
 * the power it names.
 */
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

/**
 * The block sizes a message may choose. A block's cap exceeds
 * 2^blockBits / base, so with bases up to 2^16 the floor keeps it above
 * 2^112, and any first symbol, with fewer than 2^53 states, fits a fresh
 * block. The ceiling keeps one block's BigInt arithmetic cheap.
 */
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

/** The highest code a string charset may reach and still find its digits in a dense table. */
const DENSE_TOP = 4096;

/**
 * The digits of a validated charset, each spelled by one code: a UTF-16 code
 * unit in text, a byte value in binary. A string charset finds a code's digit
 * in a table indexed by code when its codes are small and in a map otherwise,
 * a range by its offset from the first code. `minSize` is the fewest symbols
 * the charset must hold. Halves of surrogate pairs are not symbols, so a
 * charset holds characters of the Basic Multilingual Plane only.
 */
export class Alphabet {
  /** The charset; a range is a fresh copy, never the caller's array. */
  readonly charset: Charset;
  readonly size: number;
  /** The highest code the charset spells. */
  readonly top: number;
  /** Digit by code for a string charset with small codes, -1 where it has no such character. */
  private readonly table?: Int32Array;
  /** Digit by code for a string charset with large codes. */
  private readonly map?: Map<number, number>;
  /** The first code of a range charset. */
  private readonly min: number;

  constructor(charset: Charset, minSize = 2) {
    if (typeof charset === 'string') {
      if (charset.length < minSize) {
        throw new TypeError(
          `Invalid character set: needs at least ${minSize} character${minSize === 1 ? '' : 's'}, got ${charset.length}`
        );
      }
      const digits = new Map<number, number>();
      let top = 0;
      for (let i = 0; i < charset.length; i++) {
        const code = charset.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdfff) {
          throw new RangeError(
            `Invalid character set: code ${code} at ${i} is half of a surrogate pair`
          );
        }
        if (digits.has(code)) {
          throw new TypeError(
            `Invalid character set: ${JSON.stringify(charset.charAt(i))} appears more than once`
          );
        }
        digits.set(code, i);
        top = Math.max(top, code);
      }
      if (top <= DENSE_TOP) {
        const table = new Int32Array(top + 1).fill(-1);
        for (const [code, digit] of digits) {
          table[code] = digit;
        }
        this.table = table;
      } else {
        this.map = digits;
      }
      this.charset = charset;
      this.size = charset.length;
      this.top = top;
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
    if (min <= 0xdfff && max >= 0xd800) {
      throw new RangeError(
        `Invalid character range: [${min}, ${max}] includes codes 55296–57343, the halves of surrogate pairs`
      );
    }
    const size = max - min + 1;
    if (size < minSize) {
      throw new RangeError(
        size < 1
          ? `Invalid character range: [${min}, ${max}] is empty`
          : `Invalid character range: [${min}, ${max}] holds only one code`
      );
    }
    this.charset = [min, max];
    this.size = size;
    this.top = max;
    this.min = min;
  }

  /** The digit a code spells, or -1 when the charset has no such symbol. */
  digitOf(code: number): number {
    const table = this.table;
    if (table !== undefined) {
      return code < table.length ? table[code] : -1;
    }
    const map = this.map;
    if (map !== undefined) {
      return map.get(code) ?? -1;
    }
    const digit = code - this.min;
    return digit >= 0 && digit < this.size ? digit : -1;
  }

  /** The code spelling a digit below `size`. */
  codeAt(digit: number): number {
    return typeof this.charset === 'string' ? this.charset.charCodeAt(digit) : this.min + digit;
  }

  /** The character spelling a digit below `size`. */
  charAt(digit: number): string {
    return typeof this.charset === 'string'
      ? this.charset.charAt(digit)
      : String.fromCharCode(this.min + digit);
  }
}

/** Every byte value: binary output's symbols unless a message sets its own. */
const BYTES = new Alphabet([0, 255]);

/** Alphabets of the string charsets seen most recently, since building one walks every character. */
const alphabets = new Map<string, Alphabet>();

function stringAlphabet(charset: string): Alphabet {
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

/**
 * The alphabet a message of the given type is spelled in, which needs at
 * least two symbols: a base-1 digit carries nothing, so the digit loops would
 * never end. Binary output writes each symbol's code as a byte, so every code
 * must fit one.
 */
export function outputAlphabet(type: OutputType, charset?: Charset): Alphabet {
  if (charset === undefined) {
    return type === 'binary' ? BYTES : stringAlphabet(DEFAULT_CHARSET);
  }
  const alphabet = typeof charset === 'string' ? stringAlphabet(charset) : new Alphabet(charset);
  if (type === 'binary' && alphabet.top > 255) {
    throw new RangeError(
      typeof charset === 'string'
        ? `Character ${JSON.stringify(String.fromCharCode(alphabet.top))} (code ${alphabet.top}) is not a byte, so binary output cannot use it`
        : `Code ${alphabet.top} is not a byte, so binary output cannot use the range [${charset[0]}, ${charset[1]}]`
    );
  }
  return alphabet;
}
