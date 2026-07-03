/**
 * The read-side packer primitive. `parse`/`parseTerm` peel values back off the
 * mixed-radix blocks in the exact order the Encoder composed them; `finalize`
 * asserts the input was exactly consumed. Schema nodes drive this — it knows
 * nothing about types.
 */

import type { Charset } from './types';
import {
  TERM_BASE,
  TERM_COUNT_RUN_DIGITS,
  TERM_ESCAPE_MIN,
  TERM_INLINE_DIGITS,
  TERM_PAYLOAD_BASE,
  TERM_PAYLOAD_MIN_DIGITS,
} from './constants';
import { CorruptInputError } from './errors';
import { validateCharset, blockCapacity, isArray } from './utils';

const TERM_ESCAPE_MIN_BIG = BigInt(TERM_ESCAPE_MIN);

export class Decoder {
  private str: string;
  private charset: Charset;
  private size: number;
  private bytes?: Uint8Array;
  /** The remaining value of the current block, as one big mixed-radix integer. */
  private value?: bigint;
  /** size^(digits loaded for the current block) — its available state space. */
  private capacity?: bigint;
  /** Product of the radices parsed so far within the current block. */
  private consumed = 1n;
  /** Digit index where the current block starts. */
  private blockStart = 0;
  /** Digits-per-block and block state-space cap for this charset size. */
  private block?: { digits: number; cap: bigint };

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
        this.size = this.charset[1] - this.charset[0] + 1;
      }
    }
  }

  /** Digit value of the input at position `i`, validated against the charset. */
  private digitAt(i: number): number {
    if (this.bytes) {
      const digit = this.bytes[i] - (this.charset as [number, number])[0];

      if (digit < 0 || digit >= this.size) {
        throw new CorruptInputError('Byte at ' + i + ' does not fit binary range');
      }

      return digit;
    }

    if (typeof this.charset === 'string') {
      const digit = this.charset.indexOf(this.str.charAt(i));

      if (digit === -1) {
        throw new CorruptInputError('Byte at ' + i + ' not found in character set');
      }

      return digit;
    }

    const digit = this.str.charCodeAt(i) - (this.charset as [number, number])[0];

    if (digit < 0 || digit >= this.size) {
      throw new CorruptInputError('Byte at ' + i + ' does not fit binary range');
    }

    return digit;
  }

  private inputLength(): number {
    return this.bytes ? this.bytes.length : this.str.length;
  }

  /**
   * Rebuild one block of the encoder's mixed-radix packing from the
   * base-`size` digits of the input. Deferred to the first parse so charset
   * errors surface on read, not construction.
   */
  private loadBlock(start: number): void {
    const base = BigInt(this.size);
    this.block ??= blockCapacity(this.size);

    const end = Math.min(start + this.block.digits, this.inputLength());
    let value = 0n;
    let capacity = 1n;

    for (let i = end - 1; i >= start; i--) {
      value = value * base + BigInt(this.digitAt(i));
      capacity *= base;
    }

    this.blockStart = start;
    this.value = value;
    this.capacity = capacity;
    this.consumed = 1n;
  }

  /** Read one value composed in a fixed radix. */
  parse(radix: number): number {
    if (this.value == null) {
      this.loadBlock(0);
    }

    const radixBig = BigInt(radix);
    let consumed = this.consumed * radixBig;

    // Mirror the encoder's greedy rule: a value whose radix would push the
    // block's radix product past the cap lives in the next block.
    if (consumed > this.block!.cap) {
      // The encoder leaves no remainder at a block boundary, so leftover value
      // here means a digit was tampered past its saturation point.
      if (this.value !== 0n) {
        throw new CorruptInputError('Oversaturated input');
      }

      if (this.blockStart + this.block!.digits >= this.inputLength()) {
        throw new CorruptInputError('Unexpected end of input while parsing');
      }

      this.loadBlock(this.blockStart + this.block!.digits);
      consumed = radixBig;
    }

    // The encoder emits exactly enough digits to cover the block's radix
    // product, so needing more state space than the block holds means the
    // input is truncated or is being read past its end.
    if (consumed > this.capacity!) {
      throw new CorruptInputError('Unexpected end of input while parsing');
    }

    this.consumed = consumed;
    const integer = this.value! % radixBig;
    this.value = this.value! / radixBig;

    // Once less than one doubling of state space is left, the block provably
    // ends here (the encoder never emits a digit more than its radix product
    // needs), so any leftover value means a digit was tampered past its
    // saturation point. With more slack the block may hold further values, so
    // this check is only sound in the final-digit region — block advancement
    // and `finalize()` cover the rest.
    if (consumed * 2n > this.capacity! && this.value !== 0n) {
      throw new CorruptInputError('Oversaturated input');
    }

    return Number(integer);
  }

  /** Read one unbounded non-negative integer composed by `composeTerm`. */
  parseTerm(): number {
    const first = this.parse(TERM_BASE + 2);

    if (first !== TERM_BASE + 1) {
      return this.parseRun(first, TERM_INLINE_DIGITS);
    }

    // Escaped: digit count (offset by its known minimum), then the digits,
    // reassembled in BigInt so terms above 2^53 round-trip bit-exact.
    const count =
      TERM_PAYLOAD_MIN_DIGITS + this.parseRun(this.parse(TERM_BASE + 1), TERM_COUNT_RUN_DIGITS);
    const base = BigInt(TERM_PAYLOAD_BASE);
    let value = 0n;
    let pow = 1n;
    for (let i = 0; i < count - 1; i++) {
      value += BigInt(this.parse(TERM_PAYLOAD_BASE)) * pow;
      pow *= base;
    }
    value += BigInt(this.parse(TERM_PAYLOAD_BASE - 1) + 1) * pow;

    // The encoder escapes only above the inline range, and only emits values
    // a double represents exactly; anything else is a corrupted input.
    if (value < TERM_ESCAPE_MIN_BIG) {
      throw new CorruptInputError('Non-canonical escaped term within the inline range');
    }
    const integer = Number(value);
    if (!Number.isFinite(integer) || BigInt(integer) !== value) {
      throw new CorruptInputError('Escaped term is not an exactly representable integer');
    }
    return integer;
  }

  /**
   * Continue a terminated base-TERM_BASE run whose first symbol the caller
   * already consumed. `maxDigits` is the canonical cap: the encoder never
   * emits longer runs, so exceeding it (or padding with a zero top digit)
   * is corruption, and honoring the cap keeps the arithmetic exact.
   */
  private parseRun(symbol: number, maxDigits: number): number {
    let integer = 0;
    let pow = 1;
    let count = 0;
    let last = 0;

    while (symbol !== 0) {
      if (++count > maxDigits) {
        throw new CorruptInputError('Term run is longer than its canonical maximum');
      }
      integer += (symbol - 1) * pow;
      pow *= TERM_BASE;
      last = symbol;
      symbol = this.parse(TERM_BASE + 1);
    }

    // Symbol 1 is digit zero; as the top digit it means a shorter run encodes
    // the same value, so the encoder never emits it there.
    if (count > 0 && last === 1) {
      throw new CorruptInputError('Non-canonical zero-padded term run');
    }

    return integer;
  }

  /**
   * Assert the input is exactly the canonical encoding of everything read so
   * far: no leftover packed value (a digit tampered within the input) and no
   * unread trailing digits (padding appended to it). Call after the final read
   * to reject corrupted input that the reads themselves could not detect.
   */
  finalize(): void {
    if (this.value == null) {
      this.loadBlock(0);
    }

    if (this.value !== 0n) {
      throw new CorruptInputError('Unread or corrupted data at end of input');
    }

    // No block may follow the current one, and a canonical final block spans
    // ceil(log_size(radix product)) digits, so its state space never reaches
    // a full unread digit beyond what the reads consumed.
    if (
      this.blockStart + this.block!.digits < this.inputLength() ||
      this.consumed * BigInt(this.size) <= this.capacity!
    ) {
      throw new CorruptInputError('Input is longer than its contents');
    }
  }
}
