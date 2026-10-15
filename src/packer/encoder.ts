/**
 * The write-side packer primitive. Values are pushed as (integer, radix)
 * pairs via `compose`/`composeTerm`, or as weighted symbols via
 * `composeWeighted`, into a log of buckets; `output` folds the log into
 * digits. Schema nodes drive this — it knows nothing about types.
 *
 * The fold is the streaming rANS of `StreamWriter`: a weighted symbol owning
 * `freq` of `total` states costs log2(total/freq) bits, because the position
 * inside its bucket carries the next value's information instead of being
 * wasted. A uniform slot is the case freq = 1, which reduces the update to
 * plain multiply-add, which is mixed-radix arithmetic. The log keeps each
 * symbol's bucket and whether it is uniform or weighted, which is all the
 * fold needs; until `output`, a slot can still be patched.
 */

import type { Bucket, CodecOptions, OutputType, Radix } from './types';
import {
  TERM_BASE,
  TERM_ESCAPE_MIN,
  TERM_PAYLOAD_BASE,
  TERM_PAYLOAD_MIN_DIGITS,
} from './constants';
import {
  BIG_CHUNK_BITS,
  ScaledRatio,
  bigRadix,
  outputAlphabet,
  validateChecksum,
  checksumOf,
} from './utils';
import { StreamWriter } from './stream';
import { MessageState, checkKey } from './state';

const ONE = 1 as Radix;
const BIG_CHUNK_STATES = 2 ** BIG_CHUNK_BITS;

/** Rejects a bucket `[cum, cum + freq)` that does not lie in `[0, total)` or is empty. */
function checkBucket(cum: number, freq: number, total: number): void {
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
}

/** A symbol written as one of its group's alternative buckets, waiting for the group's choice. */
interface Alternative {
  /** The symbol's slot in the buffer. */
  at: number;
  group: object;
  buckets: readonly Bucket[];
}

export class Encoder {
  private cums: number[] = [];
  private freqs: Radix[] = [];
  private totals: Radix[] = [];
  /** Whether each symbol is weighted, read by `parseWeighted`, rather than a uniform slot. */
  private weighted: boolean[] = [];
  private readonly states = new MessageState();
  /**
   * The groups opened by `composeSelector`: the selector's slot in the
   * buffer, -1 when it carries nothing (a single coding whose bucket holds
   * every state), and the selector's bucket under each coding.
   */
  private readonly groups = new Map<object, { at: number; choices: readonly Bucket[] }>();
  /** The alternative symbols written since the last `output`, in buffer order. */
  private pending: Alternative[] = [];

  /** Per-message state for nodes, keyed by node identity; see `MessageState`. */
  state<S>(key: object, init: () => S): S {
    return this.states.get(key, init);
  }

