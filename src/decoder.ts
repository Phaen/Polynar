/**
 * Decoder class for Polynar
 */

import type { Charset, EncodingOptions, Decoder as IDecoder } from './types';
import { DEFAULT_STRICT, DEFAULT_BASE } from './constants';
import { validateOptions, validateCharset } from './utils';
import { modules } from './modules/registry';

/**
 * Decoder class
 */
export class Decoder implements IDecoder {
  strict: boolean;
  str: string;
  charset: Charset;
  size: number;
  current?: number;
  radii?: number;
  pointer?: number;
  private bytes?: Uint8Array;

  constructor(str: string | Uint8Array, charset?: Charset, strict?: boolean) {
    if (str == null) {
      throw new Error('Missing first argument');
    }

    this.strict = strict == null ? DEFAULT_STRICT : Boolean(strict);

    if (str instanceof Uint8Array) {
      // Binary mode - use Uint8Array directly
      this.bytes = str;
      this.str = ''; // Not used in binary mode

      const [min, max] = (charset as [number, number]) || [0, 255];

      // Validate range
      if (min < 0 || min > 255 || max < 0 || max > 255 || min > max) {
        throw new RangeError('Binary range must be between 0-255 and min must be <= max');
      }

      this.charset = [min, max];
      this.size = max - min + 1;
    } else {
      // String mode
      this.str = String(str);
      this.charset = validateCharset(charset);

      if (typeof this.charset === 'string') {
        this.size = this.charset.length;
      } else {
        this.size = (this.charset as [number, number])[1] - (this.charset as [number, number])[0] + 1;
      }
    }
  }

  parse(radix: number): number {
    let left: number;

    if (this.current == null || (left = Math.floor(this.size / this.radii!)) === 1) {
      if (this.current == null) {
        this.pointer = 0;
      } else if (this.current !== 0) {
        throw new Error('Oversaturated byte at position ' + this.pointer);
      } else {
        this.pointer!++;
      }

      this.radii = 1;
      left = this.size;

      if (this.bytes) {
        // Binary mode - read from Uint8Array
        if (this.pointer === this.bytes.length) {
          throw new Error('Unexpected end of input while parsing');
        }
        this.current = this.bytes[this.pointer!] - (this.charset as [number, number])[0];
      } else {
        // String mode - read from string
        if (this.pointer === this.str.length) {
          throw new Error('Unexpected end of input while parsing');
        }

        if (typeof this.charset === 'string') {
          this.current = this.charset.indexOf(this.str.charAt(this.pointer!));

          if (this.current === -1) {
            throw new Error('Byte at ' + this.pointer + ' not found in character set');
          }
        } else {
          this.current = this.str.charCodeAt(this.pointer!) - (this.charset as [number, number])[0];

          if (this.current > this.size) {
            throw new Error('Byte at ' + this.pointer + ' does not fit binary range');
          }
        }
      }
    }

    let integer: number;

    if (left! >= radix) {
      integer = this.current! % radix;
      this.current = Math.floor(this.current! / radix);
      this.radii! *= radix;
    } else {
      const factor = Math.ceil(radix / left!);
      integer = this.current! * factor;
      this.current = Math.floor(this.current! / left!);
      this.radii! *= left!;
      integer += this.parse(factor);
    }

    return integer;
  }

  parseTerm(): number {
    let integer = 0;
    let md = this.parse(DEFAULT_BASE + 1) - 1;
    for (let pow = 0; md !== -1; pow++) {
      integer += md * Math.pow(DEFAULT_BASE, pow);
      md = this.parse(DEFAULT_BASE + 1) - 1;
    }
    return integer;
  }

  read(options: EncodingOptions, count: number = 1): any {
    if (typeof count !== 'number' || count % 1 !== 0 || count < 0) {
      if (this.strict) {
        throw new TypeError('Count must be positive integer');
      } else {
        count = Math.max(0, Math.floor(Number(count)));
      }
    }

    const validatedOptions = validateOptions(options);

    if (validatedOptions.limit) {
      count = this.parse(validatedOptions.limit + 1);
    }

    let items = modules[validatedOptions.type].decoder.call(this, validatedOptions, count);

    if (typeof validatedOptions.postProc === 'function') {
      for (const i in items) {
        items[i] = validatedOptions.postProc(items[i]);
      }
    }

    if (count === 1) {
      items = items.pop();
    }

    return items;
  }
}
