/**
 * Utility functions for packer
 */

import type { Base, Charset, OutputType, Radix } from './types';
import { DEFAULT_CHARSET } from './constants';

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * `value` as a radix: an integer in [1, 2^53), else a TypeError or a
 * RangeError that calls it `name`.
 */
export function radixOf(value: number, name: 'Radix' | 'Total'): Radix {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer, got ${value}`);
  }
  if (value < 1 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} ${value} is not a positive safe integer`);
  }
  return value as Radix;
}

/** Bit length of the magnitude of a BigInt: 0 for 0n, the same for x and -x. */
export function bitLength(x: bigint): number {
  const hex = (x < 0n ? -x : x).toString(16);
  return (hex.length - 1) * 4 + (32 - Math.clz32(parseInt(hex[0], 16)));
}

/**
 * The width of the low digits a radix past the safe integers splits into:
 * the width of [2^32, 2^53), the window its top digit's radix then lands in.
 */
export const BIG_CHUNK_BITS = 21;

/**
 * How a radix past the safe integers spreads over safe digits: `chunks` low
 * digits of 2^BIG_CHUNK_BITS states under a top digit of `top` states, the
 * fewest chunks that make `top` = ceil(radix / 2^(BIG_CHUNK_BITS · chunks))
 * a safe integer. One chunk fewer leaves a top of at least 2^53, so `top`
 * lies in [2^32, 2^53), and the states past `radix` waste under 2^-31 bits.
 * `radix` is a positive integer; a safe one takes no chunks.
 */
export function bigRadix(radix: bigint): { chunks: number; top: number } {
  // A top of at least 2^53 has at least 54 bits, so the fewest chunks are
  // this estimate or one more.
  let chunks = Math.max(0, Math.ceil((bitLength(radix) - 53) / BIG_CHUNK_BITS));
  for (;;) {
    const shift = BigInt(BIG_CHUNK_BITS * chunks);
    const top = (radix + (1n << shift) - 1n) >> shift;
    if (top <= MAX_SAFE_BIG) {
      return { chunks, top: Number(top) };
    }
    chunks++;
  }
}

/** The widest checksum: the hash behind it is 32 bits. */
const MAX_CHECKSUM_BITS = 32;

/** A message's checksum width in bits: 0 when there is none, else an integer in [1, 32]. */
export function validateChecksum(bits?: number): number {
  if (bits === undefined) {
    return 0;
  }
  if (!Number.isInteger(bits)) {
    throw new TypeError(`Checksum width must be an integer number of bits, got ${bits}`);
  }
  if (bits < 1 || bits > MAX_CHECKSUM_BITS) {
    throw new RangeError(`Checksum width ${bits} bits is outside [1, ${MAX_CHECKSUM_BITS}]`);
  }
  return bits;
}

/** The values a decode reads past its input when it sets no limit of its own. */
const DEFAULT_LIMIT = 2 ** 20;

/** A decode's limit on values read past its input: a non-negative integer, or `Infinity`. */
export function validateLimit(limit: number = DEFAULT_LIMIT): number {
  if (limit === Infinity) {
    return limit;
  }
  if (!Number.isInteger(limit)) {
    throw new TypeError(`Decode limit must be an integer or Infinity, got ${limit}`);
  }
  if (limit < 0) {
    throw new RangeError(`Decode limit ${limit} is negative`);
  }
  return limit;
}

/** One FNV-1a step over a 32-bit word. */
function mix(h: number, x: number): number {
  return Math.imul(h ^ x, 0x01000193);
}

/**
 * The `bits`-bit checksum of a message: the state its checksum folds onto
 * and the `rest` digits read after the checksum, through `digitAt`, with
 * their count. FNV-1a over 32-bit limbs ends in murmur3's finaliser, so
 * every input bit reaches every output bit, and the top `bits` bits are the
 * checksum. Everything is 32-bit integer arithmetic, which every engine
 * computes exactly.
 */
export function checksumOf(
  bits: number,
  value: bigint,
  rest: number,
  digitAt: (i: number) => number
): number {
  let h = mix(0x811c9dc5, rest);
  let v = value;
  let limbs = 0;
  while (v > 0n) {
    h = mix(h, Number(BigInt.asUintN(32, v)));
    v >>= 32n;
    limbs++;
  }
  h = mix(h, limbs);
  for (let i = 0; i < rest; i++) {
    h = mix(h, digitAt(i));
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) >>> (32 - bits);
}

