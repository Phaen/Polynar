/**
 * The sequence codec behind `p.string` and `p.binary`: a length prefix, then
 * one symbol per item from a fixed table, each priced uniformly or by a
 * static prior per row, and followed by whatever the symbol does not carry.
 * Adaptive, the symbols are priced by the ones before them, learned through
 * the message, and a stretch of items that already occurred in the message
 * can be copied from there instead; `.repeats()` copies stretches at fixed
 * odds without learning. A value may also be spelled by its place among the
 * values the node already wrote (`.recall()`), or after the start it shares
 * with the node's previous value (`.delta()`), and text as digit fields
 * (`.digits()`) or by its places (`.positional()`), each open to a learned
 * choice under adaptive. The alphabet decides what the items are and how they map to
 * symbols; the engine decides how the symbols are spelled.
 */
import {
  Encoder,
  Decoder,
  CorruptInputError,
  type EventLog,
  COST_UNITS,
  costUnits,
  log2Units,
} from '../packer';
import {
  AdaptivePrior,
  DEFAULT_ADAPTIVE_WINDOW,
  checkAdaptation,
  type PriorOptions,
} from './adaptive';
import { ContextModel, MAX_ORDER, Stops, WARMUP } from './contexts';
import { GrownAlphabet, GrownPrior } from './grown';
import {
  Exclusion,
  excludedBucket,
  readExcluded,
  staticTable,
  writeExcluded,
  type Table,
} from './excluded';
import { IndexRange, lengthRange, type LengthBounds } from './lattice';
import { GAMMA_MAGNITUDE, LearnedMagnitude, type Magnitude } from './magnitude';
import { members, type Members } from './members';
import {
  ModeChoice,
  chooses,
  declaresAny,
  learningOf,
  recallOf,
  type Method,
  type MethodName,
  type MethodSet,
  type ValueProvider,
} from './methods';
import { Recall } from './recall';
import { DigitFields, Positional, type FieldHost } from './fields';
import {
  EVEN_REPEATS,
  Finder,
  MIN_MATCH,
  REP_MIN,
  Repeats,
  type FlagContext,
  type Match,
  type RepeatCoding,
} from './repeats';
import { buildWeights, checkIndex } from './weights';
import { WordModel, mixWeights } from './words';
import { ProviderRef, poolKey, type Pool, type ProviderKind } from './providers';

/** Thrown out of a word's spellings where a literal of it falls to the prior, which a mixture cannot hold. */
const UNMIXED = new Error('A word literal fell to the prior');
import type { Run } from './base';

/**
 * The items at the start of a repeat that still train the context model:
 * past them, a long copy only over-trains the contexts it passes.
 */
const MATCH_LEARNED = 16;

/**
 * The items a parse plans ahead: it settles the cheapest spelling of the
 * next `PARSE_WINDOW` items, further where a match reaches past them, as the
 * model stands when it starts. Measured on real text and binaries, a longer
 * plan buys little more and a shorter one gives part of the gain back.
 */
const PARSE_WINDOW = 128;

/**
 * A match from this many items on is taken where the parse finds it rather
 * than parsed around, and the parse looks no further along a match. A
 * shorter bound saves time on long repeats and gives size back.
 */
const LONG_MATCH = 256;

/**
 * One way a parse reaches a position: its cost, in `COST_UNITS`, the step
 * that reaches it from `from`, a match or a literal (undefined), and what
 * follows from that step: the cached distances, the flag context and the
 * symbol a literal next rules out.
 */
interface Label {
  readonly cost: number;
  readonly from: number;
  readonly step: Match | undefined;
  readonly reps: readonly number[];
  readonly context: FlagContext;
  readonly except: number | undefined;
}

/**
 * The cheapest way a parse reaches a position, `any`, and the cheapest a
 * literal may follow, `free`: a match cut short leaves the copy's next item
 * to rule out where it is the item that follows.
 */
interface Node {
  any: Label;
  free?: Label;
}

/**
 * An alphabet a sequence is spelled in: how a value becomes items
 * (integers), how an item becomes a symbol of the table with an optional
 * tail, and which row the next symbol is priced in.
 */
export interface Symbols<T> {
  /** The node, as errors name it: `p.string`, `p.binary`. */
  readonly who: string;
  /**
   * What the learned spelling is shared by: adaptive sequences whose
   * alphabets name the same pool, compared by identity, under the same
   * window learn as one. Alphabets in one pool spell every item as the same
   * symbol and tail, in the same rows.
   */
  readonly pool: string | object;
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
  /**
   * Set where the learned spelling admits an item spelled with a tail to
   * the symbols once it occurs (`./grown`): the items `symbol` spells with
   * a tail, first and last, whose offset is the tail; undefined where it
   * has none. `rows` and `prior.live` then weigh one more symbol, last: an
   * item seen before.
   */
  range?(symbol: number): readonly [number, number] | undefined;
  /**
   * How the learned prior weighs and keeps its counts, which every row
   * shares: by the static rows, keeping nothing seen, when left out.
   */
  readonly prior?: Pick<PriorOptions, 'live' | 'keep'>;
  /**
   * The digit 0 to 9 `item` stands for, -1 for any other item; set on the
   * text alphabets, which digit fields and positions spell.
   */
  digit?(item: number): number;
  /** The item of `digit`, -1 where the alphabet lacks it; set with `digit`. */
  digitItem?(digit: number): number;
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
  /**
   * The string a value is recalled under, as `identity` in `./recall`
   * describes it: values with the same items share it. The items, joined,
   * when left out.
   */
  identity?(value: T): string;
  /** A copy of a decoded value, for a recall whose values may be mutated; the value itself when left out. */
  copy?(value: T): T;
  /**
   * Whether `item` is a letter, a one-unit item without a tail below 128:
   * a run of letters is a word, which the learned spelling may write as
   * one token (`./words`). Left out, a sequence has no words.
   */
  letter?(item: number): boolean;
}

/**
 * The items repeats may copy per digit of a message's input. A real
 * message's repeats stay far under it (lorem repeated to 80k characters
 * copies about a hundred items per byte), while a few corrupt digits naming
 * a huge length and a long overlapping match would otherwise allocate
 * gigabytes before the input ran out.
 */
const REPEAT_YIELD = 2 ** 16;

/**
 * One message's items on a side, in the order they were coded, the
 * encoder's finder over them, the items the decoder's repeats copied, and
 * the distances of the latest matches.
 */
interface Message {
  readonly items: number[];
  /** The encoder's finder, built on its first use. */
  finder?: Finder;
  /** The next position the finder registers. */
  next: number;
  /** The items the decoder's repeats copied so far. */
  copied: number;
  /** The distances a match may name again, most recent first. */
  readonly reps: number[];
}

/** Spelling with repeats, 1, before without, 0: the order of a tie, and of tries that start with repeats. */
const WITH_FIRST: readonly number[] = [1, 0];
/** The tries starting without repeats. */
const WITH_LAST: readonly number[] = [0, 1];

/** The distances cached before a message's first match. */
const FIRST_REPS: readonly number[] = [1, 2, 3, 4];

/**
 * The cost at or under which a literal right after a hit in the
 * highest-order context is spelled without searching for a match: a tenth
 * of a bit, in `COST_UNITS`. Measured to keep sizes level or better while
 * saving the search where the model already predicts well.
 */
const CHEAP_LITERAL = COST_UNITS / 10;

/**
 * The cache after `match`: a rep moves its distance to the front, a new
 * distance enters at the front and the oldest leaves.
 */
function cache(reps: number[], match: Match): void {
  if (match.rep === undefined) {
    reps.pop();
  } else {
    reps.splice(match.rep, 1);
  }
  reps.unshift(match.distance);
}

/**
 * Whether a value of `span` units after `before` items of the message can
 * hold a repeat: the items reach `gate` with it, and one is decodable at a
 * position with an item before it and at least `MIN_MATCH` units left.
 */
const possible = (before: number, span: number, gate: number): boolean =>
  before + span >= gate && ((before >= 1 && span >= MIN_MATCH) || span >= MIN_MATCH + 1);

/**
 * Whether a value after `before` items of the message, its end spelled and
 * its span unknown to the decoder, can hold a repeat: the items reach
 * `gate` before it, and there is one to copy.
 */
const possibleOpen = (before: number, gate: number): boolean => before >= Math.max(gate, 1);

/** The largest bound `Repeats` codes a distance or length under. */
const MAX_REPEAT_BOUND = 2 ** 32 - 1;

/**
 * Where a value's end is a symbol, `end` past the alphabet's: the units a
 * value spans at least and at most, `high` Infinity for no bound, each
 * length spanning a multiple of `step` units, and whether the end is
 * spelled instead of the length (`open`), or only learned after a value
 * that spells its length, so the choice between the two can price it.
 */
export interface Ends {
  readonly open: boolean;
  readonly low: number;
  readonly high: number;
  readonly step: number;
}

/**
 * Whether a value may end `units` into it, after an item of `last` units,
 * 1 at its start: within the bounds, after a whole step, and never after
 * an item of none, a prose shift, which always has an item after it.
 */
const endable = (ends: Ends, units: number, last: number): boolean =>
  units >= ends.low && units < ends.high && units % ends.step === 0 && last > 0;

/** The units of `lead` and of its last item, 1 for none. */
function leadOf<T>(symbols: Symbols<T>, lead: readonly number[]): [number, number] {
  let units = 0;
  for (const item of lead) {
    units += symbols.units(item);
  }
  return [units, lead.length === 0 ? 1 : symbols.units(lead[lead.length - 1])];
}

/**
 * Whether a repeat is decodable at a position with `at` items of the
 * message before it and `limit` units of the value left: at least one item
 * back, and from `MIN_MATCH` units ahead up to the largest bound a repeat is
 * coded under. The items are a JS array, so `at` never passes that bound.
 */
const decodable = (at: number, limit: number): boolean =>
  at >= 1 && limit >= MIN_MATCH && limit <= MAX_REPEAT_BOUND;

/** `history` with `sym` as its newest symbol. */
function advance(history: readonly number[], sym: number): number[] {
  const next = new Array<number>(MAX_ORDER);
  next[0] = sym;
  for (let k = 1; k < MAX_ORDER; k++) {
    next[k] = history[k - 1];
  }
  return next;
}

/** The row of the item after `lead`, the start a value shares with the one before it: the start row when it shares none. */
const rowAfter = <T>(symbols: Symbols<T>, lead: readonly number[]): number =>
  lead.length === 0 ? symbols.start : symbols.row(lead[lead.length - 1]);

/**
 * The row and the previous symbols of the item after `lead`, each item's
 * symbol `symbol` gives: the symbols of its last items, newest first, and
 * "before the value began", the alphabet's size, past them.
 */
