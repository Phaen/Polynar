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
  SlotCache,
  COST_UNITS,
  costUnits,
  log2Units,
} from '../packer';
import {
  AdaptivePrior,
  DEFAULT_ADAPTIVE_WINDOW,
  checkAdaptation,
  type PriorOptions,
  type SequenceAdaptiveOptions,
} from './adaptive';
import { ContextModel, MAX_ORDER, WARMUP } from './contexts';
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
import { ModeChoice, recallOf, type Method, type Spelling } from './methods';
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
  readonly pool: unknown;
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

/** The largest bound `Repeats` codes a distance or length under. */
const MAX_REPEAT_BOUND = 2 ** 32 - 1;

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
 * out: `ContextModel` under adaptive, `StaticLiterals` otherwise. `price`
 * is the cost, in `COST_UNITS`, `write` would give the symbol now,
 * learning nothing; `hitTop` is whether the last symbol coded was a
 * hit in the highest-order context.
 */
interface Literals {
  write(enc: Encoder, sym: number, row: number, history: readonly number[], except?: number): void;
  read(dec: Decoder, row: number, history: readonly number[], except?: number): number;
  learn(side: Encoder | Decoder, sym: number, row: number, history: readonly number[]): void;
  price(
    enc: Encoder,
    sym: number,
    row: number,
    history: readonly number[],
    except?: number
  ): number;
  hitTop(side: Encoder | Decoder): boolean;
  /** Whether the symbol `price` last priced would be a hit in the highest-order context. */
  readonly pricedTop: boolean;
}

/**
 * The symbols at the alphabet's static odds, for repeats that do not
 * learn: each row's weights, or every symbol alike in one row, as one
 * weighted symbol with `except` ruled out. The previous symbols play no
 * part, nothing is learned, and no symbol is a context hit.
 */
export class StaticLiterals implements Literals {
  private readonly tables: readonly Table[];
  /** The exclusion each symbol reuses. */
  private readonly exclusion: Exclusion;

  constructor(symbols: Symbols<unknown>) {
    const { who, size, rows } = symbols;
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
    except?: number
  ): void {
    writeExcluded(enc, this.table(row), this.ruling(except), sym);
  }

  read(dec: Decoder, row: number, _history: readonly number[], except?: number): number {
    return readExcluded(dec, this.table(row), this.ruling(except));
  }

  learn(): void {}

