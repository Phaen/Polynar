/**
 * The sequence codec behind `p.string` and `p.binary`: a length prefix, then
 * one symbol per item from a fixed table, each priced uniformly or by a
 * static prior per row, and followed by whatever the symbol does not carry.
 * Adaptive, the symbols are priced by the ones before them, learned through
 * the message, and a stretch of items that already occurred in the message
 * can be copied from there instead. The alphabet decides what the items are
 * and how they map to symbols; the engine decides how the symbols are
 * spelled.
 */
import { Encoder, Decoder, CorruptInputError, ScaledRatio } from '../packer';
import {
  AdaptivePrior,
  DEFAULT_ADAPTIVE_WINDOW,
  checkAdaptation,
  type SequenceAdaptiveOptions,
} from './adaptive';
import { ContextModel, MAX_ORDER, WARMUP } from './contexts';
import { IndexRange, lengthRange, type LengthBounds } from './lattice';
import { members, type Members } from './members';
import { Finder, MIN_MATCH, REP_MIN, Repeats, type FlagContext, type Match } from './repeats';

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
 * hold a repeat: one is decodable at a position with an item before it and
 * at least `MIN_MATCH` units left.
 */
const possible = (before: number, span: number): boolean =>
  before + span >= WARMUP && ((before >= 1 && span >= MIN_MATCH) || span >= MIN_MATCH + 1);

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

/** The previous symbols of the first item of a value: all "before the value began". */
const opening = (size: number): number[] => new Array<number>(MAX_ORDER).fill(size);

/** `history` with `sym` as its newest symbol. */
const advance = (history: readonly number[], sym: number): number[] => [
  sym,
  ...history.slice(0, MAX_ORDER - 1),
];

