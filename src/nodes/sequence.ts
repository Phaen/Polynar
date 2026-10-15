/**
 * The sequence codec behind `p.string` and `p.binary`: a length prefix, then
 * one symbol per item from a fixed table, each priced uniformly or by a
 * static prior per row, and followed by whatever the symbol does not carry.
 * Adaptive, the symbols are priced by the ones before them, learned through
 * the message, and a stretch of items that already occurred in the message
 * can be copied from there instead; `.repeats()` copies stretches at fixed
 * odds without learning. A value may also be spelled by its place among the
 * values the node already wrote (`.recall()`), or after the start it shares
 * with the node's previous value (`.delta()`, and a learned choice under
 * adaptive). The alphabet decides what the items are and how they map to
 * symbols; the engine decides how the symbols are spelled.
 */
import { Encoder, Decoder, CorruptInputError, ScaledRatio } from '../packer';
import {
  AdaptivePrior,
  DEFAULT_ADAPTIVE_WINDOW,
  checkAdaptation,
  type SequenceAdaptiveOptions,
} from './adaptive';
import { ContextModel, MAX_ORDER, WARMUP } from './contexts';
import {
  Exclusion,
  excludedBucket,
  readExcluded,
  staticTable,
  writeExcluded,
  type Table,
} from './excluded';
import { IndexRange, lengthRange, type LengthBounds } from './lattice';
import { LearnedMagnitude } from './magnitude';
import { members, type Members } from './members';
import { ModeChoice, type Method, type Spelling } from './methods';
import { Recall } from './recall';
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

/** Whether the items a repeat copies still train the context model. */
const LEARN_MATCHED = true;

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
  /** How many previous symbols `row` conditions on. */
  readonly order: 0 | 1;
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

/** The distances cached before a message's first match. */
const FIRST_REPS: readonly number[] = [1, 2, 3, 4];

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
const advance = (history: readonly number[], sym: number): number[] => [
  sym,
  ...history.slice(0, MAX_ORDER - 1),
];

/** The row of the item after `lead`, the start a value shares with the one before it: the start row when it shares none. */
const rowAfter = <T>(symbols: Symbols<T>, lead: readonly number[]): number =>
  lead.length === 0 ? symbols.start : symbols.row(lead[lead.length - 1]);

/**
 * The row and the previous symbols of the item after `lead`: the symbols of
 * its last items, newest first, and "before the value began" past them.
 */
function opening<T>(symbols: Symbols<T>, lead: readonly number[]): [number, number[]] {
  let history = new Array<number>(MAX_ORDER).fill(symbols.size);
  for (let k = Math.max(0, lead.length - MAX_ORDER); k < lead.length; k++) {
    history = advance(history, symbols.symbol(lead[k]));
  }
  return [rowAfter(symbols, lead), history];
}

/**
 * How one symbol of a sequence is spelled, given the row it is priced in
 * and the previous symbols, newest first, with `except`, when given, ruled
 * out: `ContextModel` under adaptive, `StaticLiterals` otherwise. `price`
 * multiplies into `into` the probability `write` would give the symbol
 * now, learning nothing; `hitTop` is whether the last symbol coded was a
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
    into: ScaledRatio,
    except?: number
  ): void;
  hitTop(side: Encoder | Decoder): boolean;
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
    into: ScaledRatio,
    except?: number
  ): void {
    const [, freq, total] = excludedBucket(this.table(row), this.ruling(except), sym);
    into.multiply(freq, total);
  }

  hitTop(): boolean {
    return false;
  }
}

/**
 * How the items of a value after its length prefix are spelled. `lead` is
 * the start the value shares with the node's previous value, already
 * known to both sides: the items spelled are those after it, `span` units
 * of them, and the first is priced as the item after `lead`.
 */
interface Body {
  write(enc: Encoder, items: readonly number[], span: number, lead: readonly number[]): void;
  /** Reads items until their units reach `span`, and the units they add up to. */
  read(dec: Decoder, span: number, lead: readonly number[]): [number[], number];
}

/** The items one symbol each at the alphabet's static odds, each followed by its tail. */
class Spelled<T> implements Body {
  /** Set when a value's symbols read as one run: uniform and tailless. */
  private readonly fast: boolean;

  constructor(
    private readonly symbols: Symbols<T>,
    private readonly spelling: Members
  ) {
    this.fast = symbols.tailless && spelling.radix !== undefined;
  }

