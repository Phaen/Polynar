/**
 * Decoder class for Polynar
 */

import type { Charset, EncodingOptions, Decoder as IDecoder } from './types';
import { DEFAULT_BASE } from './constants';
import { validateOptions, validateCharset, blockCapacity, isArray } from './utils';
import { modules } from './modules/registry';

/**
 * Decoder class
 */
export class Decoder implements IDecoder {
  str: string;
  charset: Charset;
  size: number;
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
        throw new Error('Oversaturated input');
      }

      if (this.blockStart + this.block!.digits >= this.inputLength()) {
        throw new Error('Unexpected end of input while parsing');
      }

      this.loadBlock(this.blockStart + this.block!.digits);
      consumed = radixBig;
    }

    // The encoder emits exactly enough digits to cover the block's radix
    // product, so needing more state space than the block holds means the
    // input is truncated or is being read past its end.
    if (consumed > this.capacity!) {
      throw new Error('Unexpected end of input while parsing');
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
      throw new Error('Oversaturated input');
    }

    return Number(integer);
  }

  parseTerm(): number {
    // Accumulate in BigInt: float addition above 2^53 rounds, and the encoder
    // packs such terms bit-exact. Number() converts the total back to the
    // nearest double, which is exact for any term composeTerm accepted.
    const base = BigInt(DEFAULT_BASE);
    let integer = 0n;
    let pow = 1n;
    let md = this.parse(DEFAULT_BASE + 1) - 1;
    while (md !== -1) {
      integer += BigInt(md) * pow;
      pow *= base;
      md = this.parse(DEFAULT_BASE + 1) - 1;
    }
    return Number(integer);
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
      throw new Error('Unread or corrupted data at end of input');
    }

    // No block may follow the current one, and a canonical final block spans
    // ceil(log_size(radix product)) digits, so its state space never reaches
    // a full unread digit beyond what the reads consumed.
    if (
      this.blockStart + this.block!.digits < this.inputLength() ||
      this.consumed * BigInt(this.size) <= this.capacity!
    ) {
      throw new Error('Input is longer than its contents');
    }
  }

  read(options: EncodingOptions, count: number = 1): any {
    if (typeof count !== 'number' || count % 1 !== 0 || count < 0) {
      throw new TypeError('Count must be a non-negative integer');
    }

    const validatedOptions = validateOptions(options);

    // A `limit` read recovers a length-prefixed array, so it must always return
    // an array. Never unwrap it, even when the decoded length happens to be 1.
    // Presence check, not truthiness: `limit: 0` is a valid cap of zero.
    const limited = validatedOptions.limit != null;
    if (limited) {
      count = this.parse((validatedOptions.limit as number) + 1);
    }

    let items = modules[validatedOptions.type].decoder.call(this, validatedOptions, count);

    if (typeof validatedOptions.postProc === 'function') {
      for (let i = 0; i < items.length; i++) {
        items[i] = validatedOptions.postProc(items[i]);
      }
    }

    if (count === 1 && !limited) {
      items = items.pop();
    }

    return items;
  }
}
