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
 * plain multiply-add, which is mixed-radix arithmetic.
 */

import type { Charset, ByteRange } from './types';
import {
  TERM_BASE,
  TERM_ESCAPE_MIN,
  TERM_PAYLOAD_BASE,
  TERM_PAYLOAD_MIN_DIGITS,
} from './constants';
import {
  validateCharset,
  validateByteRange,
  charsetSize,
  digitChunk,
  SHIFTS,
  type DigitChunk,
} from './utils';
import { BlockBound } from './bound';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const TWO_53 = 2 ** 53;

/**
 * Append `count` base-`size` digits of `value`, lowest first. A big value
 * sheds a chunk of digits per division, split further in Number arithmetic.
 */
function emitDigits(
  digits: number[],
  value: bigint | number,
  count: number,
  size: number,
  chunk: DigitChunk
): void {
  let big = typeof value === 'bigint' ? value : undefined;
  let num = typeof value === 'number' ? value : 0;
  const shift = chunk.bits === 0 ? undefined : SHIFTS[chunk.bits];
  while (count > 0) {
    let run = count;
    if (big !== undefined) {
      if (count > chunk.digits) {
        if (shift === undefined) {
          num = Number(big % chunk.big);
          big /= chunk.big;
        } else {
          num = Number(BigInt.asUintN(chunk.bits, big));
          big >>= shift;
        }
        run = chunk.digits;
      } else {
        // The digit count covers the value, so what remains fits the chunk.
        num = Number(big);
        big = undefined;
      }
    }
    count -= run;
    for (let d = 0; d < run; d++) {
      // Below 2^53 the float quotient rounds to the exact integer part: the
      // integer part is itself a double, and the quotient would have to be
      // closer to the next integer, which the value's size rules out.
      const quotient = Math.floor(num / size);
      digits.push(num - quotient * size);
      num = quotient;
    }
  }
}

export class Encoder {
  private cums: number[] = [];
  private freqs: number[] = [];
  private totals: number[] = [];
  /** Position of each symbol among its node's `counts` symbols, in bucket order. */
  private indices: number[] = [];
  /** Symbol count per slot: a uniform slot's radix, or a weighted node's member count. */
  private counts: number[] = [];