  write(enc: Encoder, items: readonly number[], _span: number, lead: readonly number[]): void {
    const { symbols, spelling } = this;
    let row = rowAfter(symbols, lead);
    for (const item of items) {
      const symbol = symbols.symbol(item);
      spelling.write(enc, symbol, row);
      symbols.tail(enc, item, symbol);
      row = symbols.row(item);
    }
  }

  read(dec: Decoder, span: number, lead: readonly number[]): [number[], number] {
    const { symbols, spelling } = this;
    if (this.fast) {
      return [dec.parseMany(symbols.size, span), span];
    }
    const items: number[] = [];
    let units = 0;
    let row = rowAfter(symbols, lead);
    while (units < span) {
      const item = symbols.untail(dec, spelling.read(dec, row));
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
 * in its source: every candidate is extended while its items match, so
 * that item differs from the next one. In an alphabet with tails a band or
 * an escape maps many items to one symbol, so a differing item may still
 * share the symbol, and nothing is ruled out.
 */
class Engine<T> implements Body {
  constructor(
    private readonly symbols: Symbols<T>,
    private readonly model: Literals,
    private readonly repeats: RepeatCoding,
    private readonly gate: number
  ) {}

  /** This message's items on `side`. */
  private message(side: Encoder | Decoder): Message {
    return side.state<Message>(this, () => ({
      items: [],
      next: 0,
      copied: 0,
      reps: [...FIRST_REPS],
    }));
  }

  /**
   * The walk of `items`, a value's `span` units after `lead` and after
   * `base` items of the message: the row, history and units before each
   * item, the same whichever items a repeat copies.
   */
  private walk(
    items: readonly number[],
    span: number,
    lead: readonly number[],
    base: number
  ): Walk {
    const symbols = this.symbols;
    const syms = items.map((item) => symbols.symbol(item));
    const rows: number[] = [];
    const histories: number[][] = [];
    const before = [0];
    let [row, history] = opening(symbols, lead);
    for (let k = 0; k < items.length; k++) {
      rows.push(row);
      histories.push(history);
      before.push(before[k] + symbols.units(items[k]));
      history = advance(history, syms[k]);
      row = symbols.row(items[k]);
    }
    return { base, span, syms, rows, histories, before };
  }

  /**
   * Multiplies into `into` the probability of spelling `items` after
   * `lead` as literals, as the model stands, learning nothing: the
   * encoder's price of a value for choosing how to spell it. Repeats are
   * left out, as finding them is the write's own search.
   */
  price(enc: Encoder, items: readonly number[], lead: readonly number[], into: ScaledRatio): void {
    const walk = this.walk(items, 0, lead, 0);
    for (let k = 0; k < items.length; k++) {
      this.priceLiteral(enc, walk, items[k], k, into);
    }
  }

  /** Writes the items of a value of `span` units after `lead`. */
  write(enc: Encoder, items: readonly number[], span: number, lead: readonly number[]): void {
    const { model, repeats } = this;
    const state = this.message(enc);
    const base = state.items.length;
    for (const item of items) {
      state.items.push(item);
    }
    const walk = this.walk(items, span, lead, base);
    const { syms, rows, histories, before } = walk;
    let used = false;
    if (possible(base, span, this.gate)) {
      // The pre-scan weighs the value with repeats against the value
      // without, every flag included, priced by the model and the cached
      // distances as they stand before the value: close for a short value,
      // and for a long one the matches found early carry the choice. Its
      // flags go in context 2 right after a match and 0 elsewhere, as no
      // literal of the value is coded yet. The write pass decides each
      // match afresh.
      const on = new ScaledRatio();
      const off = new ScaledRatio();
      const next = state.next;
      let context: FlagContext = 0;
      let except: number | undefined;
      for (let k = 0; k < items.length; ) {
        const at = base + k;
        const limit = span - before[k];
        if (decodable(at, limit)) {
          const match = this.choose(enc, state, walk, k, context, except);
          if (match !== undefined) {
            repeats.priceMatch(enc, match, at, limit, context, on);
            for (let j = k; j < k + match.length; j++) {
              this.priceLiteral(enc, walk, items[j], j, off);
            }
            k += match.length;
            context = 2;
            except = this.continuation(state.items, base + k, match, k < items.length);
            continue;
          }
          repeats.priceFlag(enc, false, context, on);
        }
        this.priceLiteral(enc, walk, items[k], k, on, except);
        this.priceLiteral(enc, walk, items[k], k, off);
        context = 0;
        except = undefined;
        k++;
      }
      used = on.exceeds(off);
      // The write pass searches the chains as they stood before the value:
      // left in, the pre-scan's later positions sit at the head of every
      // chain the write pass walks. A value without repeats has no write
      // pass search, and keeps them: the next value would register the same
      // positions in the same order, and registering them again for every
      // value takes time quadratic in a run of such values.
      if (used) {
        state.finder?.rewind(state.items, next);
        state.next = next;
      }
      repeats.writeUsed(enc, used);
    }
    let context: FlagContext = 0;
    let except: number | undefined;
    for (let k = 0; k < items.length; ) {
      const at = base + k;
      const limit = span - before[k];
      if (used && decodable(at, limit)) {
        const match = this.choose(enc, state, walk, k, context, except);
        repeats.writeFlag(enc, match !== undefined, context);
        if (match !== undefined) {
          repeats.writeMatch(enc, match, at, limit);
          cache(state.reps, match);
          if (LEARN_MATCHED) {
            for (let j = k; j < k + match.length; j++) {
              model.learn(enc, syms[j], rows[j], histories[j]);
            }
          }
          k += match.length;
          context = 2;
          except = this.continuation(state.items, base + k, match, k < items.length);
          continue;
        }
      }
      model.write(enc, syms[k], rows[k], histories[k], except);
      this.symbols.tail(enc, items[k], syms[k]);
      context = model.hitTop(enc) ? 1 : 0;
      except = undefined;
      k++;
    }
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
    match: Match,
    short: boolean
  ): number | undefined {
    return this.symbols.tailless && short
      ? this.symbols.symbol(all[end - match.distance])
      : undefined;
  }

  /**
   * Multiplies into `into` the probability of spelling `item`, item `j` of
   * the value, under `except`: its symbol as the model stands, then its tail.
   */
  private priceLiteral(
    enc: Encoder,
    walk: Walk,
    item: number,
    j: number,
    into: ScaledRatio,
    except?: number
  ): void {
    const sym = walk.syms[j];
    this.model.price(enc, sym, walk.rows[j], walk.histories[j], into, except);
    into.multiply(1, this.symbols.tails(item, sym));
  }

  /**
   * The match to take at item `k` of the value, a position a repeat is
   * decodable at, its flag in `context` and a literal there ruling out
   * `except`. The candidates are the longest earlier match that fits the
   * units left, then the run at each cached distance no further back than
   * the message reaches, from `REP_MIN` items up to the value's end; each
   * saves the ratio of its copy's probability to that of spelling its items,
   * flag included, both priced by the model as it stands. The candidate
   * saving most is taken when it saves anything, a tie going to the
   * earlier. Positions before it register with the finder first.
   */
  private choose(
    enc: Encoder,
    state: Message,
    walk: Walk,
    k: number,
    context: FlagContext,
    except: number | undefined
  ): Match | undefined {
    const { repeats } = this;
    const { base, span, before } = walk;
    const all = state.items;
    const at = base + k;
    const limit = span - before[k];
    const finder = (state.finder ??= new Finder());
    // Positions register once, in order; one whose `MIN_MATCH` items run
    // past the message so far waits for a later value.
    while (state.next < at && state.next + MIN_MATCH <= all.length) {
      finder.insert(all, state.next++);
    }
    // The items left in the value add up to exactly `limit` units, so a
    // match, which the finder ends within the value, always fits them.
    const candidates: Match[] = [];
    const found = finder.find(all, at, limit);
    if (found !== undefined) {
      candidates.push(found);
    }
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
    if (candidates.length === 0) {
      return undefined;
    }
    // The probability of spelling the first `l` items, flag included, for
    // every `l` up to the longest candidate.
    const longest = Math.max(...candidates.map((c) => c.length));
    const flag = new ScaledRatio();
    repeats.priceFlag(enc, false, context, flag);
    const literal = [flag];
    for (let j = k; j < k + longest; j++) {
      const item = new ScaledRatio();
      this.priceLiteral(enc, walk, all[base + j], j, item, j === k ? except : undefined);
      literal.push(literal[literal.length - 1].times(item));
    }
    let best: Match | undefined;
    let saved = new ScaledRatio();
    for (const candidate of candidates) {
      const copy = new ScaledRatio();
      repeats.priceMatch(enc, candidate, at, limit, context, copy);
      const saving = copy.over(literal[candidate.length]);
      if (saving.exceeds(saved)) {
        best = candidate;
        saved = saving;
      }
    }
    return best;
  }

  /** Reads the items of a value of `span` units after `lead`, and the units they add up to. */
  read(dec: Decoder, span: number, lead: readonly number[]): [number[], number] {
    const { symbols, model, repeats } = this;
    const state = this.message(dec);
    const all = state.items;
    const base = all.length;
    const used = possible(base, span, this.gate) && repeats.readUsed(dec);
    let units = 0;
    let [row, history] = opening(symbols, lead);
    let context: FlagContext = 0;
    let except: number | undefined;
    const take = (item: number, sym: number): void => {
      all.push(item);
      units += symbols.units(item);
      history = advance(history, sym);
      row = symbols.row(item);
    };
    while (units < span) {
      const at = all.length;
      const limit = span - units;
      if (used && decodable(at, limit) && repeats.readFlag(dec, context)) {
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
          const sym = symbols.symbol(item);
          if (LEARN_MATCHED) {
            model.learn(dec, sym, row, history);
          }
          take(item, sym);
        }
        cache(state.reps, match);
        context = 2;
        except = this.continuation(all, all.length, match, units < span);
        continue;
      }
      const sym = model.read(dec, row, history, except);
      take(symbols.untail(dec, sym), sym);
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

/** The learned spelling of `symbols` under `window`, of its own: contexts over an adaptive prior, and learned repeats. */
function learned<T>(symbols: Symbols<T>, window: number | undefined): Engine<T> {
  const { who, size, rows } = symbols;
  const prior = new AdaptivePrior(rows ?? [new Array<number>(size).fill(1)], size, window, who);
  const model = new ContextModel(prior, size, symbols.order, who);
  return new Engine(symbols, model, new Repeats(who), WARMUP);
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

/** A value's items as the encoder walks them: their symbols, and the row, history and units before each. */
interface Walk {
  /** The items of the message before the value. */
  readonly base: number;
  readonly span: number;
  readonly syms: readonly number[];
  readonly rows: readonly number[];
  readonly histories: readonly (readonly number[])[];
  /** The units before each item, and after the last. */
  readonly before: readonly number[];
}

/** The methods a sequence declares: those of `Spelling`, and repeats. */
export interface SequenceSpelling extends Spelling {
  /** Stretches the node already wrote in the message copied instead of spelled again. */
  readonly repeats?: true;
}

/** `spelling` with repeats declared; `who` names the node in the error a second declaration throws. */
export function withRepeats(spelling: SequenceSpelling, who: string): SequenceSpelling {
  if (spelling.repeats !== undefined) {
    throw new TypeError(`${who} repeats is already set`);
  }
  return { ...spelling, repeats: true };
}

/** What one side knows of a sequence in a message: its previous value's items, and the span of the value being coded. */
interface Track {
  prev?: number[];
  span: number;
}

/** No items: the start a value shares with none. */
const NONE: readonly number[] = [];

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * A sequence of items in an alphabet, under length bounds. Adaptive bounds
 * make the symbols learn too, together with every other adaptive sequence
 * of the alphabet's pool and the same window unless `separate`, and the
 * length with them, over its range when there is a max and on the learned
 * magnitude scale from the min when there is none. The length always
 * learns on its own.
 *
 * Declared, `repeats` copies earlier stretches of the node's own values at
 * fixed odds (adaptive sequences always copy, learned); `delta` spells each
 * value after the first by the start it shares with the node's previous
 * one; `recall` spells a value the node already wrote by its place among
 * the distinct ones, ahead of the rest. Adaptive without a declared delta,
 * each value from the node's second on picks the plain spelling or the
 * delta by a learned mode.
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
  /** Whether the node keeps its previous value: when a delta may spell a value. */
  private readonly tracks: boolean;
  /** The learned choice of plain or delta, under adaptive without a declared delta. */
  private readonly choice?: ModeChoice<number[]>;
  private readonly recall?: Recall<T>;
  /** The overrun error, `Code points overrun the length prefix`. */
  private readonly overrun: string;

  constructor(
    private readonly symbols: Symbols<T>,
    bounds: SequenceBounds,
    spelling: SequenceSpelling = {}
  ) {
    const { who, size, rows } = symbols;
    const { adaptive, ...fixed } = bounds;
    this.length = lengthRange(bounds.max === undefined ? fixed : bounds, who, symbols.noun);
    // A length range always has its floor, 0 unless declared.
    this.min = this.length.lo as number;
    if (adaptive === undefined) {
      this.body =
        spelling.repeats === undefined
          ? new Spelled(symbols, members(size, rows === undefined ? undefined : { rows }, who))
          : new Engine(symbols, new StaticLiterals(symbols), EVEN_REPEATS, 0);
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
      if (spelling.delta === undefined) {
        const methods = [this.plain(engine), this.delta(engine, shared)];
        this.choice = new ModeChoice(methods, adaptive, who);
      }
    }
    this.tracks = spelling.delta !== undefined || adaptive !== undefined;
    if (spelling.recall !== undefined) {
      this.recall = new Recall<T>(adaptive !== undefined, symbols.copy?.bind(symbols));
    }
    const { item } = symbols;
    this.overrun = `${item.charAt(0).toUpperCase()}${item.slice(1)}s overrun the ${symbols.noun} prefix`;
  }

  /** The plain spelling as a mode: the items in full. */
  private plain(engine: Engine<T>): Method<number[]> {
    return {
      available: () => true,
      price: (enc, items, into) => {
        engine.price(enc, items, NONE, into);
        return true;
      },
      write: (enc, items) => engine.write(enc, items, this.track(enc).span, NONE),
      read: (dec) => this.readBody(dec, this.track(dec).span, NONE),
      learn: () => {},
    };
  }

  /** The delta as a mode, once the node has a previous value: its shared start learns every value. */
  private delta(engine: Engine<T>, scale: LearnedMagnitude): Method<number[]> {
    return {
      available: (side) => this.track(side).prev !== undefined,
      price: (enc, items, into) => {
        const prev = this.previous(enc);
        const bound = this.reach(prev, this.track(enc).span);
        const shared = this.sharing(items, prev, bound);
        scale.price(enc, shared, 0, 0, bound, into);
        engine.price(enc, items.slice(shared), prev.slice(0, shared), into);
        return true;
      },
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
    this.body.write(enc, items.slice(shared), span - this.unitsOf(prev, shared), lead);
  }

  /** Reads the items `writeDelta` wrote after the same `prev`. */
  private readDelta(dec: Decoder, span: number, prev: readonly number[]): number[] {
    const bound = this.reach(prev, span);
    const shared =
      this.shared === undefined ? dec.parse(bound + 1) : this.shared.read(dec, 0, 0, bound);
    const lead = prev.slice(0, shared);
    return lead.concat(this.readBody(dec, span - this.unitsOf(prev, shared), lead));
  }

  /** Reads the items of `span` units after `lead`, refusing any that overrun it. */
  private readBody(dec: Decoder, span: number, lead: readonly number[]): number[] {
    const [items, units] = this.body.read(dec, span, lead);
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
      this.track(enc).prev = symbols.items(value);
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

  /** Writes `value` in full: its length, then its items by the method the node takes for it. */
  private spell(enc: Encoder, value: T): void {
    const symbols = this.symbols;
    const count = symbols.count(value);
    const subject = (): string => symbols.subject(value);
    if (this.lengths === undefined) {
      this.length.write(enc, count, subject);
    } else {
      checkIndex(count, this.min, undefined, subject);
      this.lengths.write(enc, count, this.min, this.min, MAX_SAFE);
    }
    const items = symbols.items(value);
    const span = symbols.span(count);
    if (!this.tracks) {
      this.body.write(enc, items, span, NONE);
      return;
    }
    const track = this.track(enc);
    track.span = span;
    if (this.choice !== undefined) {
      this.choice.write(enc, items);
    } else if (track.prev !== undefined) {
      this.writeDelta(enc, items, span, track.prev);
    } else {
      this.body.write(enc, items, span, NONE);
    }
    track.prev = items;
  }

  /** Reads a value `spell` wrote. */
  private unspell(dec: Decoder): T {
    const symbols = this.symbols;
    const count =
      this.lengths === undefined
        ? this.length.read(dec)
        : this.lengths.read(dec, this.min, this.min, MAX_SAFE);
    symbols.check?.(count);
    const span = symbols.span(count);
    if (!this.tracks) {
      return symbols.build(this.readBody(dec, span, NONE));
    }
    const track = this.track(dec);
    track.span = span;
    let items: number[];
    if (this.choice !== undefined) {
      items = this.choice.read(dec);
    } else if (track.prev !== undefined) {
      items = this.readDelta(dec, span, track.prev);
    } else {
      items = this.readBody(dec, span, NONE);
    }
    track.prev = items;
    return symbols.build(items);
  }
}