const TWO_512 = 2 ** 512;
const TWO_MINUS_512 = 2 ** -512;

/**
 * A positive ratio as `mantissa · 2^exponent`, the mantissa in [1, 2^512)
 * and the exponent a multiple of 512, so each value has one representation
 * and ratios compare by exponent, then mantissa. It weighs one coding's
 * symbols against another's by their probability products rather than by
 * summed `Math.log2` costs: `log2` is not correctly rounded, so its sums can
 * differ between engines and a near-tie could pick different codings on
 * each. Multiplication, division and scaling by powers of two round the same
 * everywhere, so every engine picks the same coding.
 */
export class ScaledRatio {
  private mantissa = 1;
  private exponent = 0;

  /**
   * Scale by `num / den`, each a positive double below 2^106, as a product of
   * two safe integers.
   */
  multiply(num: number, den: number): void {
    // The step leaves the mantissa in [2^-106, 2^618), so one scaling by
    // 2^512 brings it back to [1, 2^512); scaling by a power of two is exact.
    const m = (this.mantissa * num) / den;
    if (m >= TWO_512) {
      this.mantissa = m * TWO_MINUS_512;
      this.exponent += 512;
    } else if (m < 1) {
      this.mantissa = m * TWO_512;
      this.exponent -= 512;
    } else {
      this.mantissa = m;
    }
  }

  /**
   * This ratio times `other`, as a new ratio. The mantissas multiply in one
   * correctly rounded operation, so every engine gets the same product:
   * both below 2^512, it is finite and below 2^1024, and one scaling by
   * 2^-512 brings it back to [1, 2^512).
   */
  times(other: ScaledRatio): ScaledRatio {
    return new ScaledRatio().product(this, other);
  }

  /** Sets this ratio to 1, and returns it. */
  reset(): ScaledRatio {
    this.mantissa = 1;
    this.exponent = 0;
    return this;
  }

  /** Sets this ratio to `a` times `b`, as `times` gives it, and returns it. */
  product(a: ScaledRatio, b: ScaledRatio): ScaledRatio {
    return this.set(a.mantissa * b.mantissa, a.exponent + b.exponent);
  }

  /** Sets this ratio to `a` over `b`, as `over` gives it, and returns it. */
  quotient(a: ScaledRatio, b: ScaledRatio): ScaledRatio {
    return this.set(a.mantissa / b.mantissa, a.exponent - b.exponent);
  }

  /**
   * This ratio over `other`, as a new ratio. The mantissas divide in one
   * correctly rounded operation: both in [1, 2^512), the quotient lies in
   * (2^-512, 2^512), and one scaling by 2^512 brings it back to [1, 2^512).
   */
  over(other: ScaledRatio): ScaledRatio {
    return new ScaledRatio().quotient(this, other);
  }

  /** Sets this ratio to `m · 2^exponent`, `m` in (2^-512, 2^1024), renormalised, and returns it. */
  private set(m: number, exponent: number): ScaledRatio {
    if (m >= TWO_512) {
      this.mantissa = m * TWO_MINUS_512;
      this.exponent = exponent + 512;
    } else if (m < 1) {
      this.mantissa = m * TWO_512;
      this.exponent = exponent - 512;
    } else {
      this.mantissa = m;
      this.exponent = exponent;
    }
    return this;
  }

  /** Whether this ratio is strictly larger than `other`. */
  exceeds(other: ScaledRatio): boolean {
    return this.exponent !== other.exponent
      ? this.exponent > other.exponent
      : this.mantissa > other.mantissa;
  }
}

/** The units costs are counted in, per bit: costs are whole numbers of units of 2^-20 bit, so sums are exact integers in any order. */
export const COST_UNITS = 2 ** 20;

/** `log2(i)` in `COST_UNITS`, rounded, for `i` in [1, 4096). */
const LOG_UNITS = new Int32Array(4096);
for (let i = 1; i < LOG_UNITS.length; i++) {
  LOG_UNITS[i] = Math.round(Math.log2(i) * COST_UNITS);
}

/**
 * `log2(n)` in `COST_UNITS` for a positive safe integer `n`. From 4096 up it
 * rounds the log2 of `n`'s top 12 bits and adds the bits below them, off by
 * under log2(1 + 2^-11) bits; past 2^32 it is `Math.log2` rounded.
 */