function opening<T>(
  symbols: Symbols<T>,
  lead: readonly number[],
  symbol: (item: number) => number
): [number, number[]] {
  let history = new Array<number>(MAX_ORDER).fill(symbols.size);
  for (let k = Math.max(0, lead.length - MAX_ORDER); k < lead.length; k++) {
    history = advance(history, symbol(lead[k]));
  }
  return [rowAfter(symbols, lead), history];
}

/**
 * How one symbol of a sequence is spelled, given the row it is priced in
 * and the previous symbols, newest first, with `except`, when given, ruled
 * out, and the end, the alphabet's size or the grown alphabet's, open
 * where the value may end (`endable`): `ContextModel` under adaptive,
 * `StaticLiterals` otherwise. `price`
 * is the cost, in `COST_UNITS`, `write` would give the symbol now,
 * learning nothing; `hitTop` is whether the last symbol coded was a
 * hit in the highest-order context.
 */
interface Literals {
  write(
    enc: Encoder,
    sym: number,
    row: number,
    history: readonly number[],
    except?: number,
    endable?: boolean
  ): void;
  read(
    dec: Decoder,
    row: number,
    history: readonly number[],
    except?: number,
    endable?: boolean
  ): number;
  learn(side: Encoder | Decoder, sym: number, row: number, history: readonly number[]): void;
  price(
    enc: Encoder,
    sym: number,
    row: number,
    history: readonly number[],
    except?: number,
    endable?: boolean
  ): number;
  hitTop(side: Encoder | Decoder): boolean;
  /** Whether the symbol `price` last priced would be a hit in the highest-order context. */
  readonly pricedTop: boolean;
}

/**
 * The symbols at the alphabet's static odds, for repeats that do not
 * learn: each row's weights, or every symbol alike in one row, as one
 * weighted symbol with `except` ruled out. The previous symbols play no
 * part, and no symbol is a context hit. Where the value may end, the row's
 * stop says first whether it does, the one thing that learns.
 */
export class StaticLiterals implements Literals {
  private readonly tables: readonly Table[];
  /** The exclusion each symbol reuses. */
  private readonly exclusion: Exclusion;
  /** The end: the alphabet's size. */
  private readonly end: number;
  private readonly stops = new Stops();

  constructor(symbols: Symbols<unknown>) {
    const { who, size, rows } = symbols;
    this.end = size;
    this.tables = (rows ?? [new Array<number>(size).fill(1)]).map((weights) =>
      staticTable(buildWeights(weights, size, who))
    );
    this.exclusion = new Exclusion(size);
  }

  /** The table of `row`, which must be one of the rows. */
  private table(row: number): Table {
    const table = this.tables[row];
    // Any row outside the list (negative, fractional, NaN, past the end)
    // reads undefined.
    if (table === undefined) {
      throw new RangeError(`Row ${row} is outside [0, ${this.tables.length})`);
    }
    return table;
  }

  /** The exclusion of `except` alone, or of nothing. */
  private ruling(except: number | undefined): Exclusion {
    const exclusion = this.exclusion;
    exclusion.clear();
    if (except !== undefined) {
      exclusion.add(except);
    }
    return exclusion;
  }

  write(
    enc: Encoder,
    sym: number,
    row: number,
    _history: readonly number[],
    except?: number,
    endable = false
  ): void {
    const table = this.table(row);
    if (endable) {
      this.stops.write(enc, row, sym === this.end);
    }
    if (sym !== this.end) {
      writeExcluded(enc, table, this.ruling(except), sym);
    }
  }

  read(
    dec: Decoder,
    row: number,
    _history: readonly number[],
    except?: number,
    endable = false
  ): number {
    const table = this.table(row);
    return endable && this.stops.read(dec, row)
      ? this.end
      : readExcluded(dec, table, this.ruling(except));
  }

  learn(): void {}

  price(
    enc: Encoder,
    sym: number,
    row: number,
    _history: readonly number[],
    except?: number,
    endable = false
  ): number {
    const [, freq, total] = excludedBucket(this.table(row), this.ruling(except), sym);
    return (endable ? this.stops.cost(enc, row, false) : 0) + costUnits(freq, total);
  }

  hitTop(): boolean {
    return false;
  }

  readonly pricedTop = false;
}

/**
 * How the items of a value after its length prefix are spelled. `lead` is
 * the start the value shares with the node's previous value, already
 * known to both sides: the items spelled are those after it, `span` units
 * of them, and the first is priced as the item after `lead`. `first`,
 * when given, is what is known of the first item's symbol, which
 * the body rules out what it can of. `ends`, when given, makes the end a
 * symbol after the items.
 */
interface Body {
  write(
    enc: Encoder,
    items: readonly number[],
    span: number,
    lead: readonly number[],
    first?: First,
    ends?: Ends
  ): void;
  /**
   * Reads items until their units reach `span`, or, where `ends` is open,
   * until it reads the end, `span` then the most units they may reach;
   * returns them and the units they add up to.
   */
  read(
    dec: Decoder,
    span: number,
    lead: readonly number[],
    first?: First,
    ends?: Ends
  ): [number[], number];
}

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

/**
 * The items one symbol each at the alphabet's static odds, each followed by
 * its tail. A first symbol with a floor is spelled among those from it
 * where every symbol is alike, else one with a symbol ruled out among the
 * rest at the same odds.
 */
class Spelled<T> implements Body {
  /** Set when a value's symbols read as one run: uniform and tailless. */
  private readonly fast: boolean;
  /** The first symbols with one ruled out, built on first use. */
  private excluding?: StaticLiterals;
  /** Whether a value ends where it may. */
  private readonly stops = new Stops();

  constructor(
    private readonly symbols: Symbols<T>,
    private readonly spelling: Members
  ) {
    this.fast = symbols.tailless && spelling.radix !== undefined;
  }

  private literals(): StaticLiterals {
    return (this.excluding ??= new StaticLiterals(this.symbols));
  }

  /** Writes the first symbol, known as `first`, in `row`. */
  private writeFirst(enc: Encoder, symbol: number, row: number, { except, floor }: First): void {
    const { radix } = this.spelling;
    if (floor !== undefined && radix !== undefined) {
      enc.compose(symbol - floor, radix - floor);
    } else if (except !== undefined) {
      this.literals().write(enc, symbol, row, NONE, except);
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
      ? this.literals().read(dec, row, NONE, except)
      : this.spelling.read(dec, row);
  }

  write(
    enc: Encoder,
    items: readonly number[],
    _span: number,
    lead: readonly number[],
    first?: First,
    ends?: Ends
  ): void {
    const { symbols, spelling, stops } = this;
    let row = rowAfter(symbols, lead);
    let [units, last] = leadOf(symbols, lead);
    for (let k = 0; k < items.length; k++) {
      if (ends?.open === true && endable(ends, units, last)) {
        stops.write(enc, row, false);
      }
      const item = items[k];
      const symbol = symbols.symbol(item);
      if (k === 0 && first !== undefined) {
        this.writeFirst(enc, symbol, row, first);
      } else {
        spelling.write(enc, symbol, row);
      }
      symbols.tail(enc, item, symbol);
      row = symbols.row(item);
      last = symbols.units(item);
      units += last;
    }
    if (ends?.open === true && units < ends.high) {
      stops.write(enc, row, true);
    }
  }

  read(
    dec: Decoder,
    span: number,
    lead: readonly number[],
    first?: First,
    ends?: Ends
  ): [number[], number] {
    const { symbols, spelling } = this;
    const open = ends?.open === true ? ends : undefined;
    if (this.fast && first === undefined && open === undefined) {
      return [dec.parseMany(symbols.size, span), span];
    }
    const items: number[] = [];
    let units = 0;
    let row = rowAfter(symbols, lead);
    const [before, start] = leadOf(symbols, lead);
    let last = start;
    while (units < span) {
      bounded(items.length, open === undefined ? span : units + 1);
      if (open !== undefined && endable(open, before + units, last) && this.stops.read(dec, row)) {
        break;
      }
      const symbol =
        items.length === 0 && first !== undefined
          ? this.readFirst(dec, row, first)
          : spelling.read(dec, row);
      const item = symbols.untail(dec, symbol);
      items.push(item);
      last = symbols.units(item);
      units += last;
      row = symbols.row(item);
    }
    return [items, units];
  }
}

/**
 * The spelling of a sequence's items with repeats of earlier stretches of
 * the message: under adaptive, contexts over the symbols and learned
 * repeats from `gate` items of the message on; for `.repeats()` alone,
 * static symbols and repeats at fixed odds from the first item. Each value
 * opens with whether it spells repeats, where it can hold one; a value that does
 * flags at every position a repeat is decodable whether one starts there,
 * in the flag table of what came before: a match, a literal the highest
 * context coded, or anything else, the value's first position included.
 *
 * In a tailless alphabet the literal right after a match that stops short
 * of the value's end rules out the item that followed the copied stretch
 * in its source: the encoder follows a match it cut short with another
 * match, never a literal, so that item differs from the next one. In an
 * alphabet with tails a band or an escape maps many items to one symbol, so
 * a differing item may still share the symbol, and nothing is ruled out.
 */
class Engine<T> implements Body {
  /**
   * Whether the node's last value that could hold a repeat took them,
   * which only orders the next value's tries: the way it did not take is
   * tried first, which measured fastest on texts written again and again.
   * It carries over from one message to the next; the order changes no
   * choice, only how soon the try after the first stops.
   */
  private used = true;
  /** The costs `search` works in, reused from one search to the next. */
  private readonly costs: number[] = [];

  /** The steps of the parse planned, by item of the value, a literal undefined. */
  private readonly plan = new Map<number, Match | undefined>();
  /** The item of the value the plan ends at, where the next parse starts. */
  private planEnd = -1;
  /** The positions a parse works in, from its first item on. */
  private readonly nodes: (Node | undefined)[] = [];
  /** The symbol that ends a value: past the alphabet's, and past the grown alphabet's where it grows. */
  private readonly end: number;
  /**
   * What the end of the value written or read last cost, in `COST_UNITS`,
   * where `ends` came with it: as coded where spelled, as priced before
   * the contexts learned it otherwise.
   */
  endUnits = 0;

  /** The model the symbols are priced in, built on first use. */
  private model?: Literals;

  constructor(
    private readonly symbols: Symbols<T>,
    private readonly build: () => Literals,
    private readonly repeats: RepeatCoding,
    private readonly gate: number,
    private readonly grown?: GrownAlphabet,
    private readonly words?: WordModel,
    pool?: Pool
  ) {
    this.end = grown?.size ?? symbols.size;
    this.history = new ProviderRef(HISTORY, pool);
  }

  /** The symbol of `item` on `side`: its own once admitted, else the alphabet's. */
  private symbol(side: Encoder | Decoder, item: number): number {
    const sym = this.grown?.symbol(side, item) ?? -1;
    return sym < 0 ? this.symbols.symbol(item) : sym;
  }

