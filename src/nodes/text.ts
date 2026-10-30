/**
 * The codecs behind `p.string` and `p.binary`. The plain one writes a length
 * prefix, then one symbol per item from a fixed table, each priced uniformly
 * or by a static prior per row, and followed by whatever the symbol does not
 * carry. The alphabet decides what the items are and how they map to
 * symbols. Under `.compress()` the items go to the similarity predictor
 * (`../predictor`) instead, the value's end one more symbol after them.
 */
import { Encoder, Decoder, CorruptInputError, COST_UNITS } from '../packer';
import { session } from '../predictor/session';
import type { AlphabetKind, Ends, Resolved } from '../predictor/types';
import { Exclusion, readExcluded, staticTable, writeExcluded, type Table } from './excluded';
import { IndexRange, lengthRange, type LengthBounds } from './lattice';
import { GAMMA_MAGNITUDE } from './magnitude';
import { members, type Members } from './members';
import { buildWeights, checkIndex } from './weights';
import type { Run } from './base';

/**
 * An alphabet a sequence is spelled in: how a value becomes items
 * (integers), how an item becomes a symbol of the table with an optional
 * tail, and which row the next symbol is priced in.
 */
export interface Symbols<T> {
  /** The node, as errors name it: `p.string`, `p.binary`. */
  readonly who: string;
  /** Members of the symbol table. */
  readonly size: number;
  /** The static prior over the symbols, one weight list per row; undefined means uniform in one row. */
  readonly rows?: readonly (readonly number[])[];
  /** The row of the first item of each value. */
  readonly start: number;
  /** The quantity the length prefix counts, as its errors name it: `length`. */
  readonly noun: string;
  /** One item, as the overrun error names it: `code point`, `character`, `byte`. */
  readonly item: string;
  /** Whether every item is its symbol, with nothing written after it. */
  readonly tailless: boolean;
  /** What the length prefix carries. */
  count(value: T): number;
  /** The units the items of a value with the length prefix `count` add up to. */
  span(count: number): number;
  /** Refuses a length prefix `count` no value was written with; called right after it is read. */
  check?(count: number): void;
  /** The items in write order; throws the alphabet's own error for a value it cannot spell. */
  items(value: T): number[];
  /** How much of the span `item` consumes. */
  units(item: number): number;
  /** The table symbol of `item`, in `[0, size)`. */
  symbol(item: number): number;
  /** Writes whatever `symbol` does not carry of `item`. */
  tail(enc: Encoder, item: number, symbol: number): void;
  /** The inverse probability of the tail `tail` writes for `item`: 1 when it writes none. */
  tails(item: number, symbol: number): number;
  /** The item back from its symbol and the tail `tail` wrote. */
  untail(dec: Decoder, symbol: number): number;
  /** The row the item after `item` is priced in. */
  row(item: number): number;
  /** The value of the items. */
  build(items: number[]): T;
  /**
   * The least symbol of an item that a value above another in UTF-16 code
   * unit order can hold where the two first differ, `item` being the
   * other's there; left out, or undefined for an item, where the symbols
   * do not follow that order.
   */
  above?(item: number): number | undefined;
  /** The value as a length error names it: `String length 7`. */
  subject(value: T): string;
}

/** The units of the first `count` items of `lead`. */
function unitsOf<T>(symbols: Symbols<T>, lead: readonly number[], count: number): number {
  let units = 0;
  for (let k = 0; k < count; k++) {
    units += symbols.units(lead[k]);
  }
  return units;
}

/** The row of the item after `lead`, the start a value shares with the one before it: the start row when it shares none. */
const rowAfter = <T>(symbols: Symbols<T>, lead: readonly number[]): number =>
  lead.length === 0 ? symbols.start : symbols.row(lead[lead.length - 1]);

/**
 * What is known of the symbol of a value's first item after the start it
 * shares with another: a symbol it is not, and the least it can be.
 */
interface First {
  readonly except?: number;
  readonly floor?: number;
}

/**
 * Refuses a value read past `2 * span` items, `count` so far: an item may
 * take no units (a prose shift), but never two in a row, so no value written
 * holds more, and corrupt input could otherwise read zero-unit items without
 * end.
 */
function bounded(count: number, span: number): void {
  if (count > 2 * span) {
    throw new CorruptInputError(`More items than twice the length ${span}`);
  }
}

/** The symbols at the alphabet's static odds with one of them ruled out. */
class Excepting {
  private readonly tables: readonly Table[];
  private readonly exclusion: Exclusion;

