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
import { validateCharset, validateByteRange, blockCapacity } from './utils';

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
   * density factor) and its digit bound S/den, the largest freq-blind
   * candidate the block saw, mirroring the encoder's per-symbol updates
   * exactly. With every freq at 1 (uniform slots only), V and S are both
   * the plain radix product.
   */
  private boundV = 1n;
  private boundU = 1n;
  private boundDen = 1n;
  private boundS = 1n;
  /**
   * Tightest digit bound the last read admits (numerator over `tightDen`):
   * the block's digit bound so far raised to the read's index form where the
   * symbol has one, else to its bucket form. The encoder sizes the final
   * block by this, so `finalize` checks the digit count against it.
   */
  private tightV = 1n;
  private tightDen = 1n;
  /** Whether the last read was an index. Set by `stepBound`. */
  private indexed = false;
  /** An index closes its block: any further read must start the next one. */
  private closed = false;
  /** Digit index where the current block starts. */
  private blockStart = 0;
  /** Digits-per-block and block state-space cap for this charset size. */
  private block?: { digits: number; cap: bigint };

  constructor(str: string | Uint8Array, charset?: Charset) {
    if (str instanceof Uint8Array) {
      // Binary mode - use Uint8Array directly
      this.bytes = str;
      this.str = ''; // Not used in binary mode

      if (charset != null && !Array.isArray(charset)) {
        throw new TypeError('Binary charset must be a [min, max] range');
      }

      const [min, max] = validateByteRange((charset as [number, number]) || [0, 255]);

      this.charset = [min, max];
      this.size = max - min + 1;
    } else {
      // String mode
      this.str = str;
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
        throw new CorruptInputError('Character at ' + i + ' not found in character set');
      }

      return digit;
    }

    const digit = this.str.charCodeAt(i) - (this.charset as [number, number])[0];

    if (digit < 0 || digit >= this.size) {
      throw new CorruptInputError('Character at ' + i + ' does not fit the character range');
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
    this.boundS = 1n;
    this.closed = false;
  }

  /**
   * Advance the freq-blind bound candidate for a symbol of `total` states:
   * block-boundary decision and truncation check, mirroring the encoder.
   * Returns the candidate V numerator; the caller commits it (scaled by the
   * symbol's freq once known) after the read.
   *
   * `count` is the symbol's index form: when the bucket form needs more
   * state than the digits hold but the index form fits, the encoder wrote
   * the index (it only does so for the message's last symbol), and
   * `indexed` is set for the caller.
   */
  private stepBound(totalBig: bigint, countBig: bigint): bigint {
    let candidate = this.boundV + this.boundU * (totalBig - 1n);
    this.indexed = false;

    // Mirror the encoder's greedy rule: a value whose total would push the
    // block's state bound past the cap lives in the next block.
    if (this.closed || candidate > this.block!.cap * this.boundDen) {
      // The encoder leaves no remainder at a block boundary, so leftover value
      // here means a digit was tampered past its saturation point.
      if (this.value !== 0n) {
        throw new CorruptInputError('Oversaturated input');
      }

      if (this.blockStart + this.block!.digits > this.inputLength()) {
        throw new CorruptInputError(
          'Unexpected end of input while parsing: truncated or corrupted'
        );
      }

      this.loadBlock(this.blockStart + this.block!.digits);
      candidate = totalBig;
    }

    const asIndex = countBig < totalBig ? this.boundV + this.boundU * (countBig - 1n) : candidate;
    this.tightV = this.boundS < asIndex ? asIndex : this.boundS;
    this.tightDen = this.boundDen;

    // The encoder emits exactly enough digits to cover the block's digit
    // bound, which covers every bucket candidate, so needing more state
    // space than the block holds means the input is truncated or is being
    // read past its end — unless the symbol's index form fits, which is how
    // the encoder wrote it.
    if (candidate > this.capacity! * this.boundDen) {
      if (asIndex > this.capacity! * this.boundDen) {
        throw new CorruptInputError(
          'Unexpected end of input while parsing: truncated or corrupted'
        );
      }
      this.indexed = true;
      this.closed = true;
      this.boundS = this.tightV;
      return asIndex;
    }

    if (this.boundS < candidate) {
      this.boundS = candidate;
    }
    return candidate;
  }

  /**
   * Read one value composed in a fixed radix.
   *
   * No mid-parse saturation check: a weighted symbol can grow the state
   * bound by less than a doubling, so leftover value inside the last digit
   * is not by itself corrupt. Block advancement and `finalize()` reject every
   * non-canonical leftover instead.
   */
  parse(radix: number): number {
    // The encoder records nothing for a radix-1 digit.
    if (radix === 1) {
      return 0;
    }
    if (this.value == null) {
      this.loadBlock(0);
    }

    const radixBig = BigInt(radix);
    this.boundV = this.stepBound(radixBig, radixBig);
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
   *
   * `count` and `atIndex` describe the node's members in bucket order, as
   * `composeWeighted` received them: `atIndex(i)` is the triple `locate`
   * returns for the i-th member. The message's last symbol may be written as
   * that index rather than a bucket; the digit count tells which.
   */
  parseWeighted<T>(
    total: number,
    locate: (residual: number) => readonly [T, number, number],
    count: number = total,
    atIndex?: (index: number) => readonly [T, number, number]
  ): T {
    if (this.value == null) {
      this.loadBlock(0);
    }

    if (!Number.isInteger(count) || count < 1) {
      throw new TypeError(`Symbol count must be a positive integer, got ${count}`);
    }
    const totalBig = BigInt(total);
    const countBig = BigInt(Math.min(count, total));
    if (countBig < totalBig && atIndex === undefined) {
      throw new TypeError('parseWeighted needs atIndex when count is below total');
    }
    const candidate = this.stepBound(totalBig, countBig);

    if (this.indexed) {
      const index = Number(this.value! % countBig);
      this.value = this.value! / countBig;
      const [symbol, , freq] = atIndex!(index);
      // The encoder refuses zero-weight values, so one here was never written.
      if (!Number.isInteger(freq) || freq < 1) {
        throw new CorruptInputError('Index of a value with no weight');
      }
      this.boundV = candidate;
      this.boundU *= countBig;
      return symbol;
    }

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
      throw new TypeError(
        `locate returned a bucket that does not contain the residual: [${cum}, ${cum + freq}) for ${residual}`
      );
    }

    const freqBig = BigInt(freq);
    if (freqBig === 1n) {
      this.boundV = candidate;
    } else {
      this.boundV = (this.boundV + this.boundU * (totalBig - freqBig)) * freqBig;
      this.boundS *= freqBig;
      this.boundDen *= freqBig;
    }
    this.boundU *= totalBig;
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
    // ceil(log_size(state bound)) digits — the bound in the last symbol's
    // tightest form — so its state space never reaches a full unread digit
    // beyond what the reads consumed.
    if (
      this.blockStart + this.block!.digits < this.inputLength() ||
      this.tightV * BigInt(this.size) <= this.capacity! * this.tightDen
    ) {
      throw new CorruptInputError('Input is longer than its contents');
    }
  }
}
