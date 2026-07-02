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
    this.integers.push(integer);
    this.radii.push(radix);
  }

  composeTerm(integer: number): void {
    while (integer !== 0) {
      this.compose((integer % DEFAULT_BASE) + 1, DEFAULT_BASE + 1);
      integer = Math.floor(integer / DEFAULT_BASE);
    }
    this.compose(0, DEFAULT_BASE + 1);
  }

  toString(charset?: Charset): string {
    const validatedCharset = validateCharset(charset);

    const size =
      typeof validatedCharset === 'string'
        ? validatedCharset.length
        : (validatedCharset as [number, number])[1] - (validatedCharset as [number, number])[0] + 1;

    let radii = 1;
    let current = 0;
    let str = '';

    const build = (integer: number, radix: number): void => {
      let left = Math.floor(size / radii);

      if (left < 2) {
        if (typeof validatedCharset === 'string') {
          str += validatedCharset.charAt(current);
        } else {
          str += String.fromCharCode(current + (validatedCharset as [number, number])[0]);
        }

        current = 0;
        radii = 1;
        left = size;
      }

      if (left >= radix) {
        current += radii * integer;
        radii *= radix;
      } else {
        const factor = Math.ceil(radix / left);
        current += radii * Math.floor(integer / factor);
        radii *= left;
        build(integer % factor, factor);
      }
    };

    for (const i in this.radii) {
      build(this.integers[i], this.radii[i]);
    }

    if (radii !== 0) {
      if (typeof validatedCharset === 'string') {
        str += validatedCharset.charAt(current);
      } else {
        str += String.fromCharCode(current + (validatedCharset as [number, number])[0]);
      }
    }

    return str;
  }

  toUint8Array(charset?: [number, number]): Uint8Array {
    const [min, max] = charset || [0, 255];

    // Validate range
    if (min < 0 || min > 255 || max < 0 || max > 255 || min > max) {
      throw new RangeError('Binary range must be between 0-255 and min must be <= max');
    }

    const size = max - min + 1;
    let radii = 1;
    let current = 0;
    const bytes: number[] = [];

    const build = (integer: number, radix: number): void => {
      let left = Math.floor(size / radii);

      if (left < 2) {
        bytes.push(current + min);
        current = 0;
        radii = 1;
        left = size;
      }

      if (left >= radix) {
        current += radii * integer;
        radii *= radix;
      } else {
        const factor = Math.ceil(radix / left);
        current += radii * Math.floor(integer / factor);
        radii *= left;
        build(integer % factor, factor);
      }
    };

    for (const i in this.radii) {
      build(this.integers[i], this.radii[i]);
    }

    if (radii !== 0) {
      bytes.push(current + min);
    }

    return new Uint8Array(bytes);
  }
}
