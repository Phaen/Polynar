/**
 * The read-side packer primitive. `parse`/`parseTerm` peel values back off
 * the stream in the exact order the Encoder composed them; `finalize`
 * asserts the reads ended where the encoder's fold began. Schema nodes drive
 * this — it knows nothing about types.
 *
 * The decoder does not verify its input: that is the checksum's job. It
 * throws `CorruptInputError` only where input proves itself impossible at no
 * cost, such as a character outside the charset.
 */

import type { DecodeOptions, OutputType, Radix } from './types';
import {
  TERM_BASE,
  TERM_COUNT_RUN_DIGITS,
  TERM_INLINE_DIGITS,
  TERM_PAYLOAD_BASE,
  TERM_PAYLOAD_MIN_DIGITS,
} from './constants';
import { CorruptInputError } from './errors';
import {
  BIG_CHUNK_BITS,
  bigRadix,
  outputAlphabet,
  validateChecksum,
  validateLimit,
  checksumOf,
  type OutputAlphabet,
  radixOf,
} from './utils';
import { Span, StreamReader, TupleLocator, type Located, type Locator } from './stream';
import { MessageState } from './state';

const BIG_CHUNK_STATES = 2 ** BIG_CHUNK_BITS;
const BIG_CHUNK_SHIFT = BigInt(BIG_CHUNK_BITS);
/** The radices of a term's slots: its first, the rest of a run, and the payload digits. */
const TERM_FIRST_RADIX = (TERM_BASE + 2) as Radix;
const TERM_RUN_RADIX = (TERM_BASE + 1) as Radix;
const PAYLOAD_RADIX = TERM_PAYLOAD_BASE as Radix;
const PAYLOAD_TOP_RADIX = (TERM_PAYLOAD_BASE - 1) as Radix;
/** The longest array a JavaScript engine builds. */
const MAX_COUNT = 2 ** 32 - 1;

/** Splits the residuals of a `parseSplit` at `low`: false below it, true from it on. */
class SplitLocator implements Locator<boolean> {
  low = 0;
  total = 0;

  locate(residual: number, span: Span): boolean {
    const low = this.low;
    if (residual < low) {
      span.cum = 0;
      span.freq = low;
      return false;
    }
    span.cum = low;
    span.freq = this.total - low;
    return true;
  }
}

/** A table of members that locates its own residuals, as `parseMember` reads it. */
export interface MemberTable {
  /** The member whose bucket holds `residual`, an integer in `[0, total)`. */
  locate(residual: number): number;
  cum(pos: number): number;
  freq(pos: number): number;
}

/** Locates a residual in `table`, the `MemberTable` of the `parseMember` running. */
class MemberLocator implements Locator<number> {
  table?: MemberTable;

  locate(residual: number, span: Span): number {
    const table = this.table as MemberTable;
    const pos = table.locate(residual);
    span.cum = table.cum(pos);
    span.freq = table.freq(pos);
    return pos;
  }
}

/** `I` is the input's type, which pairs it with the matching options. */
export class Decoder<I extends Uint8Array | string = Uint8Array | string> {
  private readonly input: string | Uint8Array;
  private readonly alphabet: OutputAlphabet;
  private readonly reader: StreamReader;
  private readonly states = new MessageState();
  /** How many values may still be read past the input before the decode is refused. */
  private budget: number;
  /** The symbols read so far. */
  private reads = 0;
  /**
   * The items the length with the most still to come announced while input
   * backed the reads, and the reads before it. Each item reads at least a
   * symbol or none at all, so `announced` less the reads since is at most
   * what is still to come, but for items that read nothing.
   */
  private announced = 0;
  private announcedAt = 0;
  /** Whether the input has run out with the state at 0, for good. */
  private dry = false;
  /**
   * The locators the weighted reads wrap their arguments in, reused from read
   * to read: a locator calls nothing that reads, so one read is done with
   * them before the next takes them over.
   */
  private readonly tuples = new TupleLocator<unknown>();
  private readonly split = new SplitLocator();
  private readonly members = new MemberLocator();
  /** Where a read of a single state has its locator leave the bucket. */
  protected readonly span = new Span();

  constructor(
    input: I,
    options: DecodeOptions<
      I extends string ? 'text' : I extends Uint8Array ? 'binary' : OutputType
    > = {}
  ) {
    this.input = input;
    // The input's own form decides; `type` only pairs the options with it for TypeScript.
    this.alphabet = outputAlphabet(typeof input === 'string' ? 'text' : 'binary', options.charset);
    this.reader = new StreamReader((i) => this.digitAt(i), input.length, this.alphabet.size);
    this.budget = validateLimit(options.limit);
    const sum = validateChecksum(options.checksum);
    if (sum > 0) {
      this.verifyChecksum(sum);
    }
  }

  /** Per-message state for nodes, keyed by node identity; see `MessageState`. */
  state<S>(key: object, init: () => S): S {
    return this.states.get(key, init);
  }

  /** How many slots of the message state were dropped so far: none, as a decoder rolls nothing back. */
  get stateEpoch(): number {
    return this.states.epoch;
  }

  /** No journal: a decoder never rolls back, so its models record nothing. */
  readonly journal: undefined = undefined;

  /**
   * Announce `count` items about to be read, right after reading their
   * length. Items read once the input has run out read as zeros, and a
   * decode may read at most its `limit` of those before it throws a
   * CorruptInputError. Announced items count against it as soon as the input
   * runs out, so a length no input backs fails at once rather than item by
   * item. Values the input still backs never count.
   */
  charge(count: number): void {
    if (this.reader.drained) {
      this.dryUp();
      this.spend(count);
    } else if (count > this.outstanding()) {
      this.announced = count;
      this.announcedAt = this.reads;
    }
  }