  /** Whether `sym`, an item's symbol, is an admitted item's, which carries no tail. */
  private admitted(sym: number): boolean {
    return sym > this.symbols.size;
  }

  /** Whether a tail follows `sym`: an alphabet symbol, not an admitted item's nor the end. */
  private tailed(sym: number): boolean {
    return sym < this.symbols.size;
  }

  /** Writes the tail of `item` after `sym`, the alphabet's: the grown alphabet's where it grows. */
  private tail(enc: Encoder, item: number, sym: number): void {
    if (this.grown?.tail(enc, item, sym) !== true) {
      this.symbols.tail(enc, item, sym);
    }
  }

  /** The item of `sym`, the alphabet's, and the tail `tail` wrote. */
  private untail(dec: Decoder, sym: number): number {
    return this.grown?.untail(dec, sym) ?? this.symbols.untail(dec, sym);
  }

  /** Each message's items. */
  private readonly history: ProviderRef<Pool | undefined, Message>;

  /** The model the symbols are priced in. */
  private literals(): Literals {
    return (this.model ??= this.build());
  }

  /** This message's items on `side`. */
  private message(side: Encoder | Decoder): Message {
    return this.history.get(side);
  }

  /**
   * The walk of `items`, a value's `span` units after `lead` and after
   * `base` items of the message: the row, history and units before each
   * item, the same whichever items a repeat copies.
   */
  private walk(
    enc: Encoder,
    items: readonly number[],
    span: number,
    lead: readonly number[],
    base: number,
    model: Literals,
    ends: Ends | undefined
  ): Walk {
    const { symbols, grown } = this;
    const symbol = (item: number): number => this.symbol(enc, item);
    let syms: number[];
    if (grown === undefined) {
      syms = items.map(symbol);
    } else {
      // An item new to the message is numbered as the spelling will admit it.
      syms = [];
      const ahead = new Map<number, number>();
      let next = symbols.size + 1 + grown.admitted(enc);
      for (const item of items) {
        const known = ahead.get(item);
        if (known !== undefined) {
          syms.push(known);
          continue;
        }
        const sym = symbol(item);
        if (sym < symbols.size && next < grown.size && symbols.tails(item, sym) > 1) {
          ahead.set(item, next++);
        }
        syms.push(sym);
      }
    }
    const rows: number[] = [];
    const histories: number[][] = [];
    const before = [0];
    let [row, history] = opening(symbols, lead, symbol);
    const n = items.length;
    for (let k = 0; k < n; k++) {
      rows.push(row);
      histories.push(history);
      before.push(before[k] + symbols.units(items[k]));
      history = advance(history, syms[k]);
      row = symbols.row(items[k]);
    }
    // The end, after the items.
    syms.push(this.end);
    rows.push(row);
    histories.push(history);
    const may: boolean[] = [];
    let closed = false;
    const [start, last] = ends === undefined ? [0, 1] : leadOf(symbols, lead);
    if (ends?.open === true) {
      for (let k = 0; k <= n; k++) {
        may.push(endable(ends, start + before[k], k > 0 ? symbols.units(items[k - 1]) : last));
      }
      closed = start + before[n] < ends.high;
    }
    const prev = lead.length > 0 ? lead[lead.length - 1] : -1;
    return { model, base, span, syms, rows, histories, before, prev, ends, start, may, closed };
  }

  /**
   * Writes the items of a value of `span` units after `lead`. Where the
   * value can hold a repeat, the encoder decides between spelling it with
   * repeats and without, a tie going to repeats, trying first the way the
   * node's previous such value did not take. A value spelled without repeats
   * still registers its positions with the finder: the next value would
   * register the same ones in the same order, and a try with repeats that
   * is rolled back registering them again for every value would take time
   * quadratic in a run of values without repeats.
   */
  write(
    enc: Encoder,
    items: readonly number[],
    span: number,
    lead: readonly number[],
    first?: First,
    ends?: Ends
  ): void {
    const state = this.message(enc);
    const all = state.items;
    const base = all.length;
    for (const item of items) {
      all.push(item);
    }
    if (enc.journal.active) {
      enc.journal.truncate(all, base);
    }
    const walk = this.walk(enc, items, span, lead, base, this.literals(), ends);
    if (ends?.open === true ? !possibleOpen(base, this.gate) : !possible(base, span, this.gate)) {
      this.spell(enc, state, walk, items, false, first?.except);
      return;
    }
    const used =
      enc.decide(WITH_FIRST, this.used ? WITH_LAST : WITH_FIRST, (choice) => {
        this.repeats.writeUsed(enc, choice === 1);
        this.spell(enc, state, walk, items, choice === 1, first?.except);
      }) === 1;
    this.used = used;
    if (!used) {
      this.register(enc, state, Infinity);
    }
  }

  /**
   * Spells the items of `walk`, with repeats where they are decodable when
   * `used`, the first literal ruling out `except`.
   */
  private spell(
    enc: Encoder,
    state: Message,
    walk: Walk,
    items: readonly number[],
    used: boolean,
    except: number | undefined
  ): void {
    const { repeats } = this;
    const { model, base, syms, rows, histories, may: endable } = walk;
    const n = items.length;
    let context: FlagContext = 0;
    // A match whose flag ended the word before it.
    let ending: Match | undefined;
    this.planEnd = -1;
    // Where the end is spelled, it is one more literal, after the items.
    const last = walk.closed ? n + 1 : n;
    for (let k = 0; k < last; ) {
      const at = base + k;
      const limit = limitAt(walk, k);
      let match = ending;
      ending = undefined;
      if (match === undefined && used && decodable(at, limit)) {
        match = k < n ? this.choose(enc, state, walk, k, context, except) : undefined;
        repeats.writeFlag(enc, match !== undefined, context);
      }
      if (match !== undefined) {
        repeats.writeMatch(enc, match, at, limit);
        this.cache(enc, state, match);
        for (let j = k; j < k + Math.min(match.length, MATCH_LEARNED); j++) {
          model.learn(enc, syms[j], rows[j], histories[j]);
        }
        k += match.length;
        context = 2;
        // The end, where spelled, is a literal after the match too.
        except = this.continuation(state.items, base + k, match.distance, k < n || walk.closed);
        continue;
      }
      const prev = k === 0 ? walk.prev : items[k - 1];
      if (this.opens(enc, model, prev)) {
        [k, context, ending] = this.writeWord(enc, state, walk, items, k, prev, used, except);
        except = undefined;
        continue;
      }
      const sym = syms[k];
      model.write(enc, sym, rows[k], histories[k], except, endable[k]);
      if (this.tailed(sym)) {
        this.tail(enc, items[k], sym);
      }
      context = model.hitTop(enc) ? 1 : 0;
      except = undefined;
      k++;
    }
    this.close(enc, model, walk.ends, walk.closed, rows[n], histories[n]);
  }

  /**
   * After a value on `side` that came with `ends`, the end due in `row`
   * after `history`: where it was spelled (`closed`), what it cost; where
   * it only learns, what it would have cost, then the contexts learn it;
   * where it was forced, at the most units, nothing, and the contexts
   * learn it. A model that does not learn leaves it.
   */
  private close(
    side: Encoder | Decoder,
    model: Literals,
    ends: Ends | undefined,
    closed: boolean,
    row: number,
    history: readonly number[]
  ): void {
    if (ends === undefined || !(model instanceof ContextModel)) {
      return;
    }
    if (closed) {
      this.endUnits = model.endUnits;
      return;
    }
    if (ends.open) {
      this.endUnits = 0;
      model.learn(side, this.end, row, history);
    } else {
      this.endUnits = model.absorb(side, this.end, row, history, undefined, true);
    }
  }

  /** Whether `item` is a letter of a word. */
  private letter(item: number): boolean {
    return this.symbols.letter?.(item) === true;
  }

  /** Whether `item`, spelled as `sym`, writes no tail: the end writes none. */
  private plain(item: number, sym: number): boolean {
    return !this.tailed(sym) || this.symbols.tails(item, sym) === 1;
  }

  /**
   * Whether a literal on `side` after `prev`, -1 at a value's start, opens
   * a word: where the engine keeps words, after anything but a letter, once
   * the contexts price symbols.
   */
  private opens(side: Encoder | Decoder, model: Literals, prev: number): boolean {
    return (
      this.words !== undefined &&
      (prev < 0 || !this.letter(prev)) &&
      (model as ContextModel).warm(side)
    );
  }

  /** Learns a match flag of `context` on `side` as written, where the flags learn. */
  private learnFlag(side: Encoder | Decoder, match: boolean, context: FlagContext): void {
    this.repeats.learnFlag?.(side, match, context);
  }

  /**
   * Closes word `word` on `dec`, read as token `id`, -1 for its letters:
   * where both spellings could have written it, `hits` that every literal
   * of it hit a context, the choice goes back on the state, weighed by the
   * letters' `cost`; then the word model learns it.
   */
  private closeWord(
    dec: Decoder,
    prev: number,
    word: string,
    id: number,
    hits: boolean,
    cost: number
  ): void {
    const words = this.words as WordModel;
    const known = id !== -1 ? id : words.id(dec, word);
    let weights: [number, number] | undefined;
    if (hits && known !== -1) {
      weights = words.mixture(dec, prev, cost, known);
      dec.parseMixture(weights, id === -1 ? 0 : 1);
    }
    words.learn(dec, prev, word, weights, known);
  }

