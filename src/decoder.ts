/**
 * Decoder class for Polynar
 */

import type { Charset, EncodingOptions, Decoder as IDecoder } from './types';
import { DEFAULT_BASE } from './constants';
import { validateOptions, validateCharset, isArray } from './utils';
import { modules } from './modules/registry';

/**
 * Decoder class
 */
export class Decoder implements IDecoder {
  str: string;
  charset: Charset;
  size: number;
  private bytes?: Uint8Array;
  /** The remaining payload, as one big mixed-radix integer. */
  private value?: bigint;
  /** size^(digit count of the input) — the total state space the input holds. */
  private capacity?: bigint;
  /** Product of all radices parsed so far. */
  private consumed = 1n;

  constructor(str: string | Uint8Array, charset?: Charset) {
    if (str == null) {
      throw new Error('Missing first argument');
    }

    if (str instanceof Uint8Array) {
      // Binary mode - use Uint8Array directly
      this.bytes = str;
      this.str = ''; // Not used in binary mode

      if (charset != null && (!isArray(charset) || charset.length !== 2)) {
        throw new TypeError('Binary charset must be a [min, max] range');
      }

      const [min, max] = (charset as [number, number]) || [0, 255];

      // Validate range
      if (min < 0 || min > 255 || max < 0 || max > 255 || min >= max) {
        throw new RangeError('Binary range must be between 0-255 and min must be < max');
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
        this.size =
          (this.charset as [number, number])[1] - (this.charset as [number, number])[0] + 1;
      }
    }
  }

  /** Digit value of the input at position `i`, validated against the charset. */
  private digitAt(i: number): number {
    if (this.bytes) {
      const digit = this.bytes[i] - (this.charset as [number, number])[0];

      if (digit < 0 || digit >= this.size) {
        throw new Error('Byte at ' + i + ' does not fit binary range');
      }

      return digit;
    }

    if (typeof this.charset === 'string') {
      const digit = this.charset.indexOf(this.str.charAt(i));

      if (digit === -1) {
        throw new Error('Byte at ' + i + ' not found in character set');
      }

      return digit;
    }

    const digit = this.str.charCodeAt(i) - (this.charset as [number, number])[0];

    if (digit < 0 || digit >= this.size) {
      throw new Error('Byte at ' + i + ' does not fit binary range');
    }

    return digit;
  }

  /**
   * Rebuild the encoder's big mixed-radix integer from the base-`size` digits
   * of the input. Deferred to the first parse so charset errors surface on
   * read, not construction.
   */
  private load(): void {
    const base = BigInt(this.size);
    const length = this.bytes ? this.bytes.length : this.str.length;
    let value = 0n;
    let capacity = 1n;

    for (let i = length - 1; i >= 0; i--) {
      value = value * base + BigInt(this.digitAt(i));
      capacity *= base;
    }

    this.value = value;
    this.capacity = capacity;
  }

  parse(radix: number): number {
    if (this.value == null) {
      this.load();
    }

    const radixBig = BigInt(radix);
    const consumed = this.consumed * radixBig;

    // The encoder emits exactly enough digits to cover the product of all
    // radii, so needing more state space than the input holds means the input
    // is truncated or is being read past its end.
    if (consumed > this.capacity!) {
      throw new Error('Unexpected end of input while parsing');
    }

    this.consumed = consumed;
    const integer = this.value! % radixBig;
    this.value = this.value! / radixBig;

    return Number(integer);
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
      throw new TypeError('Count must be a non-negative integer');
    }

    const validatedOptions = validateOptions(options);

    // A `limit` read recovers a length-prefixed array, so it must always return
    // an array. Never unwrap it, even when the decoded length happens to be 1.
    const limited = !!validatedOptions.limit;
    if (limited) {
      count = this.parse((validatedOptions.limit as number) + 1);
    }

    let items = modules[validatedOptions.type].decoder.call(this, validatedOptions, count);

    if (typeof validatedOptions.postProc === 'function') {
      for (const i in items) {
        items[i] = validatedOptions.postProc(items[i]);
      }
    }

    if (count === 1 && !limited) {
      items = items.pop();
    }

    return items;
  }
}