export function log2Units(n: number): number {
  if (n < 4096) {
    return LOG_UNITS[n];
  }
  if (n < 2 ** 32) {
    // `n` has 32 - clz bits, so the shift leaves its top 12, in [2048, 4096).
    const shift = 20 - Math.clz32(n);
    return LOG_UNITS[n >>> shift] + shift * COST_UNITS;
  }
  return Math.round(Math.log2(n) * COST_UNITS);
}

/** The cost, in `COST_UNITS`, of a symbol owning `freq` of `total` states. */
export function costUnits(freq: number, total: number): number {
  return log2Units(total) - log2Units(freq);
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

  constructor(charset: Charset, minSize: 1 | 2 = 2) {
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

  /**
   * The digit a code spells, or -1 when the charset has no such symbol,
   * including for a number that is no code at all.
   */
  digitOf(code: number): number {
    const table = this.table;
    if (table !== undefined) {
      // A typed array reads undefined at any index it lacks: past its end,
      // negative, fractional or NaN.
      return table[code] ?? -1;
    }
    const map = this.map;
    if (map !== undefined) {
      return map.get(code) ?? -1;
    }
    const digit = code - this.min;
    return digit >= 0 && digit < this.size && Number.isInteger(digit) ? digit : -1;
  }

  /**
   * The digits as bytes, each the code that spells it. A digit outside
   * [0, size) throws, and so does a charset with codes past a byte.
   */
  bytesOf(digits: readonly number[]): Uint8Array {
    if (this.top > 255) {
      throw new RangeError(`Code ${this.top} is not a byte`);
    }
    const size = this.size;
    const charset = this.charset;
    const bytes = new Uint8Array(digits.length);
    for (let i = 0; i < digits.length; i++) {
      const digit = digits[i];
      // An unsigned shift returns the digit itself only for an integer in [0, 2^32).
      if (digit >>> 0 !== digit || digit >= size) {
        this.rejectDigit(digit);
      }
      bytes[i] = typeof charset === 'string' ? charset.charCodeAt(digit) : this.min + digit;
    }
    return bytes;
  }

  /** The character spelling a digit in [0, size); any other digit throws. */
  charAt(digit: number): string {
    if (digit >>> 0 !== digit || digit >= this.size) {
      return this.rejectDigit(digit);
    }
    return typeof this.charset === 'string'
      ? this.charset.charAt(digit)
      : String.fromCharCode(this.min + digit);
  }

  /** The error for a digit that is not an integer in [0, size). */
  private rejectDigit(digit: number): never {
    if (!Number.isInteger(digit)) {
      throw new TypeError(`Digit must be an integer, got ${digit}`);
    }
    throw new RangeError(`Digit ${digit} is outside [0, ${this.size})`);
  }
}

/** An alphabet a whole message is spelled in: at least two symbols, so its size is a digit base. */
export type OutputAlphabet = Alphabet & { readonly size: Base };

/** Every byte value: binary output's symbols unless a message sets its own. */
const BYTES = new Alphabet([0, 255]) as OutputAlphabet;

/** Alphabets of the string charsets seen most recently, since building one walks every character. */
const alphabets = new Map<string, OutputAlphabet>();

/** The alphabet of a string charset of at least two characters, cached by the charset. */
export function stringAlphabet(charset: string): OutputAlphabet {
  let alphabet = alphabets.get(charset);
  if (alphabet === undefined) {
    alphabet = new Alphabet(charset) as OutputAlphabet;
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
 * never end. No charset holds more than 65536 distinct codes, so its size is
 * a `Base`. Binary output writes each symbol's code as a byte, so every code
 * must fit one.
 */
export function outputAlphabet(type: OutputType, charset?: Charset): OutputAlphabet {
  if (charset === undefined) {
    return type === 'binary' ? BYTES : stringAlphabet(DEFAULT_CHARSET);
  }
  const alphabet =
    typeof charset === 'string'
      ? stringAlphabet(charset)
      : (new Alphabet(charset) as OutputAlphabet);
  if (type === 'binary' && alphabet.top > 255) {
    throw new RangeError(
      typeof charset === 'string'
        ? `Character ${JSON.stringify(String.fromCharCode(alphabet.top))} (code ${alphabet.top}) is not a byte, so binary output cannot use it`
        : `Code ${alphabet.top} is not a byte, so binary output cannot use the range [${charset[0]}, ${charset[1]}]`
    );
  }
  return alphabet;
}