  /**
   * Writes the word that opens at item `k` of `walk`, a literal ruling out
   * `except`: the run of letters from there up to whatever ends it, a
   * literal other than a letter, a match the plan takes, or the value's
   * end. The word is spelled by its letters after the word model's escape,
   * or by its token where the message spelled it before; where both can
   * and every literal of the letters' spelling, the literal ending it
   * included, hits a context, the two are mixed. The literal ending the
   * word, or the flag of the match, is part of either spelling, so the
   * decoder knows the word whole before it closes the mixture. Returns the
   * item to go on from, the flag context there, and the match ending the
   * word, whose flag is written.
   */
  private writeWord(
    enc: Encoder,
    state: Message,
    walk: Walk,
    items: readonly number[],
    k: number,
    prev: number,
    used: boolean,
    except: number | undefined
  ): [number, FlagContext, Match | undefined] {
    const words = this.words as WordModel;
    const { repeats } = this;
    const model = walk.model as ContextModel;
    const { base, syms, rows, histories, may: endable } = walk;
    const n = items.length;
    const matchable = (j: number): boolean => used && decodable(base + j, limitAt(walk, j));
    const ruled = (j: number): number | undefined => (j === k ? except : undefined);
    /**
     * The match the plan takes at item `j` of the word. A plan made there
     * is made as the letters before it leave the model, learned and taken
     * back.
     */
    const pick = (j: number): Match | undefined => {
      if (j < this.planEnd) {
        return this.choose(enc, state, walk, j, 0, undefined);
      }
      const mark = enc.mark();
      try {
        return this.choose(
          enc,
          state,
          walk,
          j,
          this.learnLetters(enc, walk, k, j, used, except),
          undefined
        );
      } finally {
        enc.rollback(mark);
      }
    };
    let e = k;
    let end: Match | undefined;
    for (; e < n && this.letter(items[e]); e++) {
      if (e > k && matchable(e)) {
        end = pick(e);
        if (end !== undefined) {
          break;
        }
      }
    }
    if (end === undefined && e < n && e > k && matchable(e)) {
      end = pick(e);
    }
    // The end, where spelled, is the literal after the last item.
    const literal = end === undefined && (e < n || walk.closed);
    let word = '';
    for (let j = k; j < e; j++) {
      word += String.fromCharCode(items[j]);
    }
    const id = words.id(enc, word);

    /** Writes what ends the word after its letters, `flag` the flag context there. */
    const close = (flag: FlagContext): void => {
      if (end !== undefined) {
        repeats.writeFlag(enc, true, flag);
      } else if (literal) {
        if (e > k && matchable(e)) {
          repeats.writeFlag(enc, false, flag);
        }
        model.write(enc, syms[e], rows[e], histories[e], ruled(e), endable[e]);
        if (this.tailed(syms[e])) {
          this.tail(enc, items[e], syms[e]);
        }
      }
    };
    // What ends the word as the letters' spelling wrote it, for the token's.
    let ending: Pick<EventLog, 'cums' | 'freqs' | 'totals'> | undefined;
    /** The letters, spelled one by one; `mixed`, refusing a literal that falls to the prior. */
    const letters = (mixed: boolean): void => {
      words.write(enc, prev, -1);
      let flag: FlagContext = 0;
      for (let j = k; j < e; j++) {
        if (j > k && matchable(j)) {
          repeats.writeFlag(enc, false, flag);
        }
        model.write(enc, syms[j], rows[j], histories[j], ruled(j), endable[j]);
        if (mixed && model.fell) {
          throw UNMIXED;
        }
        flag = model.hitTop(enc) ? 1 : 0;
      }
      const from = enc.events().totals.length;
      close(flag);
      if (mixed) {
        if (literal && (model.fell || !this.plain(items[e], syms[e]))) {
          throw UNMIXED;
        }
        const { cums, freqs, totals } = enc.events();
        ending = {
          cums: cums.slice(from),
          freqs: freqs.slice(from),
          totals: totals.slice(from),
        };
      }
    };
    /**
     * The word as its token, then what ends it as the letters' spelling
     * wrote it: a flag, a context's escapes and its hit, all weighted, as a
     * literal ending a mixed word writes no tail.
     */
    const token = (): void => {
      words.write(enc, prev, id);
      const { cums, freqs, totals } = ending as Pick<EventLog, 'cums' | 'freqs' | 'totals'>;
      for (let i = 0; i < totals.length; i++) {
        enc.composeWeighted(cums[i], freqs[i], totals[i]);
      }
    };
    let weights: [number, number] | undefined;
    if (id === -1) {
      letters(false);
    } else {
      try {
        // What either spelling leaves is what the letters' leaves: the
        // letters, then the end, learned; the token's changes nothing.
        enc.composePriced(
          2,
          (units) => (weights = mixWeights(units[0], units[1])),
          (j) => (j === 0 ? letters(true) : token()),
          0
        );
      } catch (error) {
        if (error !== UNMIXED) {
          throw error;
        }
      }
      if (weights === undefined) {
        letters(false);
      }
    }
    words.learn(enc, prev, word, weights, id);
    if (end !== undefined) {
      return [e, 0, end];
    }
    return [literal ? e + 1 : e, model.hitTop(enc) ? 1 : 0, undefined];
  }

  /**
   * Learns items `k` to `e` of `walk`, letters of a word that opens at `k`
   * ruling out `except`, as spelling them one by one would, each match flag
   * before them included, and returns the flag context after them.
   */
  private learnLetters(
    enc: Encoder,
    walk: Walk,
    k: number,
    e: number,
    used: boolean,
    except: number | undefined
  ): FlagContext {
    const model = walk.model as ContextModel;
    const { base, syms, rows, histories, may: endable } = walk;
    let flag: FlagContext = 0;
    for (let j = k; j < e; j++) {
      if (j > k && used && decodable(base + j, limitAt(walk, j))) {
        this.learnFlag(enc, false, flag);
      }
      model.absorb(enc, syms[j], rows[j], histories[j], j === k ? except : undefined, endable[j]);
      flag = model.hitTop(enc) ? 1 : 0;
    }
    return flag;
  }

  /** Caches the distance of `match`, taken on `enc`. */
  private cache(enc: Encoder, state: Message, match: Match): void {
    const { reps } = state;
    // The cache keeps its length, so setting each distance back restores it.
    if (enc.journal.active) {
      for (let k = 0; k < reps.length; k++) {
        enc.journal.set(reps, k, reps[k]);
      }
    }
    cache(reps, match);
  }

  /**
   * Registers with the finder, built on its first use, every position
   * before `at` not yet registered whose `MIN_MATCH` items the message
   * holds.
   */
  private register(enc: Encoder, state: Message, at: number): Finder {
    const { journal } = enc;
    let finder = state.finder;
    if (finder === undefined) {
      finder = new Finder(journal);
      state.finder = finder;
      if (journal.active) {
        journal.call(() => {
          state.finder = undefined;
        });
      }
    }
    const all = state.items;
    const from = state.next;
    while (state.next < at && state.next + MIN_MATCH <= all.length) {
      finder.insert(all, state.next++);
    }
    if (journal.active && state.next !== from) {
      journal.set(state, 'next', from);
    }
    return finder;
  }

  /**
   * The symbol the literal after `match`, ending at message position `end`,
   * rules out: in a tailless alphabet, when the match stopped short of the
   * value's end (`short`), the item after the copied stretch in its source;
   * else none.
   */
  private continuation(
    all: readonly number[],
    end: number,
    distance: number,
    short: boolean
  ): number | undefined {
    return this.symbols.tailless && short ? this.symbols.symbol(all[end - distance]) : undefined;
  }

  /**
   * The cost, in `COST_UNITS`, of spelling `item`, item `j` of the value,
   * under `except`: its symbol as the model stands, then its tail.
   */
  private priceLiteral(enc: Encoder, walk: Walk, item: number, j: number, except?: number): number {
    const sym = walk.syms[j];
    const price = walk.model.price(enc, sym, walk.rows[j], walk.histories[j], except, walk.may[j]);
    return this.tailed(sym) ? price + log2Units(this.symbols.tails(item, sym)) : price;
  }

  /**
   * The match to take at item `k` of the value, a position a repeat is
   * decodable at, its flag in `context` and a literal there ruling out
   * `except`: the step the parse planned there, planning from `k` when the
   * plan does not reach it. Positions before it register with the finder
   * first.
   */
  private choose(
    enc: Encoder,
    state: Message,
    walk: Walk,
    k: number,
    context: FlagContext,
    except: number | undefined
  ): Match | undefined {
    // Positions register once, in order; one whose `MIN_MATCH` items run
    // past the message so far waits for a later value.
    const finder = this.register(enc, state, walk.base + k);
    // A spelling written again takes the match its try chose.
    const noted = enc.note(() => {
      if (k >= this.planEnd) {
        this.parse(enc, state, walk, k, context, except, finder);
      }
      const match = this.plan.get(k);
      if (match === undefined) {
        return [];
      }
      return match.rep === undefined
        ? [match.distance, match.length]
        : [match.distance, match.length, match.rep];
    });
    if (noted.length === 0) {
      return undefined;
    }
    const [distance, length, cached] = noted;
    return cached === undefined ? { distance, length } : { distance, length, rep: cached };
  }

  /**
   * The matches at item `j` of the value, each up to `LONG_MATCH` items:
   * the finder's, longer the further back, then the run at each of `reps`,
   * the cached distances, no further back than the message reaches, from
   * `REP_MIN` items.
   */
  private candidates(
    state: Message,
    walk: Walk,
    j: number,
    reps: readonly number[],
    finder: Finder
  ): Match[] {
    const all = state.items;
    const at = walk.base + j;
    // The items left in the value add up to exactly the units left, so a
    // match, which the finder ends within the value, always fits them.
    const found = finder.matches(all, at, Math.min(LONG_MATCH, walk.span - walk.before[j]));
    if (this.repeats.cached) {
      const most = Math.min(all.length - at, LONG_MATCH);
      reps.forEach((distance, rep) => {
        if (distance <= at) {
          let length = 0;
          while (length < most && all[at + length - distance] === all[at + length]) {
            length++;
          }
          if (length >= REP_MIN) {
            found.push({ distance, length, rep });
          }
        }
      });
    }
    return found;
  }