  price(
    _enc: Encoder,
    sym: number,
    row: number,
    _history: readonly number[],
    except?: number
  ): number {
    const [, freq, total] = excludedBucket(this.table(row), this.ruling(except), sym);
    return costUnits(freq, total);
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
 * of them, and the first is priced as the item after `lead`. `kind` picks
 * the model the symbols are priced in, where a body keeps more than one.
 * `first`, when given, is what is known of the first item's symbol, which
 * the body rules out what it can of.
 */
interface Body {
  write(
    enc: Encoder,
    items: readonly number[],
    span: number,
    lead: readonly number[],
    kind: number,
    first?: First
  ): void;
  /** Reads items until their units reach `span`, and the units they add up to. */
  read(
    dec: Decoder,
    span: number,
    lead: readonly number[],
    kind: number,
    first?: First
  ): [number[], number];
  /** Takes in `items`, a value another spelling coded, for repeats to copy from: where the body has them. */
  see?(side: Encoder | Decoder, items: readonly number[]): void;
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
    _kind: number,
    first?: First
  ): void {
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

  read(
    dec: Decoder,
    span: number,
    lead: readonly number[],
    _kind: number,
    first?: First
  ): [number[], number] {
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
   * Whether the engine's last value that could hold a repeat took them,
   * which only orders the next value's tries, the way it took tried first.
   */
  private used = true;
  /** The costs `search` works in, reused from one search to the next. */
  private readonly costs: number[] = [];

  /** The model of each kind of value, built on its first use. */
  private readonly models: Literals[] = [];

  /** The steps of the parse planned, by item of the value, a literal undefined. */
  private readonly plan = new Map<number, Match | undefined>();
  /** The item of the value the plan ends at, where the next parse starts. */
  private planEnd = -1;
  /** The positions a parse works in, from its first item on. */
  private readonly nodes: (Node | undefined)[] = [];

  constructor(
    private readonly symbols: Symbols<T>,
    private readonly literals: () => Literals,
    private readonly repeats: RepeatCoding,
    private readonly gate: number,
    private readonly grown?: GrownAlphabet,
    private readonly words?: WordModel
  ) {}

  /** The symbol of `item` on `side`: its own once admitted, else the alphabet's. */
  private symbol(side: Encoder | Decoder, item: number): number {
    const sym = this.grown?.symbol(side, item) ?? -1;
    return sym < 0 ? this.symbols.symbol(item) : sym;
  }

  /** Whether `sym`, an item's symbol, is an admitted item's, which carries no tail. */
  private admitted(sym: number): boolean {
    return sym > this.symbols.size;
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

  /** The model values of `kind` are priced in. */
  private model(kind: number): Literals {
    return (this.models[kind] ??= this.literals());
  }

  /** Each message's items. */
  private readonly messages = new SlotCache<Message, Encoder | Decoder>(this, () => ({
    items: [],
    next: 0,
    copied: 0,
    reps: [...FIRST_REPS],
  }));

  /** This message's items on `side`. */
  private message(side: Encoder | Decoder): Message {
    return this.messages.get(side);
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
    model: Literals
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
    for (let k = 0; k < items.length; k++) {
      rows.push(row);
      histories.push(history);
      before.push(before[k] + symbols.units(items[k]));
      history = advance(history, syms[k]);
      row = symbols.row(items[k]);
    }
    const prev = lead.length > 0 ? lead[lead.length - 1] : -1;
    return { model, base, span, syms, rows, histories, before, prev };
  }

  /**
   * Writes the items of a value of `span` units after `lead`. Where the
   * value can hold a repeat, the encoder decides between spelling it with
   * repeats and without, a tie going to repeats, trying first the way the
   * engine's previous such value took. A value spelled without repeats
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
    kind: number,
    first?: First
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
    const walk = this.walk(enc, items, span, lead, base, this.model(kind));
    if (!possible(base, span, this.gate)) {
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
    const { model, base, span, syms, rows, histories, before } = walk;
    let context: FlagContext = 0;
    // A match whose flag ended the word before it.
    let ending: Match | undefined;
    this.planEnd = -1;
    for (let k = 0; k < items.length; ) {
      const at = base + k;
      const limit = span - before[k];
      let match = ending;
      ending = undefined;
      if (match === undefined && used && decodable(at, limit)) {
        match = this.choose(enc, state, walk, k, context, except);
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
        except = this.continuation(state.items, base + k, match.distance, k < items.length);
        continue;
      }
      const prev = k === 0 ? walk.prev : items[k - 1];
      if (this.opens(enc, model, prev)) {
        [k, context, ending] = this.writeWord(enc, state, walk, items, k, prev, used, except);
        except = undefined;
        continue;
      }
      const sym = syms[k];
      model.write(enc, sym, rows[k], histories[k], except);
      if (!this.admitted(sym)) {
        this.tail(enc, items[k], sym);
      }
      context = model.hitTop(enc) ? 1 : 0;
      except = undefined;
      k++;
    }
  }

  /** Whether `item` is a letter of a word. */
  private letter(item: number): boolean {
    return this.symbols.letter?.(item) === true;
  }

  /** Whether `item`, spelled as `sym`, writes no tail. */
  private plain(item: number, sym: number): boolean {
    return this.admitted(sym) || this.symbols.tails(item, sym) === 1;
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
    const { base, span, syms, rows, histories, before } = walk;
    const n = items.length;
    const matchable = (j: number): boolean => used && decodable(base + j, span - before[j]);
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
    const literal = end === undefined && e < n;
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
        model.write(enc, syms[e], rows[e], histories[e], ruled(e));
        if (!this.admitted(syms[e])) {
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
        model.write(enc, syms[j], rows[j], histories[j], ruled(j));
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
    const { base, span, syms, rows, histories, before } = walk;
    let flag: FlagContext = 0;
    for (let j = k; j < e; j++) {
      if (j > k && used && decodable(base + j, span - before[j])) {
        this.learnFlag(enc, false, flag);
      }
      model.absorb(enc, syms[j], rows[j], histories[j], j === k ? except : undefined);
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
    const price = walk.model.price(enc, sym, walk.rows[j], walk.histories[j], except);
    return this.admitted(sym) ? price : price + log2Units(this.symbols.tails(item, sym));
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
    const { model, base, span, before, syms } = walk;
    const all = state.items;
    const n = syms.length;
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
      const limit = span - before[j];
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
          const ruled = this.continuation(all, base + e, distance, e < n);
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
    const limit = span - before[k];
    // The items left in the value add up to exactly `limit` units, so a
    // match, which the finder ends within the value, always fits them.
    const candidates = finder.matches(all, at, limit).slice(-1);
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
   * Adds `items` to the message, for repeats to copy from. The encoder
   * registers their positions with the finder at once, as `write` does a
   * value spelled without repeats.
   */
  see(side: Encoder | Decoder, items: readonly number[]): void {
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

  /** Reads the items of a value of `span` units after `lead`, and the units they add up to. */
  read(
    dec: Decoder,
    span: number,
    lead: readonly number[],
    kind: number,
    first?: First
  ): [number[], number] {
    const { symbols, repeats } = this;
    const model = this.model(kind);
    const state = this.message(dec);
    const all = state.items;
    const base = all.length;
    const used = possible(base, span, this.gate) && repeats.readUsed(dec);
    let units = 0;
    let [row, history] = opening(symbols, lead, (item) => this.symbol(dec, item));
    let context: FlagContext = 0;
    let except = first?.except;
    const take = (item: number, sym: number): void => {
      all.push(item);
      units += symbols.units(item);
      history = advance(history, sym);
      row = symbols.row(item);
    };
    /** The item `sym` read spells, its tail read. */
    const untail = (sym: number): number =>
      this.admitted(sym) ? (this.grown as GrownAlphabet).item(dec, sym) : this.untail(dec, sym);
    const matchable = (): boolean => used && decodable(all.length, span - units);
    /**
     * Reads a word `writeWord` wrote, from its token to what ends it, and
     * returns whether that is a match's flag.
     */
    const readWord = (prev: number): boolean => {
      const words = this.words as WordModel;
      const contexts = model as ContextModel;
      const start = all.length;
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
          if (all.length > start) {
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
          const sym = model.read(dec, row, history, all.length === start ? except : undefined);
          const paid = contexts.readUnits;
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
        const paid = contexts.absorb(dec, sym, row, history, j === 0 ? except : undefined);
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
        const sym = model.read(dec, row, history);
        const paid = contexts.readUnits;
        const item = untail(sym);
        hits &&= paid >= 0 && this.plain(item, sym);
        take(item, sym);
      }
      this.closeWord(dec, prev, word, id, hits, cost);
      return false;
    };
    let ending = false;
    while (units < span) {
      bounded(all.length - base, span);
      const at = all.length;
      const limit = span - units;
      if (ending || (used && decodable(at, limit) && repeats.readFlag(dec, context))) {
        ending = false;
        const match = repeats.readMatch(dec, at, limit, state.reps);
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
        except = this.continuation(all, all.length, distance, units < span);
        continue;
      }
      const prev = at > base ? all[at - 1] : lead.length > 0 ? lead[lead.length - 1] : -1;
      if (this.opens(dec, model, prev)) {
        ending = readWord(prev);
        context = model.hitTop(dec) ? 1 : 0;
        except = undefined;
        continue;
      }
      const sym = model.read(dec, row, history, except);
      if (this.admitted(sym)) {
        take((this.grown as GrownAlphabet).item(dec, sym), sym);
      } else {
        take(this.untail(dec, sym), sym);
      }
      context = model.hitTop(dec) ? 1 : 0;
      except = undefined;
    }
    return [all.slice(base), units];
  }
}

/**
 * The shared learned spellings, by pool and then window. Each holds its
 * learning per message, so nodes of one pool learn together within a
 * message and start over with the next.
 */
const pools = new Map<unknown, Map<number, Engine<unknown>>>();

/**
 * The learned spelling of `symbols` under `window`, of its own: for each
 * kind of value, contexts over an adaptive prior whose rows learn as one,
 * and learned repeats across every kind. An alphabet that grows admits its
 * items once for every kind.
 */
function learned<T>(symbols: Symbols<T>, window: number | undefined): Engine<T> {
  const { who, size, rows } = symbols;
  const grown =
    symbols.range === undefined
      ? undefined
      : new GrownAlphabet(size, window ?? DEFAULT_ADAPTIVE_WINDOW, symbols.range.bind(symbols));
  const members = grown === undefined ? size : size + 1;
  const weights = rows ?? [new Array<number>(members).fill(1)];
  const options = { ...symbols.prior, pooled: true };
  const model = (): ContextModel => {
    const prior = new AdaptivePrior(weights, members, window, who, undefined, options);
    return grown === undefined
      ? new ContextModel(prior, size, who)
      : new ContextModel(new GrownPrior(prior, grown), grown.size, who);
  };
  const words = symbols.letter === undefined ? undefined : new WordModel();
  return new Engine(symbols, model, new Repeats(who), WARMUP, grown, words);
}

/**
 * The learned spelling of `symbols` under `window`: the one its pool and
 * window share, built on the first request. It keeps the alphabet of that
 * first request, which spells items as every other alphabet of the pool.
 */
function pooled<T>(symbols: Symbols<T>, window: number): Engine<T> {
  let windows = pools.get(symbols.pool);
  if (windows === undefined) {
    windows = new Map();
    pools.set(symbols.pool, windows);
  }
  let engine = windows.get(window);
  if (engine === undefined) {
    engine = learned(symbols as Symbols<unknown>, window);
    windows.set(window, engine);
  }
  return engine as Engine<T>;
}

/** The bounds of a sequence's length, with the sequence's own adaptive options. */
export interface SequenceBounds extends LengthBounds {
  readonly adaptive?: SequenceAdaptiveOptions;
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
}

/** The methods a sequence declares: those of `Spelling`, repeats, and the field spellings of text. */
export interface SequenceSpelling extends Spelling {
  /** Stretches the node already wrote in the message copied instead of spelled again. */
  readonly repeats?: true;
  /** Each run of digits as an integer of its width, the text around the runs a frame (`./fields`). */
  readonly digits?: true;
  /** A value of a length the node met before by the items seen at each of its places (`./fields`). */
  readonly positional?: true;
}

/** `spelling` with `method` declared; `who` names the node in the error a second declaration throws. */
export function withSequenceMethod(
  spelling: SequenceSpelling,
  method: 'repeats' | 'digits' | 'positional',
  who: string
): SequenceSpelling {
  if (spelling[method] !== undefined) {
    throw new TypeError(`${who} ${method} is already set`);
  }
  return { ...spelling, [method]: true };
}

/** How many values of a length a node spells before positions can spell the next one. */
const POSITIONAL_GATE = 1;

/** What one side knows of a sequence in a message: its previous value's items, and the span of the value being coded. */
interface Track {
  prev?: number[];
  span: number;
}

/** No items: the start a value shares with none. */
const NONE: readonly number[] = [];

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** The most length prefixes a sequence keeps the cost of. */
const MAX_LENGTH_COSTS = 4096;

/**
 * A sequence of items in an alphabet, under length bounds. Adaptive bounds
 * make the symbols learn too, together with every other adaptive sequence
 * of the alphabet's pool and the same window unless `separate`, and the
 * length with them, over its range when there is a max and on the learned
 * magnitude scale from the min when there is none. The length always
 * learns on its own. Sequences of one pool and window share their repeats
 * whatever their `kind`, and their contexts and prior only within one.
 *
 * Declared, `repeats` copies earlier stretches of the node's own values at
 * fixed odds (adaptive sequences always copy, learned); `delta` spells each
 * value after the first by the start it shares with the node's previous
 * one; `recall` spells a value the node already wrote by its place among
 * the distinct ones, ahead of the rest. In an alphabet that knows its
 * digits, `digits` spells each value as digit fields and `positional` a
 * value of a span the node met before by its places (`./fields`); where
 * several are declared, positions take the values they can, then digit
 * fields, then the delta. Adaptive without a declared method, each value
 * from the node's second on picks among the plain spelling, the delta and,
 * in such an alphabet, the field spellings, by a learned mode.
 *
 * The delta writes, after the length prefix, how many items of the
 * previous value the value starts with, out of the most whose units fit
 * its span, every count alike or learned; then the items after them,
 * priced as the items after that shared start. The previous value is the
 * one the node last coded, recalled or spelled.
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
  /** Whether the node keeps its previous value: when a delta may spell a value. */
  private readonly tracks: boolean;
  /** The learned choice among the methods, under adaptive without a declared one. */
  private readonly choice?: ModeChoice<number[]>;
  /**
   * Digit fields and positions, declared or open to the choice, each value
   * they spell then taken in by the body: only in an alphabet that knows
   * its digits.
   */
  private readonly digits?: Method<number[]>;
  private readonly positions?: Method<number[]>;
  /** The positions themselves, which learn from every value spelled. */
  private readonly positional?: Positional;
  /** Whether a method is declared, which pins the spelling: positions where they apply, then digit fields, then the delta. */
  private readonly declared: boolean;
  private readonly recall?: Recall<T>;
  /** The overrun error, `Code points overrun the length prefix`. */
  private readonly overrun: string;

  constructor(
    private readonly symbols: Symbols<T>,
    bounds: SequenceBounds,
    spelling: SequenceSpelling = {},
    private readonly kind = 0
  ) {
    const { who, size, rows } = symbols;
    const { adaptive, ...fixed } = bounds;
    this.length = lengthRange(bounds.max === undefined ? fixed : bounds, who, symbols.noun);
    // A length range always has its floor, 0 unless declared.
    this.min = this.length.lo as number;
    this.declared =
      spelling.delta !== undefined ||
      spelling.digits !== undefined ||
      spelling.positional !== undefined;
    if (adaptive === undefined) {
      this.body =
        spelling.repeats === undefined
          ? new Spelled(symbols, members(size, rows === undefined ? undefined : { rows }, who))
          : new Engine(symbols, () => new StaticLiterals(symbols), EVEN_REPEATS, 0);
    } else {
      const { window } = checkAdaptation(adaptive, who);
      const engine =
        adaptive.separate === true
          ? learned(symbols, window)
          : pooled(symbols, window ?? DEFAULT_ADAPTIVE_WINDOW);
      this.body = engine;
      if (bounds.max === undefined) {
        this.lengths = new LearnedMagnitude(false, adaptive, who);
      }
      const shared = new LearnedMagnitude(false, adaptive, who);
      this.shared = shared;
      this.front = new LearnedMagnitude(false, adaptive, who, 'gamma');
    }
    const open = adaptive !== undefined && !this.declared;
    if (symbols.digit !== undefined) {
      const host = this.host();
      if (open || spelling.digits !== undefined) {
        this.digits = this.seen(
          new DigitFields(host, adaptive !== undefined, spelling.delta !== undefined)
        );
      }
      if (open || spelling.positional !== undefined) {
        this.positional = new Positional(host, adaptive !== undefined, POSITIONAL_GATE);
        this.positions = this.seen(this.positional);
      }
    }
    if (open) {
      const methods: Method<number[]>[] = [
        this.plain(this.body as Engine<T>),
        this.delta(this.shared as LearnedMagnitude),
      ];
      if (this.digits !== undefined) {
        methods.push(this.digits);
      }
      if (this.positions !== undefined) {
        methods.push(this.positions);
      }
      this.choice = new ModeChoice(methods, adaptive, who);
    }
    this.tracks = this.declared || adaptive !== undefined;
    this.recall = recallOf<T>(spelling, adaptive, symbols.copy?.bind(symbols));
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
      writeBody: (enc, items, span) => this.body.write(enc, items, span, NONE, this.kind),
      readBody: (dec, span) => this.readBody(dec, span, NONE),
    };
  }

  /**
   * `method`, the body taking in each value it spells, so repeats of later
   * values, of this node or another of its pool, can copy from it.
   */
  private seen(method: Method<number[]>): Method<number[]> {
    return {
      available: (side) => method.available(side),
      write: (enc, items) => {
        method.write(enc, items);
        this.body.see?.(enc, items);
      },
      read: (dec) => {
        const items = method.read(dec);
        this.body.see?.(dec, items);
        return items;
      },
      learn: (side, items) => method.learn(side, items),
    };
  }

  /** The plain spelling as a mode: the items in full. */
  private plain(engine: Engine<T>): Method<number[]> {
    return {
      available: () => true,
      write: (enc, items) => engine.write(enc, items, this.track(enc).span, NONE, this.kind),
      read: (dec) => this.readBody(dec, this.track(dec).span, NONE),
      learn: () => {},
    };
  }

  /** The delta as a mode, once the node has a previous value: its shared start learns every value. */
  private delta(scale: LearnedMagnitude): Method<number[]> {
    return {
      available: (side) => this.track(side).prev !== undefined,
      write: (enc, items) => this.writeDelta(enc, items, this.track(enc).span, this.previous(enc)),
      read: (dec) => this.readDelta(dec, this.track(dec).span, this.previous(dec)),
      learn: (side, items) => {
        const prev = this.previous(side);
        const bound = this.reach(prev, this.track(side).span);
        scale.learn(side, this.sharing(items, prev, bound), 0, 0, bound);
      },
    };
  }

  /** This message's track of the node on `side`. */
  private track(side: Encoder | Decoder): Track {
    return side.state<Track>(this, () => ({ span: 0 }));
  }

  /** This message's track of the node on `enc`, about to change: a transaction open restores it as it stands. */
  private retrack(enc: Encoder): Track {
    const track = this.track(enc);
    if (enc.journal.active) {
      const { prev, span } = track;
      enc.journal.call(() => {
        track.prev = prev;
        track.span = span;
      });
    }
    return track;
  }

  /** The items of the node's previous value on `side`, which the delta, available only once there is one, reads. */
  private previous(side: Encoder | Decoder): readonly number[] {
    return this.track(side).prev as number[];
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
    const bound = this.reach(prev, span);
    const shared = this.sharing(items, prev, bound);
    if (this.shared === undefined) {
      enc.compose(shared, bound + 1);
    } else {
      this.shared.write(enc, shared, 0, 0, bound);
    }
    const lead = prev.slice(0, shared);
    this.body.write(enc, items.slice(shared), span - this.unitsOf(prev, shared), lead, this.kind);
  }

  /** Reads the items `writeDelta` wrote after the same `prev`. */
  private readDelta(dec: Decoder, span: number, prev: readonly number[]): number[] {
    const bound = this.reach(prev, span);
    const shared =
      this.shared === undefined ? dec.parse(bound + 1) : this.shared.read(dec, 0, 0, bound);
    const lead = prev.slice(0, shared);
    return lead.concat(this.readBody(dec, span - this.unitsOf(prev, shared), lead));
  }

  /** Reads the items of `span` units after `lead`, the first known as `first`, refusing any that overrun it. */
  private readBody(dec: Decoder, span: number, lead: readonly number[], first?: First): number[] {
    const [items, units] = this.body.read(dec, span, lead, this.kind, first);
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
    if (recall.write(enc, key, () => this.spell(enc, value)) && this.tracks) {
      this.retrack(enc).prev = symbols.items(value);
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
    if (!spelled && this.tracks) {
      this.track(dec).prev = this.symbols.items(value);
    }
    return value;
  }

  /** Writes the length prefix of `value` and returns the span of its items. */
  private writeLength(enc: Encoder, value: T): number {
    const symbols = this.symbols;
    const count = symbols.count(value);
    const subject = (): string => symbols.subject(value);
    if (this.lengths === undefined) {
      this.length.write(enc, count, subject);
    } else {
      checkIndex(count, this.min, undefined, subject);
      this.lengths.write(enc, count, this.min, this.min, MAX_SAFE);
    }
    return symbols.span(count);
  }

  /** Reads a length prefix `writeLength` wrote and returns the span of the items after it. */
  private readLength(dec: Decoder): number {
    const symbols = this.symbols;
    const count =
      this.lengths === undefined
        ? this.length.read(dec)
        : this.lengths.read(dec, this.min, this.min, MAX_SAFE);
    symbols.check?.(count);
    dec.charge(count);
    return symbols.span(count);
  }

  /** Writes `value` in full: its length, then its items by the method the node takes for it. */
  private spell(enc: Encoder, value: T): void {
    const span = this.writeLength(enc, value);
    const items = this.symbols.items(value);
    if (!this.tracks) {
      this.body.write(enc, items, span, NONE, this.kind);
      return;
    }
    const track = this.retrack(enc);
    track.span = span;
    const { positions, digits } = this;
    if (this.choice !== undefined) {
      this.choice.write(enc, items);
    } else if (positions?.available(enc) === true) {
      positions.write(enc, items);
    } else if (digits !== undefined) {
      digits.write(enc, items);
    } else if (track.prev !== undefined) {
      this.writeDelta(enc, items, span, track.prev);
    } else {
      this.body.write(enc, items, span, NONE, this.kind);
    }
    this.positional?.see(enc, items);
    track.prev = items;
  }

  /** Reads a value `spell` wrote. */
  private unspell(dec: Decoder): T {
    const symbols = this.symbols;
    const span = this.readLength(dec);
    if (!this.tracks) {
      return symbols.build(this.readBody(dec, span, NONE));
    }
    const track = this.track(dec);
    track.span = span;
    let items: number[];
    const { positions, digits } = this;
    if (this.choice !== undefined) {
      items = this.choice.read(dec);
    } else if (positions?.available(dec) === true) {
      items = positions.read(dec);
    } else if (digits !== undefined) {
      items = digits.read(dec);
    } else if (track.prev !== undefined) {
      items = this.readDelta(dec, span, track.prev);
    } else {
      items = this.readBody(dec, span, NONE);
    }
    this.positional?.see(dec, items);
    track.prev = items;
    return symbols.build(items);
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
        this.body.write(enc, items, span, NONE, this.kind);
        return;
      }
      const most = this.most(prev, span, ascent);
      const shared = this.sharing(items, prev, most);
      this.front.write(enc, shared, 0, 0, most);
      const rest = span - this.unitsOf(prev, shared);
      const first = this.first(prev, shared, ascent);
      this.body.write(enc, items.slice(shared), rest, prev.slice(0, shared), this.kind, first);
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
