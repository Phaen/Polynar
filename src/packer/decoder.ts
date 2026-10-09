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
import {
  validateCharset,
  validateByteRange,
  charsetSize,
  charsetLookup,
  digitChunk,
  log2Exact,
  SHIFTS,
  type DigitChunk,
} from './utils';
import { BlockBound } from './bound';

const TERM_ESCAPE_MIN_BIG = BigInt(TERM_ESCAPE_MIN);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIG = BigInt(MAX_SAFE);

export class Decoder {
  private str: string;
  private charset: Charset;
  private size: number;
  private bytes?: Uint8Array;
  /** Digit by ASCII code unit for a string charset. */
  private lookup?: Int32Array;
  /**
   * The remaining value of the current block, as one big mixed-radix
   * integer: `num` while it fits a safe integer, else `big`.
   */
  private big = 0n;
  private num = 0;
  private small = true;
  private loaded = false;
  /** The current block's state bound, mirroring the encoder's exactly. */
  private bound?: BlockBound;
  private chunk?: DigitChunk;
  /** An index closes its block: any further read must start the next one. */
  private closed = false;
  /** Digit index where the current block starts. */
  private blockStart = 0;

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
      this.size = charsetSize(this.charset);
      if (typeof this.charset === 'string') {
        this.lookup = charsetLookup(this.charset);
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
      const code = this.str.charCodeAt(i);
      const digit = code < 128 ? this.lookup![code] : this.charset.indexOf(this.str.charAt(i));

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
   * base-`size` digits of the input, a chunk of digits at a time. Deferred
   * to the first parse so charset errors surface on read, not construction.
   */
  private loadBlock(start: number): void {
    const bound = (this.bound ??= new BlockBound(this.size));
    const chunk = (this.chunk ??= digitChunk(this.size));
    const size = this.size;

    const end = Math.min(start + bound.blockDigits, this.inputLength());
    const count = end - start;
    // The top chunk takes the digits left over above a whole number of them.
    let run = count % chunk.digits || Math.min(count, chunk.digits);
    let i = end;
    let num = 0;
    for (const stop = i - run; i > stop; ) {
      num = num * size + this.digitAt(--i);
    }
    if (i === start) {
      this.small = true;
      this.num = num;
    } else {
      let big = BigInt(num);
      run = chunk.digits;
      while (i > start) {
        num = 0;
        for (const stop = i - run; i > stop; ) {
          num = num * size + this.digitAt(--i);
        }
        big = big * chunk.big + BigInt(num);
      }
      this.small = false;
      this.big = big;
    }

    this.blockStart = start;
    this.loaded = true;
    this.closed = false;
    bound.reset(count);
  }

  private valueIsZero(): boolean {
    return this.small ? this.num === 0 : this.big === 0n;
  }

  /**
   * Advance the block for a symbol of `total` states: block-boundary
   * decision and truncation check, mirroring the encoder. Returns whether
   * the symbol is written as an index over `count` members: when the bucket
   * form needs more state than the digits hold but the index form fits, the
   * encoder wrote the index (it only does so for the message's last symbol).
   */
  private stepBound(total: number, count: number): boolean {
    const bound = this.bound!;

    // The encoder's greedy rule applies: a value whose total would push the
    // block's state bound past the cap lives in the next block.
    if (this.closed || bound.exceedsCap(total)) {
      // The encoder leaves no remainder at a block boundary, so leftover value
      // here means a digit was corrupted past its saturation point.
      if (!this.valueIsZero()) {
        throw new CorruptInputError('Oversaturated input');
      }

      if (this.blockStart + bound.blockDigits > this.inputLength()) {
        throw new CorruptInputError(
          'Unexpected end of input while parsing: truncated or corrupted'
        );
      }

      this.loadBlock(this.blockStart + bound.blockDigits);
    }

    // The encoder emits exactly enough digits to cover the block's digit
    // bound, which covers every bucket candidate, so needing more state
    // space than the block holds means the input is truncated or is being
    // read past its end — unless the symbol's index form fits, which is how
    // the encoder wrote it.
    if (bound.exceedsCapacity(total)) {
      if (bound.indexExceedsCapacity(total, count)) {
        throw new CorruptInputError(
          'Unexpected end of input while parsing: truncated or corrupted'
        );
      }
      this.closed = true;
      return true;
    }

    return false;
  }

  /** Peel one radix-`radix` digit off the value. */
  private divide(radix: number): number {
    if (this.small) {
      const digit = this.num % radix;
      this.num = (this.num - digit) / radix;
      return digit;
    }
    let digit: number;
    let quotient: bigint;
    const bits = log2Exact(radix);
    if (bits < 0) {
      const radixBig = BigInt(radix);
      quotient = this.big / radixBig;
      digit = Number(this.big - quotient * radixBig);
    } else {
      digit = Number(BigInt.asUintN(bits, this.big));
      quotient = this.big >> SHIFTS[bits];
    }
    if (quotient <= MAX_SAFE_BIG) {
      this.small = true;
      this.num = Number(quotient);
    } else {
      this.big = quotient;
    }
    return digit;
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
    if (!this.loaded) {
      this.loadBlock(0);
    }

    this.stepBound(radix, radix);
    this.bound!.update(radix, 1, radix);

    return this.divide(radix);
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
    if (!this.loaded) {
      this.loadBlock(0);
    }

    if (!Number.isInteger(count) || count < 1) {
      throw new TypeError(`Symbol count must be a positive integer, got ${count}`);
    }
    const members = Math.min(count, total);
    if (members < total && atIndex === undefined) {
      throw new TypeError('parseWeighted needs atIndex when count is below total');
    }
    const bound = this.bound!;

    if (this.stepBound(total, members)) {
      const index = this.divide(members);
      const [symbol, , freq] = atIndex!(index);
      // The encoder refuses zero-weight values, so one here was never written.
      if (!Number.isInteger(freq) || freq < 1) {
        throw new CorruptInputError('Index of a value with no weight');
      }
      bound.update(members, 1, members);
      return symbol;
    }

    let residual: number;
    let quotient = 0;
    let quotientBig = 0n;
    if (this.small) {
      residual = this.num % total;
      quotient = (this.num - residual) / total;
    } else {
      const bits = log2Exact(total);
      if (bits < 0) {
        const totalBig = BigInt(total);
        quotientBig = this.big / totalBig;
        residual = Number(this.big - quotientBig * totalBig);
      } else {
        residual = Number(BigInt.asUintN(bits, this.big));
        quotientBig = this.big >> SHIFTS[bits];
      }
    }
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

    bound.update(total, freq, members);
    if (this.small) {
      // A weighted step never grows the value, so it stays a safe integer.
      this.num = freq * quotient + (residual - cum);
    } else {
      const next = BigInt(freq) * quotientBig + BigInt(residual - cum);
      if (next <= MAX_SAFE_BIG) {
        this.small = true;
        this.num = Number(next);
      } else {
        this.big = next;
      }
    }

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
   * far: no leftover packed value (a digit corrupted within the input) and no
   * unread trailing digits (padding appended to it). It runs after the final read
   * to reject corrupted input that the reads themselves could not detect.
   */
  finalize(): void {
    if (!this.loaded) {
      this.loadBlock(0);
    }

    if (!this.valueIsZero()) {
      throw new CorruptInputError('Unread or corrupted data at end of input');
    }

    // No block may follow the current one, and a canonical final block spans
    // ceil(log_size(state bound)) digits — the bound in the last symbol's
    // tightest form — so its state space never reaches a full unread digit
    // beyond what the reads consumed.
    const bound = this.bound!;
    if (this.blockStart + bound.blockDigits < this.inputLength() || bound.tightFitsAnotherDigit()) {
      throw new CorruptInputError('Input is longer than its contents');
    }
  }
}