  /**
   * Plans the spelling from item `k0` of the value, its flag in `context`
   * and a literal there ruling out `except`, into `plan`, up to `planEnd`.
   * The plan is the cheapest path through the positions ahead: a literal
   * steps one item, each candidate match, at every length from the shortest
   * its distance improves on up to its own, steps its items, all priced as
   * the model and the repeat tables stand at `k0`. Each position keeps the
   * cheapest way there and the cheapest a literal may follow, with the
   * cached distances, flag context and ruled-out symbol it leaves. The path
   * ends `PARSE_WINDOW` items on, or further at the end of a match reaching
   * past them, or at a position with a match of `LONG_MATCH` items, at the
   * cheapest way there a literal may follow. Three cases plan one step: a
   * literal where it costs at most `CHEAP_LITERAL` after a hit in the
   * highest-order context or where there is no candidate, and `search`'s
   * choice where a candidate reaches `LONG_MATCH` items. Inside the plan, a
   * position reached only by such a cheap literal searches no candidates.
   */
  private parse(
    enc: Encoder,
    state: Message,
    walk: Walk,
    k0: number,
    context: FlagContext,
    except: number | undefined,
    finder: Finder
  ): void {
    const { repeats, plan, nodes } = this;
    const { model, base, syms } = walk;
    const all = state.items;
    const n = syms.length - 1;
    plan.clear();
    this.planEnd = k0 + 1;
    if (
      context === 1 &&
      this.priceLiteral(enc, walk, all[base + k0], k0, except) <= CHEAP_LITERAL
    ) {
      return;
    }
    const first = this.candidates(state, walk, k0, state.reps, finder);
    if (first.length === 0) {
      return;
    }
    if (first.some((c) => c.length >= LONG_MATCH)) {
      plan.set(k0, this.search(enc, state, walk, k0, context, except, finder));
      return;
    }
    // The plan starts where a literal may follow: after a match the plan
    // cut short, the plan goes on, and every other match runs to its end.
    const start: Label = { cost: 0, from: -1, step: undefined, reps: state.reps, context, except };
    nodes.length = 0;
    nodes[0] = { any: start, free: start };
    const reach = (e: number, label: Label, free: boolean): void => {
      const node = nodes[e - k0];
      if (node === undefined) {
        nodes[e - k0] = { any: label, free: free ? label : undefined };
        return;
      }
      if (label.cost < node.any.cost) {
        node.any = label;
      }
      if (free && (node.free === undefined || label.cost < node.free.cost)) {
        node.free = label;
      }
    };
    let horizon = Math.min(n, k0 + PARSE_WINDOW);
    const cap = Math.min(n, horizon + LONG_MATCH);
    let j = k0;
    for (; j < horizon; j++) {
      // A literal from each position reaches the next, so every position
      // up to the horizon is reached in a way a literal may follow.
      const { any, free } = nodes[j - k0] as Required<Node>;
      const at = base + j;
      const limit = limitAt(walk, j);
      const matchable = decodable(at, limit);
      let cost = this.priceLiteral(enc, walk, all[at], j, free.except);
      const top = model.pricedTop;
      const cheap = free === any && free.context === 1 && cost <= CHEAP_LITERAL;
      if (matchable) {
        cost += repeats.priceFlag(enc, false, free.context);
      }
      const literal: Label = {
        cost: free.cost + cost,
        from: j,
        step: undefined,
        reps: free.reps,
        context: top ? 1 : 0,
        except: undefined,
      };
      reach(j + 1, literal, true);
      if (!matchable || cheap) {
        continue;
      }
      const found =
        j === k0 ? first : this.candidates(state, walk, j, any.reps, this.register(enc, state, at));
      if (j > k0 && found.some((c) => c.length >= LONG_MATCH)) {
        break;
      }
      let shortest = MIN_MATCH;
      for (const { distance, length, rep } of found) {
        const head = any.cost + repeats.priceHead(enc, { distance, length, rep }, at, any.context);
        const lowest = rep === undefined ? shortest : REP_MIN;
        const longest = Math.min(length, cap - j);
        if (lowest <= longest) {
          horizon = Math.max(horizon, j + longest);
        }
        // A length's cost changes only with its bucket.
        const off = (rep === undefined ? MIN_MATCH : REP_MIN) - 1;
        let bucket = -1;
        let cost = 0;
        for (let l = lowest; l <= longest; l++) {
          const e = j + l;
          const b = 31 - Math.clz32(l - off);
          if (b !== bucket) {
            bucket = b;
            cost = head + repeats.priceLength(enc, { distance, length: l, rep }, limit);
          }
          const ruled = this.continuation(all, base + e, distance, e < n || walk.closed);
          const open = ruled === undefined || ruled !== syms[e];
          const target = nodes[e - k0];
          if (
            target !== undefined &&
            cost >= target.any.cost &&
            (!open || (target.free !== undefined && cost >= target.free.cost))
          ) {
            continue;
          }
          const taken: Match =
            rep === undefined ? { distance, length: l } : { distance, length: l, rep };
          const reps = any.reps.slice();
          cache(reps, taken);
          reach(e, { cost, from: j, step: taken, reps, context: 2, except: ruled }, open);
        }
        if (rep === undefined) {
          shortest = length + 1;
        }
      }
    }
    // The plan ends where a literal may follow, or anyhow at the value's end.
    const end = nodes[j - k0] as Required<Node>;
    let label = j === n ? end.any : end.free;
    while (label.from >= 0) {
      plan.set(label.from, label.step);
      const prev = nodes[label.from - k0] as Required<Node>;
      label = label.step === undefined ? prev.free : prev.any;
    }
    this.planEnd = j;
  }

  /**
   * The match to take at item `k` of the value, where a candidate reaches
   * `LONG_MATCH` items, its flag in `context` and a literal there ruling
   * out `except`: of the longest earlier match that fits the units left and
   * the run at each cached distance no further back than the message
   * reaches, from `REP_MIN` items up to the value's end, the one saving most
   * of the cost, in `COST_UNITS`, of spelling its items, flag included, less
   * that of its copy, both priced by the model as it stands, a tie going to
   * the earlier.
   */
  private search(
    enc: Encoder,
    state: Message,
    walk: Walk,
    k: number,
    context: FlagContext,
    except: number | undefined,
    finder: Finder
  ): Match {
    const { repeats } = this;
    const { base, span, before } = walk;
    const all = state.items;
    const at = base + k;
    const limit = limitAt(walk, k);
    // The items left in the value add up to exactly the units the span
    // leaves, so a match, which the finder ends within the value, always
    // fits them.
    const candidates = finder.matches(all, at, span - before[k]).slice(-1);
    const left = all.length - at;
    state.reps.forEach((distance, rep) => {
      if (repeats.cached && distance <= at) {
        let length = 0;
        while (length < left && all[at + length - distance] === all[at + length]) {
          length++;
        }
        if (length >= REP_MIN) {
          candidates.push({ distance, length, rep });
        }
      }
    });
    // The cost of spelling the first `l` items, flag included, for every `l`
    // up to the longest candidate.
    let longest = 0;
    for (const candidate of candidates) {
      longest = Math.max(longest, candidate.length);
    }
    const { costs } = this;
    costs[0] = repeats.priceFlag(enc, false, context);
    costs[1] = costs[0] + this.priceLiteral(enc, walk, all[at], k, except);
    for (let j = k + 1; j < k + longest; j++) {
      costs[j - k + 1] = costs[j - k] + this.priceLiteral(enc, walk, all[base + j], j);
    }
    // The parse found a candidate of `LONG_MATCH` items here, so there is one.
    let best = candidates[0];
    let saved = -Infinity;
    for (const candidate of candidates) {
      const saving =
        costs[candidate.length] - repeats.priceMatch(enc, candidate, at, limit, context);
      if (saving > saved) {
        best = candidate;
        saved = saving;
      }
    }
    return best;
  }

  /**
   * Takes in `items`, a value the engine did not code, for repeats to copy
   * from. The encoder registers their positions with the finder at once,
   * as `write` does a value spelled without repeats.
   */
  learn(side: Encoder | Decoder, items: readonly number[]): void {
    const state = this.message(side);
    const all = state.items;
    const base = all.length;
    for (const item of items) {
      all.push(item);
    }
    if (side instanceof Encoder) {
      if (side.journal.active) {
        side.journal.truncate(all, base);
      }
      this.register(side, state, Infinity);
    }
  }