  constructor({ who, size, rows }: Symbols<unknown>) {
    this.tables = (rows ?? [new Array<number>(size).fill(1)]).map((weights) =>
      staticTable(buildWeights(weights, size, who))
    );
    this.exclusion = new Exclusion(size);
  }

  /** The exclusion of `except` alone. */
  private ruling(except: number): Exclusion {
    const exclusion = this.exclusion;
    exclusion.clear();
    exclusion.add(except);
    return exclusion;
  }

  // Every row comes from the alphabet's `start` or `row`, each one of its rows.
  write(enc: Encoder, sym: number, row: number, except: number): void {
    writeExcluded(enc, this.tables[row], this.ruling(except), sym);
  }

  read(dec: Decoder, row: number, except: number): number {
    return readExcluded(dec, this.tables[row], this.ruling(except));
  }
}

/**
 * The items one symbol each at the alphabet's static odds, each followed by
 * its tail. A first symbol with a floor is spelled among those from it
 * where every symbol is alike, else one with a symbol ruled out among the
 * rest at the same odds.
 */
class Spelled<T> {
  /** Set when a value's symbols read as one run: uniform and tailless. */
  private readonly fast: boolean;
  /** The first symbols with one ruled out, built on first use. */
  private excluding?: Excepting;

  constructor(
    private readonly symbols: Symbols<T>,
    private readonly spelling: Members
  ) {
    this.fast = symbols.tailless && spelling.radix !== undefined;
  }

  private literals(): Excepting {
    return (this.excluding ??= new Excepting(this.symbols));
  }

  /** Writes the first symbol, known as `first`, in `row`. */
  private writeFirst(enc: Encoder, symbol: number, row: number, { except, floor }: First): void {
    const { radix } = this.spelling;
    if (floor !== undefined && radix !== undefined) {
      enc.compose(symbol - floor, radix - floor);
    } else if (except !== undefined) {
      this.literals().write(enc, symbol, row, except);
    } else {
      this.spelling.write(enc, symbol, row);
    }
  }

  /** Reads a first symbol `writeFirst` wrote. */
  private readFirst(dec: Decoder, row: number, { except, floor }: First): number {
    const { radix } = this.spelling;
    if (floor !== undefined && radix !== undefined) {
      if (floor >= radix) {
        throw new CorruptInputError(`No symbol lies at or above ${floor}`);
      }
      return floor + dec.parse(radix - floor);
    }
    return except !== undefined
      ? this.literals().read(dec, row, except)
      : this.spelling.read(dec, row);
  }

  /**
   * Writes `items` after `lead`, the start the value shares with another,
   * already known to both sides: the first is priced as the item after it,
   * and what `first` knows of its symbol is ruled out.
   */
  write(enc: Encoder, items: readonly number[], lead: readonly number[], first?: First): void {
    const { symbols, spelling } = this;
    let row = rowAfter(symbols, lead);
    for (let k = 0; k < items.length; k++) {
      const item = items[k];
      const symbol = symbols.symbol(item);
      if (k === 0 && first !== undefined) {
        this.writeFirst(enc, symbol, row, first);
      } else {
        spelling.write(enc, symbol, row);
      }
      symbols.tail(enc, item, symbol);
      row = symbols.row(item);
    }
  }

  /** Reads items after `lead` until their units reach `span`; returns them and the units they add up to. */
  read(dec: Decoder, span: number, lead: readonly number[], first?: First): [number[], number] {
    const { symbols, spelling } = this;
    if (this.fast && first === undefined) {
      return [dec.parseMany(symbols.size, span), span];
    }
    const items: number[] = [];
    let units = 0;
    let row = rowAfter(symbols, lead);
    while (units < span) {
      bounded(items.length, span);
      const symbol =
        items.length === 0 && first !== undefined
          ? this.readFirst(dec, row, first)
          : spelling.read(dec, row);
      const item = symbols.untail(dec, symbol);
      items.push(item);
      units += symbols.units(item);
      row = symbols.row(item);
    }
    return [items, units];
  }
}

/**
 * What a run's value is known to be against the one before it, by its
 * items: nothing (`any`), not below it (`sorted`), or above it (`unique`).
 */
export type Ascent = 'any' | 'sorted' | 'unique';

/** The most length prefixes a codec keeps the cost of. */
const MAX_LENGTH_COSTS = 4096;

/** A value of an alphabet under length bounds: its length prefix, then its items one symbol each. */
export class PlainText<T> {
  private readonly length: IndexRange;
  private readonly body: Spelled<T>;
  /** The overrun error, `Code points overrun the length prefix`. */
  private readonly overrun: string;
  /** The cost of each length prefix `lengthUnits` priced, by count. */
  private readonly lengthCosts = new Map<number, number>();