/**
 * The adaptive spelling of a sequence's items: contexts over the symbols,
 * and repeats of earlier stretches of the message. Each value opens with
 * whether it spells repeats, where it can hold one; a value that does
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
class Learned<T> {
  private readonly model: ContextModel;
  private readonly repeats: Repeats;

  constructor(
    private readonly symbols: Symbols<T>,
    window: number | undefined
  ) {
    const { who, size, rows } = symbols;
    const prior = new AdaptivePrior(rows ?? [new Array<number>(size).fill(1)], size, window, who);
    this.model = new ContextModel(prior, size, symbols.order, who);
    this.repeats = new Repeats(who);
  }

  /** This message's items on `side`. */
  private message(side: Encoder | Decoder): Message {
    return side.state<Message>(this, () => ({
      items: [],
      next: 0,
      copied: 0,
      reps: [...FIRST_REPS],
    }));
  }

  /** Writes the items of a value of `span` units. */
  write(enc: Encoder, items: readonly number[], span: number): void {
    const { symbols, model, repeats } = this;
    const state = this.message(enc);
    const base = state.items.length;
    for (const item of items) {
      state.items.push(item);
    }
    // The row, history and units before each item, the same whichever
    // items a repeat copies.
    const syms = items.map((item) => symbols.symbol(item));
    const rows: number[] = [];
    const histories: number[][] = [];
    const before = [0];
    let row = symbols.start;
    let history = opening(symbols.size);
    for (let k = 0; k < items.length; k++) {
      rows.push(row);
      histories.push(history);
      before.push(before[k] + symbols.units(items[k]));
      history = advance(history, syms[k]);
      row = symbols.row(items[k]);
    }
    const walk: Walk = { base, span, syms, rows, histories, before };
    let used = false;
    if (possible(base, span)) {
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
      // chain the write pass walks.
      state.finder?.rewind(state.items, next);
      state.next = next;
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
      symbols.tail(enc, items[k], syms[k]);
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
      if (distance <= at) {
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

  /** Reads the items of a value of `span` units, and the units they add up to. */
  read(dec: Decoder, span: number): [number[], number] {
    const { symbols, model, repeats } = this;
    const state = this.message(dec);
    const all = state.items;
    const base = all.length;
    const used = possible(base, span) && repeats.readUsed(dec);
    let units = 0;
    let row = symbols.start;
    let history = opening(symbols.size);
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
const pools = new Map<unknown, Map<number, Learned<unknown>>>();

/**
 * The learned spelling of `symbols` under `window`: the one its pool and
 * window share, built on the first request. It keeps the alphabet of that
 * first request, which spells items as every other alphabet of the pool.
 */
function pooled<T>(symbols: Symbols<T>, window: number): Learned<T> {
  let windows = pools.get(symbols.pool);
  if (windows === undefined) {
    windows = new Map();
    pools.set(symbols.pool, windows);
  }
  let learned = windows.get(window);
  if (learned === undefined) {
    learned = new Learned<unknown>(symbols as Symbols<unknown>, window);
    windows.set(window, learned);
  }
  return learned as Learned<T>;
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

/**
 * A sequence of items in an alphabet, under length bounds. Adaptive bounds
 * make the symbols learn too, together with every other adaptive sequence
 * of the alphabet's pool and the same window unless `separate`, and the
 * length with them when it has a max; without one the length has no range
 * to learn over. The length always learns on its own.
 */
export class Sequence<T> {
  private readonly length: IndexRange;
  /** The static spelling, or the learned one under adaptive bounds. */
  private readonly spelling: Members | Learned<T>;
  /** Set when a value's symbols read as one run: uniform and tailless. */
  private readonly fast: boolean;
  /** The overrun error, `Code points overrun the length prefix`. */
  private readonly overrun: string;

  constructor(
    private readonly symbols: Symbols<T>,
    bounds: SequenceBounds
  ) {
    const { who, size, rows } = symbols;
    const { adaptive, ...fixed } = bounds;
    this.length = lengthRange(bounds.max === undefined ? fixed : bounds, who, symbols.noun);
    if (adaptive === undefined) {
      const spelling = members(size, rows === undefined ? undefined : { rows }, who);
      this.spelling = spelling;
      this.fast = symbols.tailless && spelling.radix !== undefined;
    } else {
      const { window } = checkAdaptation(adaptive, who);
      this.spelling =
        adaptive.separate === true
          ? new Learned(symbols, window)
          : pooled(symbols, window ?? DEFAULT_ADAPTIVE_WINDOW);
      this.fast = false;
    }
    const { item } = symbols;
    this.overrun = `${item.charAt(0).toUpperCase()}${item.slice(1)}s overrun the ${symbols.noun} prefix`;
  }

  write(enc: Encoder, value: T): void {
    const symbols = this.symbols;
    const count = symbols.count(value);
    this.length.write(enc, count, () => symbols.subject(value));
    const items = symbols.items(value);
    const spelling = this.spelling;
    if (spelling instanceof Learned) {
      spelling.write(enc, items, symbols.span(count));
      return;
    }
    let row = symbols.start;
    for (const item of items) {
      const symbol = symbols.symbol(item);
      spelling.write(enc, symbol, row);
      symbols.tail(enc, item, symbol);
      row = symbols.row(item);
    }
  }

  read(dec: Decoder): T {
    const symbols = this.symbols;
    const count = this.length.read(dec);
    symbols.check?.(count);
    const span = symbols.span(count);
    if (this.fast) {
      return symbols.build(dec.parseMany(symbols.size, span));
    }
    const [items, units] = this.readItems(dec, span);
    // An item wider than one unit in the final slot, or a repeat copying
    // past the span, can overshoot it; no value encodes that way.
    if (units > span) {
      throw new CorruptInputError(this.overrun);
    }
    return symbols.build(items);
  }

  /** Reads items until their units reach `span`, and the units they add up to. */
  private readItems(dec: Decoder, span: number): [number[], number] {
    const symbols = this.symbols;
    const spelling = this.spelling;
    if (spelling instanceof Learned) {
      return spelling.read(dec, span);
    }
    const items: number[] = [];
    let units = 0;
    let row = symbols.start;
    while (units < span) {
      const item = symbols.untail(dec, spelling.read(dec, row));
      items.push(item);
      units += symbols.units(item);
      row = symbols.row(item);
    }
    return [items, units];
  }
}