  /** Push one value in a fixed radix: `integer` must lie in `[0, radix)`. */
  compose(integer: number, radix: number): void {
    // An out-of-range value would not throw on its own; it would silently
    // corrupt every value packed after it, so it fails here, at the source.
    if (!Number.isInteger(radix)) {
      throw new TypeError(`Radix must be an integer, got ${radix}`);
    }
    if (radix < 1 || radix > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Radix ${radix} is not a positive safe integer`);
    }
    if (!Number.isInteger(integer)) {
      throw new TypeError(`Digit must be an integer, got ${integer}`);
    }
    if (integer < 0 || integer >= radix) {
      throw new RangeError(`Digit ${integer} is outside [0, ${radix})`);
    }
    // A radix-1 digit carries nothing. Recording it would make it the
    // message's last symbol and cost the one before it its index form.
    if (radix === 1) {
      return;
    }

    this.cums.push(integer);
    this.freqs.push(1);
    this.totals.push(radix);
    this.indices.push(integer);
    this.counts.push(radix);
  }

  /**
   * Push one weighted symbol: the bucket `[cum, cum + freq)` out of `total`
   * states. Costs log2(total/freq) bits — fractional, exact. The decoder
   * recovers the symbol from which bucket the residual lands in, so both
   * sides must derive identical integer tables.
   *
   * `index` and `count` place the symbol among the node's members in bucket
   * order. They let the message's last symbol be written as a plain index:
   * a weighted bucket borrows its fractional bits from the symbols after it,
   * and the last one has none to borrow, so as a bucket it would cost
   * log2(total) bits. Without them the symbol is always written as a bucket.
   */
  composeWeighted(
    cum: number,
    freq: number,
    total: number,
    index: number = cum,
    count: number = total
  ): void {
    if (!Number.isInteger(total) || !Number.isInteger(freq) || !Number.isInteger(cum)) {
      throw new TypeError(`Bucket must be integers, got cum ${cum}, freq ${freq}, total ${total}`);
    }
    if (total < 1 || total > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Total ${total} is not a positive safe integer`);
    }
    if (freq < 1) {
      throw new RangeError(`Frequency ${freq} is not positive`);
    }
    if (cum < 0 || cum + freq > total) {
      throw new RangeError(`Bucket [${cum}, ${cum + freq}) is outside [0, ${total})`);
    }
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1) {
      throw new TypeError(`Symbol position must be integers, got index ${index}, count ${count}`);
    }
    // A node with at least as many members as states gains nothing from an
    // index, so its symbols stay buckets and the index goes unused; the
    // decoder clamps identically.
    const members = Math.min(count, total);
    if (members < total && (index < 0 || index >= members)) {
      throw new RangeError(`Index ${index} is outside [0, ${members})`);
    }

    this.cums.push(cum);
    this.freqs.push(freq);
    this.totals.push(total);
    this.indices.push(members < total ? index : 0);
    this.counts.push(members);
  }

  /** Push one unbounded non-negative integer. */
  composeTerm(integer: number): void {
    // The digit loops below only terminate for non-negative integers.
    if (!Number.isInteger(integer)) {
      throw new TypeError(`Term must be an integer, got ${integer}`);
    }
    if (integer < 0) {
      throw new RangeError(`Term ${integer} is negative`);
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

    // Digits come out in BigInt: integer-valued doubles are exact, but float
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
   * ceil(log_size(digit bound)).
   *
   * The state bound is the rational V/den, with U/den the running density
   * factor: per symbol V' = (V + U·(total−freq))·freq, U' = U·total,
   * den' = den·freq. Folding a symbol onto a state below x yields a state
   * below x·total/freq + (total − freq), so V/den covers the reverse fold in
   * wire order even though the per-symbol exact bound is not
   * order-commutative. The candidate V + U·(total−1) needs only `total`, so
   * the decoder makes the identical block-boundary decision before it has
   * decoded the symbol; the final digit count then covers the largest such
   * candidate the block saw (S/den), because the decoder tells an index-form
   * tail from a bucket by whether the bucket's candidate fits the digits.
   * S pays the freq-blind slack once per block, for the symbol with the most
   * of it, while V would pay it once per symbol. With every freq at 1, V and
   * S both equal the radix product: the plain mixed-radix wire format, byte for byte.
   * `BlockBound` carries these rationals for both sides.
   */
  private toDigits(size: number): number[] {
    const bound = new BlockBound(size);
    const chunk = digitChunk(size);
    const digits: number[] = [];
    const totals = this.totals;
    const n = totals.length;

    let start = 0;
    while (start < n) {
      // The block extends while the freq-blind bound stays within the cap.
      bound.reset();
      // The message's last symbol has nothing after it to fill the fractional
      // part of its bucket, so as a bucket it needs log2(total) bits of state.
      // When that does not fit the digits its plain index needs, it is
      // written as the index instead. The decoder sees the same digit count
      // and makes the same call.
      let indexed = false;
      let count = 0;
      let end = start;
      while (end < n) {
        const total = totals[end];
        if (bound.exceedsCap(total)) {
          break;
        }
        if (end === n - 1 && this.counts[end] < total) {
          const decision = bound.indexDecision(total, this.counts[end]);
          indexed = decision.indexed;
          count = decision.digits;
        }
        bound.update(total, this.freqs[end], this.counts[end]);
        end++;
      }

      // A full block spans every digit of the block, filled or not, since
      // more values follow; the final block spans the minimum digits its
      // digit bound needs.
      if (end < n) {
        count = bound.blockDigits;
      } else if (!indexed) {
        count = bound.digitsForS();
      }

      emitDigits(digits, this.fold(start, end, indexed), count, size, chunk);
      start = end;
    }

    return digits;
  }

  /**
   * The block's values folded into one integer, in reverse. A run of uniform
   * slots is an affine step `value·product + offset` that accumulates in
   * Number arithmetic while the product stays below 2^53, so the big integer
   * grows once per run rather than once per value; a weighted slot folds the
   * exact value, which stays a Number until it outgrows one.
   */
  private fold(start: number, end: number, indexed: boolean): bigint | number {
    const { cums, freqs, totals } = this;
    let big: bigint | undefined;
    /** The pending affine step on `big`: `big·product + offset`, offset below product. */
    let product = 1;
    let offset = 0;
    let i = end - 1;
    if (indexed) {
      product = this.counts[i];
      offset = this.indices[i];
      i--;
    }
    for (; i >= start; i--) {
      const total = totals[i];
      const freq = freqs[i];
      if (freq === 1) {
        const grown = product * total;
        // A true product above 2^53 can round down to 2^53 itself, so only a
        // result below it is known exact.
        if (grown < TWO_53) {
          product = grown;
          offset = offset * total + cums[i];
          continue;
        }
        big = big === undefined ? BigInt(offset) : big * BigInt(product) + BigInt(offset);
        product = total;
        offset = cums[i];
        continue;
      }
      if (big === undefined) {
        const rem = offset % freq;
        const quotient = (offset - rem) / freq;
        const next = quotient * total + (cums[i] + rem);
        if (next <= MAX_SAFE) {
          product = next + 1;
          offset = next;
          continue;
        }
        big = BigInt(quotient) * BigInt(total) + BigInt(cums[i] + rem);
      } else {
        if (product !== 1) {
          big = big * BigInt(product) + BigInt(offset);
        }
        const freqBig = BigInt(freq);
        const quotient = big / freqBig;
        const rem = big - quotient * freqBig;
        big = quotient * BigInt(total) + BigInt(cums[i] + Number(rem));
      }
      product = 1;
      offset = 0;
    }
    if (big === undefined) {
      return offset;
    }
    return product === 1 ? big : big * BigInt(product) + BigInt(offset);
  }

  toString(charset?: Charset): string {
    const validatedCharset = validateCharset(charset);

    const size = charsetSize(validatedCharset);

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

  toUint8Array(charset?: ByteRange): Uint8Array {
    const [min, max] = validateByteRange(charset || [0, 255]);

    const digits = this.toDigits(max - min + 1);
    const bytes = new Uint8Array(digits.length);

    for (let i = 0; i < digits.length; i++) {
      bytes[i] = digits[i] + min;
    }

    return bytes;
  }
}