  /**
   * Reads the items of a value of `span` units after `lead`, or, where
   * `ends` is open, up to the end it reads, `span` the most units; returns
   * them and the units they add up to.
   */
  read(
    dec: Decoder,
    span: number,
    lead: readonly number[],
    first?: First,
    ends?: Ends
  ): [number[], number] {
    const { symbols, repeats } = this;
    const model = this.literals();
    const state = this.message(dec);
    const all = state.items;
    const base = all.length;
    const open = ends?.open === true ? ends : undefined;
    const used =
      (open === undefined ? possible(base, span, this.gate) : possibleOpen(base, this.gate)) &&
      repeats.readUsed(dec);
    let units = 0;
    let [row, history] = opening(symbols, lead, (item) => this.symbol(dec, item));
    let context: FlagContext = 0;
    let except = first?.except;
    const [start, edge] = open === undefined ? [0, 1] : leadOf(symbols, lead);
    let last = edge;
    // Whether the end was read.
    let done = false;
    const take = (item: number, sym: number): void => {
      all.push(item);
      last = symbols.units(item);
      units += last;
      history = advance(history, sym);
      row = symbols.row(item);
    };
    /** The item `sym` read spells, its tail read. */
    const untail = (sym: number): number =>
      this.admitted(sym) ? (this.grown as GrownAlphabet).item(dec, sym) : this.untail(dec, sym);
    /** Whether the value, spelling its end, may end after the items so far. */
    const may = (): boolean => endable(open as Ends, start + units, last);
    /** The units a repeat here is coded under: those the span leaves, up to the largest bound where the end is spelled. */
    const limit = (): number =>
      open === undefined ? span - units : Math.min(span - units, MAX_REPEAT_BOUND);
    const matchable = (): boolean => used && decodable(all.length, limit());
    /**
     * Reads a word `writeWord` wrote, from its token to what ends it, and
     * returns whether that is a match's flag.
     */
    const readWord = (prev: number): boolean => {
      const words = this.words as WordModel;
      const contexts = model as ContextModel;
      const begin = all.length;
      const id = words.read(dec, prev);
      let cost = 0;
      let hits = true;
      let flag: FlagContext = 0;
      let word = '';
      if (id === -1) {
        for (;;) {
          // The flag before a letter is the letters' cost; the one before
          // what ends the word is either spelling's.
          let price = 0;
          if (all.length > begin) {
            if (units >= span) {
              break;
            }
            if (matchable()) {
              price = this.repeats.priceFlag(dec, false, flag);
              if (this.repeats.readFlag(dec, flag)) {
                this.closeWord(dec, prev, word, id, hits, cost);
                return true;
              }
            }
          }
          const sym = model.read(
            dec,
            row,
            history,
            all.length === begin ? except : undefined,
            open !== undefined && may()
          );
          const paid = contexts.readUnits;
          if (sym === this.end) {
            hits &&= paid >= 0;
            done = true;
            break;
          }
          const item = untail(sym);
          take(item, sym);
          if (!this.letter(item)) {
            hits &&= paid >= 0 && this.plain(item, sym);
            break;
          }
          hits &&= paid >= 0;
          cost += price + paid;
          word += String.fromCharCode(item);
          flag = contexts.hitTop(dec) ? 1 : 0;
        }
        this.closeWord(dec, prev, word, id, hits, cost);
        return false;
      }
      // A word past the span overruns it, which `readBody` refuses.
      word = words.word(dec, id);
      for (let j = 0; j < word.length; j++) {
        if (j > 0 && matchable()) {
          cost += this.repeats.priceFlag(dec, false, flag);
          this.learnFlag(dec, false, flag);
        }
        const item = word.charCodeAt(j);
        const sym = this.symbol(dec, item);
        const paid = contexts.absorb(
          dec,
          sym,
          row,
          history,
          j === 0 ? except : undefined,
          open !== undefined && may()
        );
        hits &&= paid >= 0;
        cost += paid;
        take(item, sym);
        flag = contexts.hitTop(dec) ? 1 : 0;
      }
      if (units < span) {
        if (matchable() && this.repeats.readFlag(dec, flag)) {
          this.closeWord(dec, prev, word, id, hits, cost);
          return true;
        }
        const sym = model.read(dec, row, history, undefined, open !== undefined && may());
        const paid = contexts.readUnits;
        if (sym === this.end) {
          hits &&= paid >= 0;
          done = true;
        } else {
          const item = untail(sym);
          hits &&= paid >= 0 && this.plain(item, sym);
          take(item, sym);
        }
      }
      this.closeWord(dec, prev, word, id, hits, cost);
      return false;
    };
    let ending = false;
    while (!done && units < span) {
      bounded(all.length - base, open === undefined ? span : units + 1);
      const at = all.length;
      const left = limit();
      if (ending || (used && decodable(at, left) && repeats.readFlag(dec, context))) {
        ending = false;
        const match = repeats.readMatch(dec, at, left, state.reps);
        const { distance, length } = match;
        // The encoder holds a message's items in one JS array, so no match
        // it wrote grows them past the bound.
        if (length > MAX_REPEAT_BOUND - at) {
          throw new CorruptInputError(
            `Repeat length ${length} is above the maximum ${MAX_REPEAT_BOUND - at}`
          );
        }
        state.copied += length;
        const most = REPEAT_YIELD * dec.digits;
        if (state.copied > most) {
          throw new CorruptInputError(
            `Repeats copy more than ${most} items from ${dec.digits} digits of input`
          );
        }
        for (let j = 0; j < length; j++) {
          const item = all[all.length - distance];
          const sym = this.symbol(dec, item);
          if (j < MATCH_LEARNED) {
            model.learn(dec, sym, row, history);
          }
          take(item, sym);
        }
        cache(state.reps, match);
        context = 2;
        // Where the end is spelled, a literal after the match is read even
        // at the value's end: the end itself.
        except = this.continuation(all, all.length, distance, open !== undefined || units < span);
        continue;
      }
      const prev = at > base ? all[at - 1] : lead.length > 0 ? lead[lead.length - 1] : -1;
      if (this.opens(dec, model, prev)) {
        ending = readWord(prev);
        context = model.hitTop(dec) ? 1 : 0;
        except = undefined;
        continue;
      }
      const sym = model.read(dec, row, history, except, open !== undefined && may());
      if (sym === this.end) {
        done = true;
      } else if (this.admitted(sym)) {
        take((this.grown as GrownAlphabet).item(dec, sym), sym);
      } else {
        take(this.untail(dec, sym), sym);
      }
      context = model.hitTop(dec) ? 1 : 0;
      except = undefined;
    }
    this.close(dec, model, ends, done, row, history);
    return [all.slice(base), units];
  }
}

/**
 * The repeat history of an engine's message: the items so far, the
 * repeats' finder and cached distances. Shared within a pool, so nodes of
 * one pool learn together within a message and start over with the next.
 */
const HISTORY: ProviderKind<Pool | undefined, Message> = {
  name: 'history',
  key: (pool) => poolKey(pool),
  init: () => ({
    items: [],
    next: 0,
    copied: 0,
    reps: [...FIRST_REPS],
  }),
};

/**
 * The learned spelling of `symbols` for values of `kind` under `window`:
 * contexts over an adaptive prior whose rows learn as one, and learned
 * repeats; an alphabet that grows admits its items once for every kind.
 * Its providers are shared within `pool`, else its own: the repeat
 * history and statistics, the vocabulary and the grown alphabet across
 * every kind, the character odds, the contexts and their stops per kind.
 */
function learned<T>(symbols: Symbols<T>, window: number, kind: number, pool?: Pool): Engine<T> {
  const { who, size, rows } = symbols;
  const grown =
    symbols.range === undefined
      ? undefined
      : new GrownAlphabet(size, window, symbols.range.bind(symbols), pool);
  const members = grown === undefined ? size : size + 1;
  const weights = rows ?? [new Array<number>(members).fill(1)];
  const ofKind = pool === undefined ? undefined : { ...pool, kind };
  const options = { ...symbols.prior, pooled: true, pool: ofKind };
  const model = (): ContextModel => {
    const prior = new AdaptivePrior(weights, members, window, who, undefined, options);
    return grown === undefined
      ? new ContextModel(prior, size, who, ofKind)
      : new ContextModel(new GrownPrior(prior, grown), grown.size, who, ofKind);
  };
  const words = symbols.letter === undefined ? undefined : new WordModel(pool);
  return new Engine(symbols, model, new Repeats(pool), WARMUP, grown, words, pool);
}

/** A value's items as the encoder walks them: the model they are priced in, their symbols, and the row, history and units before each. */
interface Walk {
  readonly model: Literals;
  /** The items of the message before the value. */
  readonly base: number;
  readonly span: number;
  readonly syms: readonly number[];
  readonly rows: readonly number[];
  readonly histories: readonly (readonly number[])[];
  /** The units before each item, and after the last. */
  readonly before: readonly number[];
  /** The item before the value's first, -1 for none. */
  readonly prev: number;
  /** Where the end is a symbol, its bounds; `syms`, `rows` and `histories` hold one more entry, the end's. */
  readonly ends?: Ends;
  /** The units of the start the value shares with another, where the end is a symbol. */
  readonly start: number;
  /** Where the end is spelled, whether the value may end before each item and after the last. */
  readonly may: readonly boolean[];
  /** Whether the end is spelled after the items: not where the value reaches its most units. */
  readonly closed: boolean;
}

/**
 * The units a repeat at item `j` of `walk` is coded under: those the span
 * leaves, or where the end is spelled, those the most units leave, up to
 * the largest bound.
 */
const limitAt = (walk: Walk, j: number): number =>
  walk.ends?.open === true
    ? Math.min(walk.ends.high - walk.start - walk.before[j], MAX_REPEAT_BOUND)
    : walk.span - walk.before[j];

/** The methods of a sequence of bytes, which `.adaptive()` opens. */
export const BYTES_METHODS: readonly MethodName[] = [
  'learn',
  'delta',
  'recall',
  'repeats',
  'terminated',
];

/** The methods of a sequence of text, which `.adaptive()` opens: those of bytes, and the field spellings. */
export const TEXT_METHODS: readonly MethodName[] = [...BYTES_METHODS, 'digits', 'positional'];

/** Thrown out of a try of positions, where the end would be spelled, for a length they never met. */
const SPAN = new Error('Positions never met the length');

/** The spellings a sequence picks among, after its plain one: declared, they pin it. */
const SPELLINGS: readonly MethodName[] = ['delta', 'digits', 'positional'];

/** The spellings that read the value's length. */
const FIELD_SPELLINGS: readonly MethodName[] = ['digits', 'positional'];

/** How much of the lead each value keeps, so the choice of the end follows the node's latest values. */
const KEEP = 15 / 16;

/** One message's evidence for spelling a node's ends on one side. */
interface Evidence {
  /** How often each length met, by its distance from the floor, and how many values. */
  readonly lengths: Map<number, number>;
  values: number;
  /**
   * What the ends cost lately less what the lengths would have, in
   * `COST_UNITS`, each value weighing `KEEP` times the one after it.
   */
  lead: number;
}

/**
 * The choice of spelling a node's values with their end instead of their
 * length, from evidence both sides keep alike, so no symbol carries it:
 * while the ends have lately cost less than the lengths would have, the
 * next value spells its end. `declared` pins it.
 */
export class EndChoice {
  constructor(readonly declared: boolean) {}

  private evidence(side: Encoder | Decoder): Evidence {
    return side.state<Evidence>(this, () => ({ lengths: new Map(), values: 0, lead: 0 }));
  }

  /** Whether the node's next value on `side` spells its end. */
  open(side: Encoder | Decoder): boolean {
    return this.declared || this.evidence(side).lead < 0;
  }

  /**
   * Counts a value on `side` `count` past the length's floor whose end
   * cost `cost`, and moves the lead by that less what its length would
   * have cost: its share of the node's values, or an escape to a new length
   * on the gamma scale where the node never had it. A value whose end the
   * body neither coded nor priced, no `cost`, leaves the lead as it was.
   */
  settle(side: Encoder | Decoder, count: number, cost: number | undefined): void {
    const state = this.evidence(side);
    const { journal } = side;
    const { lengths, values, lead } = state;
    const had = lengths.get(count);
    const length =
      had === undefined
        ? log2Units(values + 1) + (2 * (31 - Math.clz32(count + 1)) + 1) * COST_UNITS
        : log2Units(values + 1) - log2Units(had);
    if (journal?.active === true) {
      journal.call(() => {
        if (had === undefined) {
          lengths.delete(count);
        } else {
          lengths.set(count, had);
        }
        state.values = values;
        state.lead = lead;
      });
    }
    lengths.set(count, (had ?? 0) + 1);
    state.values = values + 1;
    if (cost !== undefined) {
      state.lead = (lead + cost - length) * KEEP;
    }
  }
}

/** How many values of a length a node spells before positions can spell the next one. */
const POSITIONAL_GATE = 1;

/**
 * What one side knows of a sequence in a message: its previous value's
 * items, the span of the value being coded, and whether that value spells
 * its end, its span then known only to the encoder until it is read.
 */
interface Track {
  prev?: number[];
  span: number;
  open: boolean;
  /** Whether the body coded the value's items: its repeats then hold them, and it coded or priced the end. */
  inBody: boolean;
}

/** No items: the start a value shares with none. */
const NONE: readonly number[] = [];

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** The most length prefixes a sequence keeps the cost of. */
const MAX_LENGTH_COSTS = 4096;

/**
 * A sequence of items in an alphabet, under length bounds, by the methods
 * it has (`MethodSet`). Where it learns, the symbols learn, together with
 * every other learning sequence of the alphabet's pool and the same window
 * unless `separate`, and the length with them, over its range when there
 * is a max and on the learned magnitude scale from the min when there is
 * none. The length always learns on its own. Sequences of one pool and
 * window share their repeats whatever their `kind`, and their contexts and
 * prior only within one.
 *
 * Declared, `repeats` copies earlier stretches of the node's own values at
 * fixed odds (learning sequences always copy, learned); `delta` spells each
 * value after the first by the start it shares with the node's previous
 * one; `recall` spells a value the node already wrote by its place among
 * the distinct ones, ahead of the rest. In an alphabet that knows its
 * digits, `digits` spells each value as digit fields and `positional` a
 * value of a span the node met before by its places (`./fields`); where
 * several are declared, positions take the values they can, then digit
 * fields, then the delta. With the methods open and none declared, each
 * value from the node's second on picks among the plain spelling, the
 * delta and, in such an alphabet, the field spellings, by a learned mode.
 *
 * The delta writes, after the length prefix, how many items of the
 * previous value the value starts with, out of the most whose units fit
 * its span, every count alike or learned; then the items after them,
 * priced as the items after that shared start.
 *
 * Declared, `terminated` writes no length prefix: the end of the value is
 * one more symbol after its items, which the delta may follow all of the
 * previous value with. Open, with a length that varies and no length
 * prior or field spelling declared, each value spells its end while ends
 * have lately cost less than the lengths would (`EndChoice`); such a value
 * can still take the field spellings after its length, positions once the
 * node met any length.
 *
 * Every value the node codes, recalled or spelled, then teaches what the
 * node keeps of its values, in order: the repeats' items, the delta's
 * shared start, the digit fields, the positions, the choice of the end,
 * and last the previous value.
 */
export class Sequence<T> {
  private readonly length: IndexRange;
  /** The floor of the length. */
  private readonly min: number;
  /** The learned length of an adaptive sequence without a max, from `min`. */
  private readonly lengths?: LearnedMagnitude;
  /** The items after the length prefix: one symbol each, or the engine with repeats. */
  private readonly body: Body;
  /** The learned length of the shared start under adaptive; every length alike otherwise. */
  private readonly shared?: LearnedMagnitude;
  /** The shared start of a run's value: on the gamma scale, learned apart under adaptive. */
  private readonly front: Magnitude = GAMMA_MAGNITUDE;
  /** Whether the node keeps its previous value: when a delta or digit fields may spell a value. */
  private readonly tracks: boolean;
  /** Whether the delta is declared: it spells each value the field spellings leave, from the node's second. */
  private readonly differs: boolean;
  /** The learned choice among the methods, under adaptive without a declared one. */
  private readonly choice?: ModeChoice<number[]>;
  /** Digit fields and positions, declared or open to the choice: only in an alphabet that knows its digits. */
  private readonly digits?: Method<number[]>;
  private readonly positions?: Method<number[]>;
  /** What every value the node codes teaches, in order. */
  private readonly providers: readonly ValueProvider<number[]>[];
  /** Whether a method is declared, which pins the spelling: positions where they apply, then digit fields, then the delta. */
  private readonly declared: boolean;
  private readonly recall?: Recall<T>;
  /** The overrun error, `Code points overrun the length prefix`. */
  private readonly overrun: string;
  /** The ends of a value that spells its end, and of one that only learns it, where the end is a symbol. */
  private readonly spelled?: Ends;
  private readonly learned?: Ends;
  /** Whether a value spells its end, declared or learned. */
  private readonly ending?: EndChoice;