  /** Push one value in a fixed radix: `integer` must lie in `[0, radix)`. */
  compose(integer: number, radix: number): void {
    // An out-of-range value would not throw on its own; it would silently
    // corrupt every value packed after it, so it fails here, at the source.
    // The same check as `radixOf`, inline: compose runs once per value, and
    // the call measurably slows it.
    if (!Number.isInteger(radix)) {
      throw new TypeError(`Radix must be an integer, got ${radix}`);
    }
    if (radix < 1 || radix > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Radix ${radix} is not a positive safe integer`);
    }
    const states = radix as Radix;
    if (!Number.isInteger(integer)) {
      throw new TypeError(`Digit must be an integer, got ${integer}`);
    }
    if (integer < 0 || integer >= radix) {
      throw new RangeError(`Digit ${integer} is outside [0, ${radix})`);
    }
    // A radix-1 digit carries nothing, and the fold takes no bucket that
    // holds every state.
    if (radix === 1) {
      return;
    }

    this.cums.push(integer);
    this.freqs.push(ONE);
    this.totals.push(states);
    this.weighted.push(false);
  }

  /**
   * Push one value in a radix of any size: `index` must lie in
   * `[0, radix)`. A safe radix is one `compose`; a larger one is a top digit
   * and low chunks, most significant first, as `bigRadix` lays them out.
   */
  composeBig(index: bigint, radix: bigint): void {
    if (radix < 1n) {
      throw new RangeError(`Radix ${radix} is not positive`);
    }
    if (index < 0n || index >= radix) {
      throw new RangeError(`Digit ${index} is outside [0, ${radix})`);
    }
    const { chunks, top } = bigRadix(radix);
    this.compose(Number(index >> BigInt(BIG_CHUNK_BITS * chunks)), top);
    for (let i = chunks - 1; i >= 0; i--) {
      this.compose(
        Number(BigInt.asUintN(BIG_CHUNK_BITS, index >> BigInt(BIG_CHUNK_BITS * i))),
        BIG_CHUNK_STATES
      );
    }
  }

  /**
   * Push one weighted symbol: the bucket `[cum, cum + freq)` out of `total`
   * states. Costs log2(total/freq) bits — fractional, exact. The decoder
   * recovers the symbol from which bucket the residual lands in, so both
   * sides must derive identical integer tables.
   */
  composeWeighted(cum: number, freq: number, total: number): void {
    checkBucket(cum, freq, total);
    // A bucket holding every state carries nothing, like a radix-1 digit.
    if (freq === total) {
      return;
    }

    // Total is a radix, and freq lies in [1, total).
    this.cums.push(cum);
    this.freqs.push(freq as Radix);
    this.totals.push(total as Radix);
    this.weighted.push(true);
  }

  /**
   * Open a choice among codings for `group`, the node that spells its
   * symbols more than one way (a static prior and an adaptive one, say).
   * `choices[i]` is the bucket the selector is written as under coding i;
   * the buckets share one total, and coding i is member i among
   * `choices.length`. The node writes the selector once,
   * before the group's first symbol, then each symbol through
   * `composeAlternatives` as the bucket every coding gives it. At `output`
   * the encoder keeps the coding whose selector and symbols cost the fewest
   * bits, the lowest index on a tie, and writes its bucket as the selector.
   * The decoder reads the selector as the weighted symbol it is, and then
   * knows how to read the rest. A group is opened at most once per message.
   */
  composeSelector(group: object, choices: readonly Bucket[]): void {
    checkKey(group, 'Group');
    if (this.groups.has(group)) {
      throw new TypeError('Group already has a selector');
    }
    const count = choices.length;
    if (count === 0) {
      throw new RangeError('Selector needs at least one coding');
    }
    const total = choices[0][2];
    for (const [cum, freq, t] of choices) {
      checkBucket(cum, freq, t);
      if (t !== total) {
        throw new RangeError(`Selector buckets share one total, got ${t} after ${total}`);
      }
      if (count > 1 && freq === t) {
        throw new RangeError(`Selector bucket [${cum}, ${cum + freq}) holds every state`);
      }
    }
    // The placeholder is the selector for coding 0; `resolve` patches in the
    // choice. A lone coding whose bucket holds every state records nothing,
    // like any radix-1 digit.
    const before = this.totals.length;
    const [cum, freq] = choices[0];
    this.composeWeighted(cum, freq, total);
    this.groups.set(group, { at: this.totals.length > before ? before : -1, choices });
  }

  /**
   * Push one symbol of the group opened by `composeSelector`, as the bucket
   * each coding gives it: `buckets[i]` is the symbol under coding i. Every
   * bucket carries information, so the symbol takes a slot whichever coding
   * wins.
   */
  composeAlternatives(group: object, buckets: readonly Bucket[]): void {
    const opened = this.groups.get(group);
    if (opened === undefined) {
      throw new TypeError('Group has no selector');
    }
    if (buckets.length !== opened.choices.length) {
      throw new TypeError(
        `Group has ${opened.choices.length} codings, got ${buckets.length} alternative buckets`
      );
    }
    for (const [cum, freq, total] of buckets) {
      checkBucket(cum, freq, total);
      if (freq === total) {
        throw new RangeError(`Alternative bucket [${cum}, ${cum + freq}) holds every state`);
      }
    }

    // The placeholder carries coding 0's bucket until `resolve` patches in the choice.
    const [cum, freq, total] = buckets[0];
    this.cums.push(cum);
    this.freqs.push(freq as Radix);
    this.totals.push(total as Radix);
    this.weighted.push(true);
    this.pending.push({ at: this.totals.length - 1, group, buckets });
  }

  /**
   * Settle every group with alternatives pending: pick its cheapest coding,
   * patch the choice into its selector and its symbols' slots. Groups
   * without alternatives keep coding 0, which their selector already holds.
   */
  private resolve(): void {
    const symbols = new Map<object, Alternative[]>();
    for (const alternative of this.pending) {
      const list = symbols.get(alternative.group);
      if (list === undefined) {
        symbols.set(alternative.group, [alternative]);
      } else {
        list.push(alternative);
      }
    }
    for (const [group, { at, choices }] of this.groups) {
      const list = symbols.get(group);
      if (list === undefined) {
        continue;
      }
      // ratios[i] is coding i's probability product over coding 0's, its
      // selector included; the largest ratio costs the fewest bits. Coding
      // 0's own ratio is 1.
      const count = choices.length;
      const ratios = Array.from({ length: count }, () => new ScaledRatio());
      for (let i = 1; i < count; i++) {
        ratios[i].multiply(choices[i][1], choices[0][1]);
      }
      for (const { buckets } of list) {
        const [, freq0, total0] = buckets[0];
        for (let i = 1; i < count; i++) {
          const [, freq, total] = buckets[i];
          ratios[i].multiply(freq * total0, total * freq0);
        }
      }
      let chosen = 0;
      for (let i = 1; i < count; i++) {
        if (ratios[i].exceeds(ratios[chosen])) {
          chosen = i;
        }
      }

      if (at >= 0) {
        const [cum, freq, total] = choices[chosen];
        this.cums[at] = cum;
        this.freqs[at] = freq as Radix;
        this.totals[at] = total as Radix;
      }
      for (const { at: slot, buckets } of list) {
        const [cum, freq, total] = buckets[chosen];
        this.cums[slot] = cum;
        this.freqs[slot] = freq as Radix;
        this.totals[slot] = total as Radix;
      }
    }
    this.pending = [];
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
   * `value` is a non-negative integer, so the run ends; `firstRadix` is
   * TERM_BASE + 1 or TERM_BASE + 2.
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
   * The log folded into base-`size` digits by `StreamWriter`, in reverse,
   * so the decoder can peel the values off front to back, which it needs
   * because later radices can depend on earlier decoded values (an array's
   * length prefix, say).
   *
   * A checksum of `sum` bits is the message's first symbol, a uniform slot
   * of 2^sum states, so it is folded last. Its value covers the state it
   * folds onto and every digit emitted before it, which is everything the
   * decoder reads after it; emitting for it does not depend on its value, so
   * it is taken once that emission is done.
   */
  private toDigits(size: number, sum: number): number[] {
    const { cums, freqs, totals, weighted } = this;
    const writer = new StreamWriter(size);
    for (let i = totals.length - 1; i >= 0; i--) {
      writer.push(cums[i], freqs[i], totals[i], weighted[i]);
    }
    if (sum > 0) {
      const radix = 2 ** sum;
      writer.renormalise(1, radix);
      const count = writer.count;
      const h = checksumOf(sum, writer.state, count, (i) => writer.emittedAt(i));
      writer.push(h, 1, radix, false);
    }
    return writer.digits();
  }

  /** The message as bytes, or as text when `type` is `'text'`. */
  output(options: CodecOptions<'text'> & { type: 'text' }): string;
  output(options?: CodecOptions<'binary'>): Uint8Array;
  output(options?: CodecOptions<OutputType>): Uint8Array | string;
  output(options: CodecOptions<OutputType> = {}): Uint8Array | string {
    const type = options.type ?? 'binary';
    const alphabet = outputAlphabet(type, options.charset);
    this.resolve();
    const digits = this.toDigits(alphabet.size, validateChecksum(options.checksum));

    if (type === 'text') {
      let str = '';
      for (const digit of digits) {
        str += alphabet.charAt(digit);
      }
      return str;
    }

    return alphabet.bytesOf(digits);
  }
}