  constructor(
    private readonly symbols: Symbols<T>,
    bounds: LengthBounds
  ) {
    const { who, size, rows, item, noun } = symbols;
    this.length = lengthRange(bounds, who, noun);
    this.body = new Spelled(symbols, members(size, rows === undefined ? undefined : { rows }, who));
    this.overrun = `${item.charAt(0).toUpperCase()}${item.slice(1)}s overrun the ${noun} prefix`;
  }

  /**
   * The cost, in `COST_UNITS`, of the length prefix of a value of `count`,
   * Infinity where it cannot take that length: what writing it charges.
   */
  lengthUnits(count: number): number {
    let units = this.lengthCosts.get(count);
    if (units === undefined) {
      const enc = new Encoder();
      const mark = enc.mark();
      try {
        this.length.write(enc, count, () => '');
        units = enc.bitsSince(mark) * COST_UNITS;
      } catch {
        units = Infinity;
      }
      if (this.lengthCosts.size < MAX_LENGTH_COSTS) {
        this.lengthCosts.set(count, units);
      }
    }
    return units;
  }

  /** The items `value` is spelled in. */
  items(value: T): number[] {
    return this.symbols.items(value);
  }

  write(enc: Encoder, value: T): void {
    this.writeLength(enc, value);
    this.body.write(enc, this.symbols.items(value), NONE);
  }

  read(dec: Decoder): T {
    return this.symbols.build(this.readBody(dec, this.readLength(dec), NONE));
  }

  /** Writes the length prefix of `value` and returns the span of its items. */
  private writeLength(enc: Encoder, value: T): number {
    const symbols = this.symbols;
    const count = symbols.count(value);
    this.length.write(enc, count, () => symbols.subject(value));
    return symbols.span(count);
  }

  /** Reads a length prefix `writeLength` wrote and returns the span of the items after it. */
  private readLength(dec: Decoder): number {
    const count = this.length.read(dec);
    this.symbols.check?.(count);
    dec.charge(count);
    return this.symbols.span(count);
  }

  /** Reads the items of `span` units after `lead`, the first known as `first`, refusing any that overrun it. */
  private readBody(dec: Decoder, span: number, lead: readonly number[], first?: First): number[] {
    const [items, units] = this.body.read(dec, span, lead, first);
    // An item wider than one unit in the final slot can overshoot the span;
    // no value encodes that way.
    if (units > span) {
      throw new CorruptInputError(this.overrun);
    }
    return items;
  }

  /** A run of values coded one after another as `writeNext` writes them, each after the one before. */
  run(ascent: Ascent): Run<T> {
    let prev: number[] | undefined;
    return {
      write: (enc, value) => {
        prev = this.writeNext(enc, value, prev, ascent);
      },
      read: (dec) => {
        const [value, items] = this.readNext(dec, prev, ascent);
        prev = items;
        return value;
      },
    };
  }

  /**
   * Writes `value` as the value of a run after the one whose items are
   * `prev`, none for the run's first, and returns its items. After the
   * length prefix come how many items of `prev` the value starts with, out
   * of the counts `ascent` leaves possible, on the gamma scale; then the
   * items after them, priced as following that shared start. The first of
   * those is not the item of `prev` after the start, whose symbol is ruled
   * out where it stands for that item alone.
   */
  writeNext(enc: Encoder, value: T, prev: readonly number[] | undefined, ascent: Ascent): number[] {
    const items = this.symbols.items(value);
    const span = this.writeLength(enc, value);
    if (prev === undefined) {
      this.body.write(enc, items, NONE);
      return items;
    }
    const most = this.most(prev, span, ascent);
    const shared = this.sharing(items, prev, most);
    GAMMA_MAGNITUDE.write(enc, shared, 0, 0, most);
    this.body.write(
      enc,
      items.slice(shared),
      prev.slice(0, shared),
      this.first(prev, shared, ascent)
    );
    return items;
  }

  /** Reads a value `writeNext` wrote after the same `prev`, and its items. */
  readNext(dec: Decoder, prev: readonly number[] | undefined, ascent: Ascent): [T, number[]] {
    const span = this.readLength(dec);
    let items: number[];
    if (prev === undefined) {
      items = this.readBody(dec, span, NONE);
    } else {
      const most = this.most(prev, span, ascent);
      if (most < 0) {
        throw new CorruptInputError('An empty value follows another in an ascending run');
      }
      const shared = GAMMA_MAGNITUDE.read(dec, 0, 0, most);
      const lead = prev.slice(0, shared);
      const rest = span - unitsOf(this.symbols, prev, shared);
      items = lead.concat(this.readBody(dec, rest, lead, this.first(prev, shared, ascent)));
    }
    return [this.symbols.build(items), items];
  }

