/**
 * The write-side packer primitive. Values are pushed as (integer, radix)
 * pairs via `compose`/`composeTerm`; `toString`/`toUint8Array` fold them into
 * mixed-radix blocks and emit digits. Schema nodes drive this — it knows
 * nothing about types.
 */

import type { Charset } from './types';
import {
  TERM_BASE,
  TERM_ESCAPE_MIN,
  TERM_PAYLOAD_BASE,
  TERM_PAYLOAD_MIN_DIGITS,
} from './constants';
import { validateCharset, blockCapacity, isArray } from './utils';

export class Encoder {
  private radii: number[] = [];
  private integers: number[] = [];

  /** Push one value in a fixed radix: `integer` must lie in `[0, radix)`. */
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

  /** Push one unbounded non-negative integer. */
  composeTerm(integer: number): void {
    if (!Number.isInteger(integer) || integer < 0) {
      // The digit loops below only terminate for non-negative integers.
      throw new TypeError('Term must be a non-negative integer');
    }

    if (integer < TERM_ESCAPE_MIN) {
      // Inline: a terminated base-TERM_BASE run. Values here stay far below
      // 2^53, so plain number arithmetic is exact.
      this.composeRun(integer, TERM_BASE + 2);
      return;
    }

    // Escaped: the widened first slot's extra symbol, the base-8 digit count
    // (offset by its known minimum, as a plain run), then the digits.
    this.compose(TERM_BASE + 1, TERM_BASE + 2);

    // Extract digits in BigInt: integer-valued doubles are exact, but float
    // division above 2^53 is not, and escaped terms live in that range.
    const base = BigInt(TERM_PAYLOAD_BASE);
    const digits: number[] = [];
    let value = BigInt(integer);
    while (value !== 0n) {
      digits.push(Number(value % base));
      value /= base;
    }

    this.composeRun(digits.length - TERM_PAYLOAD_MIN_DIGITS, TERM_BASE + 1);
    for (let i = 0; i < digits.length - 1; i++) {
      this.compose(digits[i], TERM_PAYLOAD_BASE);
    }
    // The top digit is never zero, so it packs one state tighter — which also
    // makes zero-padded (non-canonical) digit strings unrepresentable.
    this.compose(digits[digits.length - 1] - 1, TERM_PAYLOAD_BASE - 1);
  }

  /**
   * A terminated base-TERM_BASE digit run, lowest digit first: digit d rides
   * as symbol d+1, symbol 0 terminates. The first slot's radix is a parameter
   * because a term's opening slot carries one extra state for the escape.
   */
  private composeRun(value: number, firstRadix: number): void {
    let radix = firstRadix;
    while (value !== 0) {
      this.compose((value % TERM_BASE) + 1, radix);
      value = Math.floor(value / TERM_BASE);
      radix = TERM_BASE + 1;
    }
    this.compose(0, radix);
  }

  /**
   * Pack the buffer into base-`size` digits, lowest digit first, as a run of
   * mixed-radix blocks. Within a block, values fold into one big integer — in
   * reverse, so the decoder can peel them off front-to-back, which it needs
   * because later radices can depend on earlier decoded values (e.g. an
   * array's length prefix). A value whose radix would push the block's radix
   * product past the block cap starts the next block instead. Full blocks span
   * exactly `digits` digits, so the decoder finds the boundaries by position
   * alone; only the final block rounds up to a whole digit, so a message that
   * fits one block is always the information-theoretic minimum length:
   * ceil(log_size(product of all radii)).
   */
  private toDigits(size: number): number[] {
    const base = BigInt(size);
    const block = blockCapacity(size);
    const digits: number[] = [];

    let start = 0;
    while (start < this.radii.length) {
      // Extend the block while its radix product stays within the cap.
      let product = 1n;
      let end = start;
      while (end < this.radii.length) {
        const radix = BigInt(this.radii[end]);
        if (product * radix > block.cap) {
          break;
        }
        product *= radix;
        end++;
      }

      let value = 0n;
      for (let i = end - 1; i >= start; i--) {
        value = value * BigInt(this.radii[i]) + BigInt(this.integers[i]);
      }

      if (end < this.radii.length) {
        // A full block: more values follow, so every digit of the block is
        // emitted, filled or not.
        for (let d = 0; d < block.digits; d++) {
          digits.push(Number(value % base));
          value /= base;
        }
      } else {
        // The final block: emit the minimum digits its state space needs.
        let capacity = product;
        while (capacity > 1n) {
          digits.push(Number(value % base));
          value /= base;
          capacity = (capacity + base - 1n) / base;
        }
      }

      start = end;
    }

    return digits;
  }

  toString(charset?: Charset): string {
    const validatedCharset = validateCharset(charset);

    const size =
      typeof validatedCharset === 'string'
        ? validatedCharset.length
        : validatedCharset[1] - validatedCharset[0] + 1;

    let str = '';

    for (const digit of this.toDigits(size)) {
      if (typeof validatedCharset === 'string') {
        str += validatedCharset.charAt(digit);
      } else {
        str += String.fromCharCode(digit + validatedCharset[0]);
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
