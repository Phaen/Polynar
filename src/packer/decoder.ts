/**
 * The read-side packer primitive. `parse`/`parseTerm` peel values back off the
 * mixed-radix blocks in the exact order the Encoder composed them; `finalize`
 * asserts the input was exactly consumed. Schema nodes drive this — it knows
 * nothing about types.
 */

import type { Base, CodecOptions, OutputType, Radix } from './types';
import {
  TERM_BASE,
  TERM_COUNT_RUN_DIGITS,
  TERM_INLINE_DIGITS,
  TERM_PAYLOAD_BASE,
  TERM_PAYLOAD_MIN_DIGITS,
} from './constants';
import { CorruptInputError } from './errors';
import {
  outputAlphabet,
  validateBlockBits,
  validateChecksum,
  checksumOf,
  type OutputAlphabet,
  digitChunk,
  log2Exact,
  radixOf,
  SHIFTS,
  type DigitChunk,
} from './utils';
import { BlockBound } from './bound';
import { MessageState } from './state';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIG = BigInt(MAX_SAFE);
const ONE = 1 as Radix;
/** The radices of a term's slots: its first, the rest of a run, and the payload digits. */
const TERM_FIRST_RADIX = (TERM_BASE + 2) as Radix;
const TERM_RUN_RADIX = (TERM_BASE + 1) as Radix;
const PAYLOAD_RADIX = TERM_PAYLOAD_BASE as Radix;
const PAYLOAD_TOP_RADIX = (TERM_PAYLOAD_BASE - 1) as Radix;
/** The longest array a JavaScript engine builds. */
const MAX_COUNT = 2 ** 32 - 1;

/** `I` is the input's type, which pairs it with the matching options. */
export class Decoder<I extends Uint8Array | string = Uint8Array | string> {
  private readonly input: string | Uint8Array;
  private readonly alphabet: OutputAlphabet;
  private readonly size: Base;
  /**
   * The remaining value of the current block, as one big mixed-radix
   * integer: `num` while it fits a safe integer, else `big`.
   */
  private big = 0n;
  private num = 0;
  private small = true;
  /** The current block's state bound, mirroring the encoder's exactly. */
  private readonly bound: BlockBound;
  private readonly chunk: DigitChunk;
  /** Digit index where the current block starts. */
  private blockStart = 0;
  private readonly states = new MessageState();

  constructor(
    input: I,
    options: CodecOptions<
      I extends string ? 'text' : I extends Uint8Array ? 'binary' : OutputType
    > = {}
  ) {
    this.input = input;
    // The input's own form decides; `type` only pairs the options with it for TypeScript.
    this.alphabet = outputAlphabet(typeof input === 'string' ? 'text' : 'binary', options.charset);
    this.size = this.alphabet.size;
    this.bound = new BlockBound(this.size, validateBlockBits(options.blockBits));
    this.chunk = digitChunk(this.size);
    this.loadBlock(0);
    const sum = validateChecksum(options.checksum);
    if (sum > 0) {
      this.verifyChecksum(sum);
    }
  }

  /** Per-message state for nodes, keyed by node identity; see `MessageState`. */
  state<S>(key: object, init: () => S): S {
    return this.states.get(key, init);
  }

  /**
   * Read the `bits`-bit checksum the encoder wrote as the first block's
   * first symbol and check it against the rest of the input, before any
   * value is read. A first block without room for it, the empty input
   * among them, is corrupt.
   */
  private verifyChecksum(bits: number): void {
    const radix = (2 ** bits) as Radix;
    const bound = this.bound;
    if (bound.exceedsCapacity(radix)) {
      throw new CorruptInputError('Input is too short to hold its checksum');
    }
    bound.update(radix, ONE, radix);
    const stored = this.divide(radix);
    const length = this.input.length;
    const end = Math.min(bound.blockDigits, length);
    const value = this.small ? this.num : this.big;
    const h = checksumOf(bits, value, length, length - end, (i) => this.digitAt(end + i));
    if (h !== stored) {
      throw new CorruptInputError('Checksum mismatch: corrupted input');
    }
  }

  /** Digit value of the input at position `i`, in [0, input.length), validated against the charset. */
  private digitAt(i: number): number {
    const input = this.input;
    const text = typeof input === 'string';
    const digit = this.alphabet.digitOf(text ? input.charCodeAt(i) : input[i]);
    if (digit === -1) {
      throw new CorruptInputError(
        (text ? 'Character' : 'Byte') + ' at ' + i + ' is not in the charset'
      );
    }
    return digit;
  }