  /** The most items at the start of `prev` whose units fit in `span`. */
  private reach(prev: readonly number[], span: number): number {
    let count = 0;
    for (let units = 0; count < prev.length; count++) {
      units += this.symbols.units(prev[count]);
      if (units > span) {
        break;
      }
    }
    return count;
  }

  /**
   * How many items `items` starts with of `prev`, at most `bound`, the most
   * of `prev` that fit the span `items` fills: no more of them can match.
   */
  private sharing(items: readonly number[], prev: readonly number[], bound: number): number {
    let shared = 0;
    while (shared < bound && items[shared] === prev[shared]) {
      shared++;
    }
    return shared;
  }

  /**
   * The most items of `prev` a run's value of `span` units can start with
   * under `ascent`: as many as fit the span, less one where starting with
   * all of them would make the value a start of `prev` that the ascent
   * rules out, any shorter one sorting below it, and under `unique` the
   * value equal to it. Below 0 only for an empty value that cannot follow.
   */
  private most(prev: readonly number[], span: number, ascent: Ascent): number {
    const bound = this.reach(prev, span);
    const whole = unitsOf(this.symbols, prev, bound) === span;
    return ascent !== 'any' && whole && (ascent === 'unique' || bound < prev.length)
      ? bound - 1
      : bound;
  }

  /**
   * What is known of the next item of a run's value that starts with
   * `shared` items of `prev`, as the start shared is the longest: it is not
   * `prev`'s next item, so not its symbol where that stands for it alone,
   * and above it under an `ascent` that orders the values, so at least the
   * alphabet's floor above it. Nothing past `prev`'s end.
   */
  private first(prev: readonly number[], shared: number, ascent: Ascent): First | undefined {
    if (shared >= prev.length) {
      return undefined;
    }
    const symbols = this.symbols;
    const item = prev[shared];
    const symbol = symbols.symbol(item);
    return {
      except: symbols.tails(item, symbol) === 1 ? symbol : undefined,
      floor: ascent === 'any' ? undefined : symbols.above?.(item),
    };
  }
}

const NONE: readonly number[] = [];

/**
 * A value of an alphabet under `.compress()`: its items as symbols of the
 * predictor at the node's path, the value step first, then each item and the
 * end. `members`, for a charset, are the code units of its digits, the
 * alphabet the predictor closes. The bounds count the units of the items: a
 * value may end only at a whole `symbols.span(1)` of them, never below the
 * min, and ends without a symbol at the max.
 */
export class Learned<T> {
  private readonly min: number;
  private readonly max?: number;
  private readonly ends: Ends;
  /** The digit of each member, for a charset. */
  private readonly digits?: Map<number, number>;

  constructor(
    private readonly symbols: Symbols<T>,
    private readonly path: object,
    private readonly options: Resolved,
    private readonly alphabet: AlphabetKind,
    bounds: LengthBounds,
    private readonly members?: Int32Array
  ) {
    const length = lengthRange(bounds, symbols.who, symbols.noun);
    // A length range always has its floor, 0 unless declared.
    this.min = length.lo as number;
    this.max = length.hi;
    this.ends = {
      min: symbols.span(this.min),
      max: this.max === undefined ? undefined : symbols.span(this.max),
      fixed: this.min === this.max,
      step: symbols.span(1),
    };
    if (members !== undefined) {
      this.digits = new Map(Array.from(members, (code, digit) => [code, digit]));
    }
  }

  write(enc: Encoder, value: T): void {
    const symbols = this.symbols;
    checkIndex(symbols.count(value), this.min, this.max, () => symbols.subject(value));
    const items = symbols.items(value);
    const members = this.members;
    const syms = members === undefined ? items : items.map((digit) => members[digit]);
    this.coder(enc).write(enc, syms, syms.length, this.ends);
  }

  read(dec: Decoder): T {
    const syms = this.coder(dec).read(dec, this.ends);
    const digits = this.digits;
    const items: number[] = [];
    for (const sym of syms) {
      // A charset's coder reads only its members.
      items.push(digits === undefined ? sym : (digits.get(sym) as number));
    }
    return this.symbols.build(items);
  }

  private coder(side: Encoder | Decoder) {
    return session(side).string(this.path, this.options, this.alphabet, this.members);
  }
}
