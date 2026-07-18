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
import { validateCharset, blockCapacity } from './utils';

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
  /**
   * Rational state bound V/den of the current block (with U/den its running
   * density factor), mirroring the encoder's per-symbol updates exactly.
   * With every freq at 1 (uniform slots only), V is the plain radix product.
   */
  private boundV = 1n;
  private boundU = 1n;
  private boundDen = 1n;
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

      if (charset != null && (!Array.isArray(charset) || charset.length !== 2)) {
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
    this.boundV = 1n;
    this.boundU = 1n;
    this.boundDen = 1n;
  }

  /**
   * Advance the freq-blind bound candidate for a symbol of `total` states:
   * block-boundary decision and truncation check, mirroring the encoder.
   * Returns the candidate V numerator; the caller commits it (scaled by the
   * symbol's freq once known) after the read.
   */
  private stepBound(totalBig: bigint): bigint {
    let candidate = this.boundV + this.boundU * (totalBig - 1n);

    // Mirror the encoder's greedy rule: a value whose total would push the
    // block's state bound past the cap lives in the next block.
    if (candidate > this.block!.cap * this.boundDen) {
      // The encoder leaves no remainder at a block boundary, so leftover value
      // here means a digit was tampered past its saturation point.
      if (this.value !== 0n) {
        throw new CorruptInputError('Oversaturated input');
      }

      if (this.blockStart + this.block!.digits >= this.inputLength()) {
        throw new CorruptInputError('Unexpected end of input while parsing');
      }

      this.loadBlock(this.blockStart + this.block!.digits);
      candidate = totalBig;
    }

    // The encoder emits exactly enough digits to cover the block's state
    // bound, so needing more state space than the block holds means the
    // input is truncated or is being read past its end.
    if (candidate > this.capacity! * this.boundDen) {
      throw new CorruptInputError('Unexpected end of input while parsing');
    }

    return candidate;
  }

  /**
   * Read one value composed in a fixed radix.
   *
   * No mid-parse saturation check: a weighted symbol can grow the state
   * bound by less than a doubling, so leftover value inside the last digit
   * is not evidence of tampering the way it was in the uniform-only wire —
   * block advancement and `finalize()` reject every non-canonical leftover
   * instead.
   */
  parse(radix: number): number {
    if (this.value == null) {
      this.loadBlock(0);
    }

    const radixBig = BigInt(radix);
    this.boundV = this.stepBound(radixBig);
    this.boundU *= radixBig;

    const integer = this.value! % radixBig;
    this.value = this.value! / radixBig;

    return Number(integer);
  }

  /**
   * Read one weighted symbol composed by `composeWeighted`. `locate` maps the
   * residual in `[0, total)` to its bucket: the symbol plus the same
   * `[cum, cum + freq)` the encoder used. The block-boundary decision is made
   * freq-blind (mirroring the encoder, which cannot assume the decoder knows
   * the symbol yet); the state bound then updates with the true freq.
   */
  parseWeighted<T>(total: number, locate: (residual: number) => readonly [T, number, number]): T {
    if (this.value == null) {
      this.loadBlock(0);
    }

    const totalBig = BigInt(total);
    const candidate = this.stepBound(totalBig);

    const residual = Number(this.value! % totalBig);
    const [symbol, cum, freq] = locate(residual);
    // A bucket that fails to contain its own residual is a model bug on this
    // side, not corrupt input.
    if (
      !Number.isInteger(cum) ||
      !Number.isInteger(freq) ||
      freq < 1 ||
      cum < 0 ||
      cum > residual ||
      residual >= cum + freq ||
      cum + freq > total
    ) {
      throw new TypeError('locate returned a bucket that does not contain the residual');
    }

    const freqBig = BigInt(freq);
    this.boundV = candidate * freqBig;
    this.boundU *= totalBig;
    this.boundDen *= freqBig;
    this.value = freqBig * (this.value! / totalBig) + BigInt(residual - cum);

    return symbol;
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
    // ceil(log_size(state bound)) digits, so its state space never reaches
    // a full unread digit beyond what the reads consumed.
    if (
      this.blockStart + this.block!.digits < this.inputLength() ||
      this.boundV * BigInt(this.size) <= this.capacity! * this.boundDen
    ) {
      throw new CorruptInputError('Input is longer than its contents');
    }
  }
}