  /**
   * Rebuild one block of the encoder's mixed-radix packing from the
   * base-`size` digits of the input, a chunk of digits at a time. `start`
   * is a block boundary, a multiple of the block's digits no further than
   * the input's end.
   */
  private loadBlock(start: number): void {
    const bound = this.bound;
    const chunk = this.chunk;
    const size = this.size;

    const end = Math.min(start + bound.blockDigits, this.input.length);
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
   * `count` is at most `total`.
   */
  private stepBound(total: Radix, count: Radix): boolean {
    const bound = this.bound;

    // The encoder's greedy rule applies: a value whose total would push the
    // block's state bound past the cap lives in the next block.
    if (bound.exceedsCap(total)) {
      // The encoder leaves no remainder at a block boundary, so leftover value
      // here means a digit was corrupted past its saturation point.
      if (!this.valueIsZero()) {
        throw new CorruptInputError('Oversaturated input');
      }

      if (this.blockStart + bound.blockDigits > this.input.length) {
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
      return true;
    }

    return false;
  }

  /** Peel one radix-`radix` digit off the value. */
  private divide(radix: Radix): number {
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
    return this.parseRadix(radixOf(radix, 'Radix'));
  }

  /** `parse` past its radix check. */
  private parseRadix(radix: Radix): number {
    // The encoder records nothing for a radix-1 digit.
    if (radix === 1) {
      return 0;
    }

    this.stepBound(radix, radix);
    this.bound.update(radix, ONE, radix);

    return this.divide(radix);
  }

  /**
   * Read `count` values composed in the same fixed radix, exactly as that
   * many `parse(radix)` calls would. Within a block the digits peel off a
   * chunk at a time, one division by the chunk's power of the radix; the
   * digit at a block boundary or at the end of the input goes through
   * `parse`, which makes the same decisions and throws the same errors.
   */
  parseMany(radix: number, count: number): number[] {
    const states = radixOf(radix, 'Radix');
    if (!Number.isInteger(count)) {
      throw new TypeError(`Count must be an integer, got ${count}`);
    }
    if (count < 0) {
      throw new RangeError(`Count ${count} is negative`);
    }
    const digits: number[] = [];
    // Values of a larger radix run out of input long before an array of
    // them outgrows its limit; radix-1 values read nothing, so only the
    // limit stops them.
    if (states === 1) {
      if (count > MAX_COUNT) {
        throw new RangeError(`Count ${count} exceeds the longest array, ${MAX_COUNT}`);
      }
      for (let i = 0; i < count; i++) {
        digits.push(0);
      }
      return digits;
    }
    while (digits.length < count) {
      const run = this.bound.fold(states, count - digits.length);
      if (run > 0) {
        this.divideRun(states, run, digits);
      }
      if (digits.length < count) {
        digits.push(this.parseRadix(states));
      }
    }
    return digits;
  }

  /**
   * Peel `run` radix-`radix` digits off the value onto `out`, lowest first.
   * `radix` is at least 2, and the bound has folded the `run` digits.
   */
  private divideRun(radix: Radix, run: number, out: number[]): void {
    if (!this.small) {
      const chunk = digitChunk(radix);
      while (run > 0 && !this.small) {
        const k = Math.min(run, chunk.digits);
        const whole = k === chunk.digits;
        let rest: number;
        let quotient: bigint;
        const bits = log2Exact(radix) * k;
        if (bits > 0) {
          rest = Number(BigInt.asUintN(bits, this.big));
          quotient = this.big >> SHIFTS[bits];
        } else {
          const pow = whole ? chunk.big : BigInt(radix ** k);
          quotient = this.big / pow;
          rest = Number(this.big - quotient * pow);
        }
        for (let i = 0; i < k; i++) {
          const digit = rest % radix;
          rest = (rest - digit) / radix;
          out.push(digit);
        }
        if (quotient <= MAX_SAFE_BIG) {
          this.small = true;
          this.num = Number(quotient);
        } else {
          this.big = quotient;
        }
        run -= k;
      }
    }
    let num = this.num;
    for (; run > 0; run--) {
      const digit = num % radix;
      num = (num - digit) / radix;
      out.push(digit);
    }
    this.num = num;
  }

  /**
   * Read one weighted symbol composed by `composeWeighted`. `locate` maps the
   * residual in `[0, total)` to its bucket: the symbol plus the same
   * `[cum, cum + freq)` the encoder used. The block-boundary decision is made
   * freq-blind (mirroring the encoder, which cannot assume the decoder knows
   * the symbol yet); the state bound then updates with the true freq.
   *
   * `position` describes the node's members in bucket order, as
   * `composeWeighted` received them: `count` of them, and `at(i)` the triple
   * `locate` returns for the i-th. The message's last symbol may be written
   * as that index rather than a bucket; the digit count tells which.
   *
   * A bucket holding all `total` states carries nothing, so the encoder
   * records nothing for it and this returns its symbol without reading. Such
   * a bucket is recognised by both ends of the residual range landing on its
   * symbol: a user cdf that goes down somewhere can hand a full-width bucket
   * to one end only, and then a symbol was written and must be read.
   */
  parseWeighted<T>(
    total: number,
    locate: (residual: number) => readonly [T, number, number],
    position?: { count: number; at: (index: number) => readonly [T, number, number] }
  ): T {
    const states = radixOf(total, 'Total');
    const count = position === undefined ? states : position.count;
    const at = position === undefined ? locate : position.at;
    if (!Number.isInteger(count) || count < 1) {
      throw new TypeError(`Symbol count must be a positive integer, got ${count}`);
    }
    const members = (count < states ? count : states) as Radix;
    const bound = this.bound;

    // Only at a block boundary or past the block's digits does the bound step
    // change state before the residual is known, so only there is a
    // zero-information symbol told apart up front. Elsewhere its own bucket,
    // found from the untouched value, tells it apart.
    if (bound.exceedsCap(states) || bound.exceedsCapacity(states)) {
      const only = locate(0);
      if (only[2] === total && locate(total - 1)[0] === only[0]) {
        return only[0];
      }
      if (this.stepBound(states, members)) {
        const index = this.divide(members);
        const [symbol, , freq] = at(index);
        // The encoder refuses zero-weight values, so one here was never written.
        if (!Number.isInteger(freq) || freq < 1) {
          throw new CorruptInputError('Index of a value with no weight');
        }
        // Folded in at its full total, the index leaves the block's digits no
        // room for another symbol, so a read past it fails as truncated input.
        // The tight bound is the index form's either way.
        bound.update(states, ONE, members);
        return symbol;
      }
    }

    let residual: number;
    let quotient = 0;
    let quotientBig = 0n;
    if (this.small) {
      residual = this.num % total;
      quotient = (this.num - residual) / total;
    } else {
      const bits = log2Exact(states);
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
    if (freq === total) {
      return symbol;
    }

    // The check above leaves freq an integer in [1, total).
    bound.update(states, freq as Radix, members);
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
    const first = this.parseRadix(TERM_FIRST_RADIX);

    if (first !== TERM_BASE + 1) {
      return this.parseRun(first, TERM_INLINE_DIGITS);
    }

    // Escaped: digit count (offset by its known minimum), then the digits,
    // reassembled in BigInt so terms above 2^53 round-trip bit-exact.
    const count =
      TERM_PAYLOAD_MIN_DIGITS +
      this.parseRun(this.parseRadix(TERM_RUN_RADIX), TERM_COUNT_RUN_DIGITS);
    const base = BigInt(TERM_PAYLOAD_BASE);
    let value = 0n;
    let pow = 1n;
    for (let i = 0; i < count - 1; i++) {
      value += BigInt(this.parseRadix(PAYLOAD_RADIX)) * pow;
      pow *= base;
    }
    value += BigInt(this.parseRadix(PAYLOAD_TOP_RADIX) + 1) * pow;

    // The encoder only emits values a double represents exactly.
    const integer = Number(value);
    if (!Number.isFinite(integer) || BigInt(integer) !== value) {
      throw new CorruptInputError('Escaped term is not an exactly representable integer');
    }
    return integer;
  }

  /**
   * Continue a terminated base-TERM_BASE run whose first symbol the caller
   * already consumed. `maxDigits` caps the run: the encoder never emits a
   * longer one, and within the cap the arithmetic stays exact. `symbol` is
   * a slot's read, in [0, TERM_BASE + 1].
   */
  private parseRun(symbol: number, maxDigits: number): number {
    let integer = 0;
    let pow = 1;
    let count = 0;

    while (symbol !== 0) {
      if (++count > maxDigits) {
        throw new CorruptInputError('Term run is longer than its maximum');
      }
      integer += (symbol - 1) * pow;
      pow *= TERM_BASE;
      symbol = this.parseRadix(TERM_RUN_RADIX);
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
    if (!this.valueIsZero()) {
      throw new CorruptInputError('Unread or corrupted data at end of input');
    }

    // No block may follow the current one, and a canonical final block spans
    // ceil(log_size(state bound)) digits — the bound in the last symbol's
    // tightest form — so its state space never reaches a full unread digit
    // beyond what the reads consumed.
    const bound = this.bound;
    if (this.blockStart + bound.blockDigits < this.input.length || bound.tightFitsAnotherDigit()) {
      throw new CorruptInputError('Input is longer than its contents');
    }
  }
}
