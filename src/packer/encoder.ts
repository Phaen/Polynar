/**
 * The write-side packer primitive. Values are pushed as (integer, radix)
 * pairs via `compose`/`composeTerm`, or as weighted symbols via
 * `composeWeighted`; `toString`/`toUint8Array` fold them into mixed-radix
 * blocks and emit digits. Schema nodes drive this — it knows nothing about
 * types.
 *
 * The fold is a big-integer rANS: a weighted symbol owning `freq` of `total`
 * states costs exactly log2(total/freq) bits, because the position inside
 * its bucket carries the next value's information instead of being wasted.
 * A uniform slot is the special case freq = 1, which reduces the update to
 * plain multiply-add — the original mixed-radix arithmetic.
 */

import type { Charset } from './types';
import {
  TERM_BASE,
  TERM_ESCAPE_MIN,
  TERM_PAYLOAD_BASE,
  TERM_PAYLOAD_MIN_DIGITS,
} from './constants';
import { validateCharset, blockCapacity } from './utils';

export class Encoder {
  private cums: number[] = [];
  private freqs: number[] = [];
  private totals: number[] = [];

  /** Push one value in a fixed radix: `integer` must lie in `[0, radix)`. */
  compose(integer: number, radix: number): void {
    // An out-of-range value would not throw on its own; it would silently
    // corrupt every value packed after it. Fail here, at the source.
    if (!Number.isInteger(radix) || radix < 1 || radix > Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Radix must be a positive safe integer');
    }

    if (!Number.isInteger(integer) || integer < 0 || integer >= radix) {
      throw new RangeError('Integer must be a non-negative integer below its radix');
    }

    this.cums.push(integer);
    this.freqs.push(1);
    this.totals.push(radix);
  }

  /**
   * Push one weighted symbol: the bucket `[cum, cum + freq)` out of `total`
   * states. Costs log2(total/freq) bits — fractional, exact. The decoder
   * recovers the symbol from which bucket the residual lands in, so both
   * sides must derive identical integer tables.
   */
  composeWeighted(cum: number, freq: number, total: number): void {
    if (!Number.isInteger(total) || total < 1 || total > Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Total must be a positive safe integer');
    }
    if (!Number.isInteger(freq) || freq < 1) {
      throw new TypeError('Frequency must be a positive integer');
    }
    if (!Number.isInteger(cum) || cum < 0 || cum + freq > total) {
      throw new RangeError('Bucket [cum, cum + freq) must lie within [0, total)');
    }

    this.cums.push(cum);
    this.freqs.push(freq);
    this.totals.push(total);
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
   * array's length prefix). A value whose total would push the block's state
   * bound past the block cap starts the next block instead. Full blocks span
   * exactly `digits` digits, so the decoder finds the boundaries by position
   * alone; only the final block rounds up to a whole digit, so a message that
   * fits one block is always the information-theoretic minimum length:
   * ceil(log_size(state bound)).
   *
   * The bound is the rational V/den, with U/den the running density factor:
   * per symbol V' = (V + U·(total−1))·freq, U' = U·total, den' = den·freq.
   * V/den provably covers the reverse fold in wire order even though the
   * per-symbol exact bound is not order-commutative, and the candidate
   * V + U·(total−1) needs only `total` — so the decoder can make the
   * identical block-boundary decision before it has decoded the symbol.
   * With every freq at 1, V IS the radix product: the original wire format,
   * byte for byte.
   */
  private toDigits(size: number): number[] {
    const base = BigInt(size);
    const block = blockCapacity(size);
    const digits: number[] = [];

    let start = 0;
    while (start < this.totals.length) {
      // Extend the block while the freq-blind bound stays within the cap.
      let den = 1n;
      let u = 1n;
      let v = 1n;
      let end = start;
      while (end < this.totals.length) {
        const total = BigInt(this.totals[end]);
        const candidate = v + u * (total - 1n);
        if (candidate > block.cap * den) {
          break;
        }
        const freq = BigInt(this.freqs[end]);
        v = candidate * freq;
        u = u * total;
        den = den * freq;
        end++;
      }

      let value = 0n;
      for (let i = end - 1; i >= start; i--) {
        const freq = BigInt(this.freqs[i]);
        value = (value / freq) * BigInt(this.totals[i]) + BigInt(this.cums[i]) + (value % freq);
      }

      if (end < this.totals.length) {
        // A full block: more values follow, so every digit of the block is
        // emitted, filled or not.
        for (let d = 0; d < block.digits; d++) {
          digits.push(Number(value % base));
          value /= base;
        }
      } else {
        // The final block: emit the minimum digits its state bound needs.
        let capacity = (v + den - 1n) / den;
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
    if (charset != null && (!Array.isArray(charset) || charset.length !== 2)) {
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