  /** Counts one symbol read, against the limit once the input has run out. */
  private read(): void {
    this.reads++;
    if (this.reader.drained) {
      this.dryUp();
      this.spend(1);
    }
  }

  /** The announced items still to come, at most. */
  private outstanding(): number {
    return Math.max(0, this.announced - (this.reads - this.announcedAt));
  }

  /** On the first read past the input, charges the announced items still to come. */
  private dryUp(): void {
    if (!this.dry) {
      this.dry = true;
      this.spend(this.outstanding());
    }
  }

  private spend(count: number): void {
    this.budget -= count;
    if (!(this.budget >= 0)) {
      throw new CorruptInputError(
        'Input decodes to more values past its end than the decode limit allows'
      );
    }
  }

  /** The input's length in digits. */
  get digits(): number {
    return this.input.length;
  }

  /**
   * Read the `bits`-bit checksum the encoder wrote as the message's first
   * symbol and check it against the state it was folded onto and every digit
   * after the ones read for it, before any value is read.
   */
  private verifyChecksum(bits: number): void {
    const reader = this.reader;
    const stored = reader.uniform(2 ** bits);
    const start = reader.position;
    const h = checksumOf(bits, reader.state, this.input.length - start, (i) =>
      this.digitAt(start + i)
    );
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

  /** Read one value composed in a fixed radix. */
  parse(radix: number): number {
    return this.parseRadix(radixOf(radix, 'Radix'));
  }

  /**
   * Read one value composed by `composeBig` in `radix`. An index the low
   * chunks assemble at or past `radix` was never written.
   */
  parseBig(radix: bigint): bigint {
    if (radix < 1n) {
      throw new RangeError(`Radix ${radix} is not positive`);
    }
    const { chunks, top } = bigRadix(radix);
    let index = BigInt(this.parse(top));
    for (const chunk of this.parseMany(BIG_CHUNK_STATES, chunks)) {
      index = (index << BIG_CHUNK_SHIFT) | BigInt(chunk);
    }
    if (index >= radix) {
      throw new CorruptInputError('Index is outside its radix');
    }
    return index;
  }

  /** `parse` past its radix check; a `ReplayDecoder` reads it off a log instead. */
  protected parseRadix(radix: Radix): number {
    this.read();
    // The encoder records nothing for a radix-1 digit.
    if (radix === 1) {
      return 0;
    }
    return this.reader.uniform(radix);
  }

  /**
   * Read `count` values composed in the same fixed radix, exactly as that
   * many `parse(radix)` calls would.
   */
  parseMany(radix: number, count: number): number[] {
    const states = radixOf(radix, 'Radix');
    if (!Number.isInteger(count)) {
      throw new TypeError(`Count must be an integer, got ${count}`);
    }
    if (count < 0) {
      throw new RangeError(`Count ${count} is negative`);
    }
    // Radix-1 values read nothing, so only the longest array stops them.
    if (states === 1 && count > MAX_COUNT) {
      throw new RangeError(`Count ${count} exceeds the longest array, ${MAX_COUNT}`);
    }
    const digits: number[] = [];
    for (let i = 0; i < count; i++) {
      digits.push(this.parseRadix(states));
    }
    return digits;
  }

  /**
   * Read one weighted symbol composed by `composeWeighted`. `locate` maps the
   * residual in `[0, total)` to its bucket: the symbol plus the same
   * `[cum, cum + freq)` the encoder used.
   *
   * A bucket holding all `total` states carries nothing, so the encoder
   * records nothing for it and this returns its symbol without reading.
   */
  parseWeighted<T>(total: number, locate: (residual: number) => Located<T>): T {
    radixOf(total, 'Total');
    const tuples = this.tuples as TupleLocator<T>;
    tuples.find = locate;
    return this.parseLocator(total, tuples, true);
  }

  /**
   * `parseWeighted` for the packer's own models, trusted to pass a total
   * that is a radix and a `locator` that finds the bucket holding the
   * residual. A model builds its totals and buckets from the symbols read
   * before, never from the input itself, so corrupt input cannot break
   * either: checking them would catch a bug in the model, and no input.
   */
  parseLocated<T>(total: number, locator: Locator<T>): T {
    return this.parseLocator(total, locator, false);
  }

  /**
   * Read a symbol of two buckets of `total` states, `[0, low)` and
   * `[low, total)`, as `parseLocated` would: whether it is the second.
   */
  parseSplit(low: number, total: number): boolean {
    const split = this.split;
    split.low = low;
    split.total = total;
    return this.parseLocator(total, split, false);
  }

  /** Read a member of `table`, of `total` states, as `parseLocated` would: its position. */
  parseMember(total: number, table: MemberTable): number {
    const members = this.members;
    members.table = table;
    return this.parseLocator(total, members, false);
  }

  /** A weighted read, the bucket found checked against its residual when `checked`. */
  protected parseLocator<T>(total: number, locator: Locator<T>, checked: boolean): T {
    this.read();
    // A single state is a bucket holding every state.
    if (total === 1) {
      return locator.locate(0, this.span);
    }
    return this.reader.weighted(total, locator, checked);
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
   * Assert the reads ended where the encoder's fold began: every digit read,
   * and the state back at 0. Anything else proves the input is not what the
   * reads describe: a digit corrupted within it, padding appended to it, or
   * values written that were never read. Reads past the last written value
   * return 0 and leave both as they are, so they pass.
   */
  finalize(): void {
    const reader = this.reader;
    if (reader.state !== 0n) {
      throw new CorruptInputError('Unread or corrupted data at end of input');
    }
    if (reader.position < this.input.length) {
      throw new CorruptInputError('Input is longer than its contents');
    }
  }
}