  constructor(
    private readonly symbols: Symbols<T>,
    bounds: LengthBounds,
    methods: MethodSet = {},
    kind = 0
  ) {
    const { who, size, rows } = symbols;
    const learning = learningOf(methods);
    // Without a max the length learns on the magnitude scale, `lengths`.
    this.length = lengthRange(
      bounds,
      who,
      symbols.noun,
      bounds.max === undefined ? undefined : learning
    );
    // A length range always has its floor, 0 unless declared.
    this.min = this.length.lo as number;
    this.declared = declaresAny(methods, SPELLINGS);
    const fields = declaresAny(methods, FIELD_SPELLINGS);
    const terminated = methods.terminated === 'declared';
    if (terminated && fields) {
      throw new TypeError(
        `${who} terminated cannot combine with digits or positional, which read the length`
      );
    }
    if (terminated && bounds.prior !== undefined) {
      throw new TypeError(`${who} terminated has no length for a cdf or weights to weigh`);
    }
    const hi = this.length.hi;
    if (
      terminated ||
      (methods.terminated === 'open' && !fields && bounds.prior === undefined && hi !== this.min)
    ) {
      const ends = {
        low: symbols.span(this.min),
        high: hi === undefined ? Infinity : symbols.span(hi),
        step: symbols.span(1),
      };
      this.spelled = { ...ends, open: true };
      this.learned = { ...ends, open: false };
      this.ending = new EndChoice(terminated);
    }
    let engine: Engine<T> | undefined;
    // What a learned choice of the end learns from: the cost of the end the engine coded or priced.
    let settles: ValueProvider<number[]> | undefined;
    if (learning === undefined) {
      if (methods.repeats !== undefined) {
        engine = new Engine(symbols, () => new StaticLiterals(symbols), EVEN_REPEATS, 0);
      }
    } else {
      const window = checkAdaptation(learning, who).window ?? DEFAULT_ADAPTIVE_WINDOW;
      const pool = learning.separate === true ? undefined : { pool: symbols.pool, window };
      const spelling = learned(symbols, window, kind, pool);
      engine = spelling;
      const { ending } = this;
      if (ending !== undefined && !ending.declared) {
        settles = { learn: (side) => this.settle(side, ending, spelling) };
      }
      if (bounds.max === undefined) {
        this.lengths = new LearnedMagnitude(false, learning, who);
      }
      this.shared = new LearnedMagnitude(false, learning, who);
      this.front = new LearnedMagnitude(false, learning, who, 'gamma');
    }
    this.body =
      engine ?? new Spelled(symbols, members(size, rows === undefined ? undefined : { rows }, who));
    const providers: ValueProvider<number[]>[] = [];
    if (engine !== undefined) {
      providers.push(this.history(engine));
    }
    // The choice among the methods, with none declared to pin the spelling.
    const open = chooses(methods, SPELLINGS);
    this.tracks = this.declared || open;
    this.differs = methods.delta === 'declared';
    if (this.tracks && this.shared !== undefined) {
      providers.push(this.sharedStart(this.shared));
    }
    let digits: DigitFields | undefined;
    let positional: Positional | undefined;
    // A declared end writes no length for the field spellings to read.
    if (symbols.digit !== undefined && !terminated) {
      const host = this.host();
      const learned = learning !== undefined;
      if (open || methods.digits === 'declared') {
        digits = new DigitFields(host, { learned, delta: methods.delta === 'declared' });
        this.digits = this.withLength(digits);
        if (learned) {
          providers.push(digits);
        }
      }
      if (open || methods.positional === 'declared') {
        positional = new Positional(host, { learned, gate: POSITIONAL_GATE });
        this.positions = this.withLength(positional, positional);
        providers.push(positional);
      }
    }
    if (open) {
      const choices: Method<number[]>[] = [this.plain(), this.delta()];
      if (this.digits !== undefined) {
        choices.push(this.digits);
      }
      if (this.positions !== undefined) {
        choices.push(this.positions);
      }
      this.choice = new ModeChoice(choices, learning, who);
    }
    if (settles !== undefined) {
      providers.push(settles);
    }
    if (this.tracks) {
      // The track was retracked as the value began, so a transaction takes
      // this back with the rest of it.
      providers.push({
        learn: (side, items) => {
          this.track(side).prev = items;
        },
      });
    }
    this.providers = providers;
    this.recall = recallOf<T>(methods, symbols.copy?.bind(symbols));
    const { item } = symbols;
    this.overrun = `${item.charAt(0).toUpperCase()}${item.slice(1)}s overrun the ${symbols.noun} prefix`;
  }

  /** The cost of each length prefix `lengthUnits` priced, by count. */
  private readonly lengthCosts = new Map<number, number>();

  /**
   * The cost, in `COST_UNITS`, of the length prefix of a value of `count`,
   * Infinity where it cannot take that length: what writing it charges, for
   * a sequence whose length does not learn.
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

  /** What the field spellings read of the node. */
  private host(): FieldHost {
    return {
      symbols: this.symbols as Symbols<unknown>,
      span: (side) => this.track(side).span,
      prev: (side) => this.track(side).prev,
      writeBody: (enc, items, span) => this.body.write(enc, items, span, NONE),
      readBody: (dec, span) => this.readBody(dec, span, NONE),
    };
  }

  /**
   * The method spelling by `coding`, which reads the value's span and
   * codes the items apart from the body. Where the value would spell its end, its
   * length is written first; positions (`layouts`) are then available once
   * the node met any length often enough, and refuse a value of a length
   * they cannot spell.
   */
  private withLength(coding: Method<number[]>, layouts?: Positional): Method<number[]> {
    return {
      available: (side) =>
        !this.track(side).open || layouts === undefined
          ? coding.available(side)
          : layouts.met(side),
      write: (enc, items) => {
        const track = this.retrack(enc);
        track.inBody = false;
        if (track.open) {
          if (!coding.available(enc)) {
            throw SPAN;
          }
          this.writeCount(enc, track.span / this.symbols.span(1));
        }
        coding.write(enc, items);
      },
      read: (dec) => {
        const track = this.track(dec);
        track.inBody = false;
        if (track.open) {
          track.span = this.readLength(dec);
        }
        return coding.read(dec);
      },
    };
  }

  /** The plain spelling as a mode: the items in full. */
  private plain(): Method<number[]> {
    return {
      available: () => true,
      write: (enc, items) =>
        this.body.write(enc, items, this.track(enc).span, NONE, undefined, this.ends(enc)),
      read: (dec) => this.readBody(dec, this.track(dec).span, NONE, undefined, this.ends(dec)),
    };
  }

  /** The ends of the value `side` codes now, as its track says: none where the end is no symbol. */
  private ends(side: Encoder | Decoder): Ends | undefined {
    return this.track(side).open ? this.spelled : this.learned;
  }

  /** The delta as a mode, once the node has a previous value. */
  private delta(): Method<number[]> {
    return {
      available: (side) => this.track(side).prev !== undefined,
      write: (enc, items) =>
        this.writeDelta(enc, items, this.track(enc).span, this.previousItems(enc)),
      read: (dec) => this.readDelta(dec, this.track(dec).span, this.previousItems(dec)),
    };
  }

  /**
   * The start each value from the node's second shares with its previous
   * one, on `scale`, which learns it whichever spelling the value took.
   */
  private sharedStart(scale: Magnitude): ValueProvider<number[]> {
    return {
      learn: (side, items) => {
        const { prev, span } = this.track(side);
        if (prev !== undefined) {
          const bound = this.bound(side, prev, span);
          scale.learn(side, this.sharing(items, prev, bound), 0, 0, bound);
        }
      },
    };
  }

  /**
   * The engine's repeats, which take in a value the body did not code, so
   * later values can copy from it: they hold those the body coded already.
   */
  private history(engine: Engine<T>): ValueProvider<number[]> {
    return {
      learn: (side, items) => {
        if (!this.track(side).inBody) {
          engine.learn(side, items);
        }
      },
    };
  }

  /**
   * Counts the value just coded on `side` in the choice of the end: its
   * length, and what its end cost where the body coded or priced it.
   */
  private settle(side: Encoder | Decoder, ending: EndChoice, engine: Engine<T>): void {
    const track = this.track(side);
    const count = track.span / this.symbols.span(1) - this.min;
    ending.settle(side, count, track.inBody ? engine.endUnits : undefined);
  }

  /** This message's track of the node on `side`. */
  private track(side: Encoder | Decoder): Track {
    return side.state<Track>(this, () => ({ span: 0, open: false, inBody: false }));
  }

