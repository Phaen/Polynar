/**
 * Encoder class for Polynar
 */

import type { Charset, EncodingOptions, Encoder as IEncoder } from './types';
import { DEFAULT_BASE } from './constants';
import { validateOptions, validateCharset, isArray } from './utils';
import { modules } from './modules/registry';

/**
 * Encoder class
 */
export class Encoder implements IEncoder {
  radii: number[];
  integers: number[];

  constructor() {
    this.radii = [];
    this.integers = [];
  }

  write(items: any | any[], options: EncodingOptions): void {
    const validatedOptions = validateOptions(options);

    if (!isArray(items)) {
      items = [items];
    }

    if (typeof validatedOptions.preProc === 'function') {
      // Map into a fresh array so a caller-supplied `items` array is never
      // mutated in place by the hook.
      const preProc = validatedOptions.preProc;
      items = items.map((item: any) => preProc(item));
    }

    if (validatedOptions.limit) {
      if (items.length > validatedOptions.limit) {
        throw new RangeError('Item count exceeds limit');
      } else {
        this.compose(items.length, validatedOptions.limit + 1);
      }
    }

    modules[validatedOptions.type].encoder.call(this, items, validatedOptions);
  }

  compose(integer: number, radix: number): void {
    // An out-of-range value would not throw on its own; it would silently
    // corrupt every value packed after it. Fail here, at the source.
    if (!Number.isInteger(radix) || radix < 1) {
      throw new TypeError('Radix must be a positive integer');
    }

    if (!Number.isInteger(integer) || integer < 0 || integer >= radix) {
      throw new RangeError('Integer must be a non-negative integer below its radix');
    }

    this.integers.push(integer);
    this.radii.push(radix);
  }

  composeTerm(integer: number): void {
    if (!Number.isInteger(integer) || integer < 0) {
      // The digit loop below only terminates for non-negative integers.
      throw new TypeError('Term must be a non-negative integer');
    }

    while (integer !== 0) {
      this.compose((integer % DEFAULT_BASE) + 1, DEFAULT_BASE + 1);
      integer = Math.floor(integer / DEFAULT_BASE);
    }
    this.compose(0, DEFAULT_BASE + 1);
  }

  /**
   * Pack the whole buffer into a single big mixed-radix integer and write it
   * out as base-`size` digits, lowest digit first. Values are folded in
   * reverse so the decoder can peel them off front-to-back, which it needs
   * because later radices can depend on earlier decoded values (e.g. a
   * `limit` length prefix). Rounding up to a whole digit happens once, at the
   * end of the message, so the output length is always the minimum:
   * ceil(log_size(product of all radii)).
   */
  private toDigits(size: number): number[] {
    const base = BigInt(size);
    let value = 0n;
    let capacity = 1n;

    for (let i = this.radii.length - 1; i >= 0; i--) {
      const radix = BigInt(this.radii[i]);
      value = value * radix + BigInt(this.integers[i]);
      capacity *= radix;
    }

    const digits: number[] = [];
    while (capacity > 1n) {
      digits.push(Number(value % base));
      value /= base;
      capacity = (capacity + base - 1n) / base;
    }

    return digits;
  }

  toString(charset?: Charset): string {
    const validatedCharset = validateCharset(charset);

    const size =
      typeof validatedCharset === 'string'
        ? validatedCharset.length
        : (validatedCharset as [number, number])[1] - (validatedCharset as [number, number])[0] + 1;

    let str = '';

    for (const digit of this.toDigits(size)) {
      if (typeof validatedCharset === 'string') {
        str += validatedCharset.charAt(digit);
      } else {
        str += String.fromCharCode(digit + (validatedCharset as [number, number])[0]);
      }
    }

    return str;
  }

  toUint8Array(charset?: [number, number]): Uint8Array {
    if (charset != null && (!isArray(charset) || charset.length !== 2)) {
      throw new TypeError('Binary charset must be a [min, max] range');
    }

    const [min, max] = charset || [0, 255];

    // Validate range
    if (min < 0 || min > 255 || max < 0 || max > 255 || min >= max) {
      throw new RangeError('Binary range must be between 0-255 and min must be < max');
    }

    const digits = this.toDigits(max - min + 1);
    const bytes = new Uint8Array(digits.length);

    for (let i = 0; i < digits.length; i++) {
      bytes[i] = digits[i] + min;
    }

    return bytes;
  }
}