  /** This message's track of the node on `side`, about to change: a transaction open restores it as it stands. */
  private retrack(side: Encoder | Decoder): Track {
    const track = this.track(side);
    if (side.journal?.active === true) {
      const { prev, span, open, inBody } = track;
      side.journal.call(() => {
        track.prev = prev;
        track.span = span;
        track.open = open;
        track.inBody = inBody;
      });
    }
    return track;
  }

  /** The items of the node's previous value on `side`, which the delta, available only once there is one, reads. */
  private previousItems(side: Encoder | Decoder): readonly number[] {
    return this.track(side).prev as number[];
  }

  /**
   * The most items of `prev` a delta's value of `span` units on `side` can
   * start with: as many as fit the span, or all of them where the value
   * spells its end, its span unknown to the decoder.
   */
  private bound(side: Encoder | Decoder, prev: readonly number[], span: number): number {
    return this.track(side).open ? prev.length : this.reach(prev, span);
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

  /** The units of the first `count` items of `items`. */
  private unitsOf(items: readonly number[], count: number): number {
    let units = 0;
    for (let k = 0; k < count; k++) {
      units += this.symbols.units(items[k]);
    }
    return units;
  }

  /** Writes `items`, a value of `span` units, as the start it shares with `prev` and the items after it. */
  private writeDelta(
    enc: Encoder,
    items: readonly number[],
    span: number,
    prev: readonly number[]
  ): void {
    const bound = this.bound(enc, prev, span);
    const shared = this.sharing(items, prev, bound);
    if (this.shared === undefined) {
      enc.compose(shared, bound + 1);
    } else {
      this.shared.write(enc, shared, 0, 0, bound);
    }
    const lead = prev.slice(0, shared);
    const rest = span - this.unitsOf(prev, shared);
    this.body.write(enc, items.slice(shared), rest, lead, undefined, this.ends(enc));
  }

  /** Reads the items `writeDelta` wrote after the same `prev`. */
  private readDelta(dec: Decoder, span: number, prev: readonly number[]): number[] {
    const bound = this.bound(dec, prev, span);
    const shared =
      this.shared === undefined ? dec.parse(bound + 1) : this.shared.read(dec, 0, 0, bound);
    const lead = prev.slice(0, shared);
    const rest = span - this.unitsOf(prev, shared);
    return lead.concat(this.readBody(dec, rest, lead, undefined, this.ends(dec)));
  }

  /**
   * Reads the items of `span` units after `lead`, the first known as
   * `first`, refusing any that overrun it; where `ends` is open, up to the
   * end, `span` the most units, which then become the track's span.
   */
  private readBody(
    dec: Decoder,
    span: number,
    lead: readonly number[],
    first?: First,
    ends?: Ends
  ): number[] {
    const [items, units] = this.body.read(dec, span, lead, first, ends);
    if (ends?.open === true) {
      this.track(dec).span = this.unitsOf(lead, lead.length) + units;
    }
    // An item wider than one unit in the final slot, or a repeat copying
    // past the span, can overshoot it; no value encodes that way.
    if (units > span) {
      throw new CorruptInputError(this.overrun);
    }
    return items;
  }

  write(enc: Encoder, value: T): void {
    const recall = this.recall;
    if (recall === undefined) {
      this.spell(enc, value);
      return;
    }
    const symbols = this.symbols;
    const key = symbols.identity?.(value) ?? symbols.items(value).join();
    if (recall.write(enc, key, () => this.spell(enc, value))) {
      this.recalled(enc, symbols.items(value));
    }
  }

  read(dec: Decoder): T {
    const recall = this.recall;
    if (recall === undefined) {
      return this.unspell(dec);
    }
    let spelled = false;
    const value = recall.read(dec, () => {
      spelled = true;
      return this.unspell(dec);
    });
    if (!spelled) {
      this.recalled(dec, this.symbols.items(value));
    }
    return value;
  }

  /** After a value of `items` recalled on `side`, which spelled neither its length nor its end: what it teaches. */
  private recalled(side: Encoder | Decoder, items: number[]): void {
    const track = this.retrack(side);
    track.span = this.unitsOf(items, items.length);
    track.open = false;
    track.inBody = false;
    this.after(side, items);
  }

  /** Writes the length prefix of `value` and returns the span of its items. */
  private writeLength(enc: Encoder, value: T): number {
    const symbols = this.symbols;
    const count = symbols.count(value);
    this.writeCount(enc, count, () => symbols.subject(value));
    return symbols.span(count);
  }

  /**
   * Writes the length prefix `count` and learns it, `subject` naming the
   * value in an error; without one, of a value whose length was checked
   * already.
   */
  private writeCount(enc: Encoder, count: number, subject?: () => string): void {
    if (this.lengths === undefined) {
      this.length.write(enc, count, subject);
      this.length.learn(enc, count);
    } else {
      if (subject !== undefined) {
        checkIndex(count, this.min, undefined, subject);
      }
      this.lengths.write(enc, count, this.min, this.min, MAX_SAFE);
      this.lengths.learn(enc, count, this.min, this.min, MAX_SAFE);
    }
  }

  /** The span of `value`, which spells its end instead of its length, refusing a length out of bounds. */
  private spanOf(value: T): number {
    const symbols = this.symbols;
    const count = symbols.count(value);
    checkIndex(count, this.min, this.length.hi, () => symbols.subject(value));
    return symbols.span(count);
  }

  /** Reads a length prefix `writeLength` wrote, learns it, and returns the span of the items after it. */
  private readLength(dec: Decoder): number {
    const symbols = this.symbols;
    let count: number;
    if (this.lengths === undefined) {
      count = this.length.read(dec);
      this.length.learn(dec, count);
    } else {
      count = this.lengths.read(dec, this.min, this.min, MAX_SAFE);
      this.lengths.learn(dec, count, this.min, this.min, MAX_SAFE);
    }
    symbols.check?.(count);
    dec.charge(count);
    return symbols.span(count);
  }

  /**
   * Writes `value` in full: its length, unless it spells its end, then its
   * items by the method the node takes for it.
   */
  private spell(enc: Encoder, value: T): void {
    const open = this.ending?.open(enc) === true;
    const span = open ? this.spanOf(value) : this.writeLength(enc, value);
    const items = this.symbols.items(value);
    const track = this.retrack(enc);
    track.span = span;
    track.open = open;
    track.inBody = true;
    const { choice, positions, digits } = this;
    const { prev } = track;
    if (choice !== undefined) {
      choice.write(enc, items);
    } else if (positions?.available(enc) === true) {
      positions.write(enc, items);
    } else if (digits !== undefined) {
      digits.write(enc, items);
    } else if (this.differs && prev !== undefined) {
      this.writeDelta(enc, items, span, prev);
    } else {
      this.body.write(enc, items, span, NONE, undefined, this.ends(enc));
    }
    this.after(enc, items);
  }

  /** Teaches every provider `items`, the value just coded on `side`. */
  private after(side: Encoder | Decoder, items: number[]): void {
    for (const provider of this.providers) {
      provider.learn(side, items);
    }
  }

  /** Reads a value `spell` wrote. */
  private unspell(dec: Decoder): T {
    const { ending, choice, positions, digits } = this;
    const open = ending?.open(dec) === true;
    // Where the value spells its end, its items reach at most the most units.
    const track = this.track(dec);
    track.span = open ? (this.spelled as Ends).high : this.readLength(dec);
    track.open = open;
    track.inBody = true;
    const { prev } = track;
    let items: number[];
    if (choice !== undefined) {
      items = choice.read(dec);
    } else if (positions?.available(dec) === true) {
      items = positions.read(dec);
    } else if (digits !== undefined) {
      items = digits.read(dec);
    } else if (this.differs && prev !== undefined) {
      items = this.readDelta(dec, track.span, prev);
    } else {
      items = this.readBody(dec, track.span, NONE, undefined, this.ends(dec));
    }
    this.after(dec, items);
    return this.symbols.build(items);
  }

  /** The items `value` is spelled in. */
  items(value: T): number[] {
    return this.symbols.items(value);
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
   * of the counts `ascent` leaves possible, on the gamma scale, which
   * learns under adaptive apart from the delta's; then the items after them,
   * priced as following that shared start. The first of those is not the
   * item of `prev` after the start, whose symbol is ruled out where it
   * stands for that item alone. A value the node already wrote is recalled
   * as `write` recalls it. The node's previous value stays as it was.
   */
  writeNext(enc: Encoder, value: T, prev: readonly number[] | undefined, ascent: Ascent): number[] {
    const symbols = this.symbols;
    const items = symbols.items(value);
    const spell = (): void => {
      const span = this.writeLength(enc, value);
      if (prev === undefined) {
        this.body.write(enc, items, span, NONE);
        return;
      }
      const most = this.most(prev, span, ascent);
      const shared = this.sharing(items, prev, most);
      this.front.write(enc, shared, 0, 0, most);
      this.front.learn(enc, shared, 0, 0, most);
      const rest = span - this.unitsOf(prev, shared);
      const first = this.first(prev, shared, ascent);
      this.body.write(enc, items.slice(shared), rest, prev.slice(0, shared), first);
    };
    const recall = this.recall;
    if (recall === undefined) {
      spell();
    } else {
      recall.write(enc, symbols.identity?.(value) ?? items.join(), spell);
    }
    return items;
  }

  /** Reads a value `writeNext` wrote after the same `prev`, and its items. */
  readNext(dec: Decoder, prev: readonly number[] | undefined, ascent: Ascent): [T, number[]] {
    const symbols = this.symbols;
    let items: number[] = [];
    const spell = (): T => {
      const span = this.readLength(dec);
      if (prev === undefined) {
        items = this.readBody(dec, span, NONE);
      } else {
        const most = this.most(prev, span, ascent);
        if (most < 0) {
          throw new CorruptInputError('An empty value follows another in an ascending run');
        }
        const shared = this.front.read(dec, 0, 0, most);
        this.front.learn(dec, shared, 0, 0, most);
        const lead = prev.slice(0, shared);
        const rest = span - this.unitsOf(prev, shared);
        items = lead.concat(this.readBody(dec, rest, lead, this.first(prev, shared, ascent)));
      }
      return symbols.build(items);
    };
    const recall = this.recall;
    if (recall === undefined) {
      const value = spell();
      return [value, items];
    }
    let spelled = false;
    const value = recall.read(dec, () => {
      spelled = true;
      return spell();
    });
    return [value, spelled ? items : symbols.items(value)];
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
    const whole = this.unitsOf(prev, bound) === span;
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

/**
 * What a run's value is known to be against the one before it, by its
 * items: nothing (`any`), not below it (`sorted`), or above it (`unique`).
 */
export type Ascent = 'any' | 'sorted' | 'unique';
