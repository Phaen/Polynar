/**
 * Learned contexts above an adaptive prior, PPM style: each symbol of a
 * sequence is priced first by what followed its last few symbols earlier in
 * the message, longest history first, each context escaping to the next
 * shorter one when it has never seen the symbol, and the last escape
 * landing in the node's adaptive prior. A context that escapes rules out
 * every symbol it has seen, so the contexts below it, and the prior, share
 * the states those would have taken. Contexts hold nothing until the
 * message teaches them, so both sides build the same ones from the symbols
 * coded so far.
 *
 * Whether a context escapes is learned apart from its symbols: contexts
 * alike in their order, how many symbols they have left after exclusion
 * and how often those recurred share a cell of hit and escape counts, so a
 * young context escapes at the rate its kind has escaped in the message.
 */

import { SlotCache } from '../packer';
import { costUnits, type Encoder, type Decoder, type Journal, type Undoable } from '../packer';
import { Exclusion, type Table } from './excluded';
import { KeyMap } from './keymap';

/** The longest history a context keys on. */
export const MAX_ORDER = 3;

/**
 * The symbols a node codes in a message before its contexts price any: a
 * context has nothing to predict with until the message has taught it, and
 * a young one charges an escape for every symbol it guesses wrong, which on
 * a short message costs more than the few it guesses right. The contexts
 * learn from the first symbol on, so by the time they price they have seen
 * the whole message so far.
 */
export const WARMUP = 64;

/** The count sum past which a context halves its counts. */
export const CONTEXT_LIMIT = 1024;

/** The hit and escape count sum past which a cell halves both. */
export const CELL_LIMIT = 4096;

/** The ops a context takes back: a symbol recurring, and a symbol entering. */
const RECUR = 0;
const ENTER = 1;

/** The hit and escape counts a cell starts at. */
const CELL_START: readonly [number, number] = [4, 2];

/**
 * The key of the escape cell of a context at index `index` among the
 * orders, highest first, with `n` symbols left after exclusion, a positive
 * integer, whose counts sum to `sum`: `index·100 + d·10 + r`, where `d`
 * buckets `n` by powers of two up to 32 and above, and `r` the mean count
 * `sum / n` at 1.5, 3, 6 and 12. The mean is compared in integers, so
 * every engine buckets it alike.
 */
export function cellKey(index: number, n: number, sum: number): number {
  const d = n <= 1 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 8 ? 3 : n <= 16 ? 4 : n <= 32 ? 5 : 6;
  const r = 2 * sum < 3 * n ? 0 : sum < 3 * n ? 1 : sum < 6 * n ? 2 : sum < 12 * n ? 3 : 4;
  return index * 100 + d * 10 + r;
}

/**
 * Refuses a symbol that is not an integer in `[0, end)`, or `[0, end]` when
 * `inclusive`, naming it `who` and `what`: `p.string symbol`.
 */
function checkSymbol(sym: number, end: number, who: string, what: string, inclusive = false): void {
  if (!Number.isInteger(sym)) {
    throw new TypeError(`${who} ${what} ${sym} is not an integer`);
  }
  if (sym < 0 || (inclusive ? sym > end : sym >= end)) {
    throw new RangeError(`${who} ${what} ${sym} is outside [0, ${end}${inclusive ? ']' : ')'}`);
  }
}

/**
 * A learned-only context: the symbols seen after one history, sparse. A
 * symbol enters at a count of 1 and gains 2 each time it recurs; once the
 * counts sum past `CONTEXT_LIMIT` every count halves, rounding up, so the
 * context follows the message's recent symbols. A symbol never seen owns
 * no states. Every change records its undo in `journal`, an encoder's.
 */
export class Context implements Table, Undoable {
  /** The symbols seen, ascending. */
  readonly syms: number[] = [];
  /** The count of each symbol in `syms`, in the same order. */
  readonly counts: number[] = [];
  /** The sum of `counts`. */
  private sum = 0;

  /** Over `symbols` symbols, a positive integer. */
  constructor(
    private readonly symbols: number,
    private readonly journal?: Journal
  ) {
    if (!Number.isInteger(symbols)) {
      throw new TypeError(`Context size must be an integer, got ${symbols}`);
    }
    if (symbols < 1) {
      throw new RangeError(`Context size ${symbols} is below the minimum 1`);
    }
  }

  /** The members: every symbol. */
  get size(): number {
    return this.symbols;
  }

  /** The states of every member: the sum of the counts. */
  get total(): number {
    return this.sum;
  }

  /** Where member `pos`'s bucket starts, `pos` an integer in `[0, size)`: the counts of the symbols below it. */
  cum(pos: number): number {
    checkSymbol(pos, this.size, 'Context', 'member');
    let cum = 0;
    for (let i = 0; i < this.syms.length && this.syms[i] < pos; i++) {
      cum += this.counts[i];
    }
    return cum;
  }

  /** The width of member `pos`'s bucket, `pos` an integer in `[0, size)`: 0 for a symbol never seen. */
  freq(pos: number): number {
    checkSymbol(pos, this.size, 'Context', 'member');
    const i = this.find(pos);
    return this.syms[i] === pos ? this.counts[i] : 0;
  }

  /** Whether the context has seen `sym`. */
  has(sym: number): boolean {
    return this.syms[this.find(sym)] === sym;
  }

  /** The index of the first symbol seen at or above `sym`, by bisection: `syms`' length when none is. */
  private find(sym: number): number {
    const syms = this.syms;
    let lo = 0;
    let hi = syms.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (syms[mid] < sym) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Counts one more `sym`, an integer in `[0, symbols)`: 1 when new, else 2
   * more, then halves every count, rounding up, once the sum passes
   * `CONTEXT_LIMIT`.
   */
  update(sym: number): void {
    checkSymbol(sym, this.symbols, 'Context', 'symbol');
    const i = this.find(sym);
    const journal = this.journal;
    if (this.syms[i] === sym) {
      this.counts[i] += 2;
      this.sum += 2;
      if (journal?.active === true) {
        journal.own(this, RECUR, i);
      }
    } else {
      this.syms.splice(i, 0, sym);
      this.counts.splice(i, 0, 1);
      this.sum += 1;
      if (journal?.active === true) {
        journal.own(this, ENTER, i);
      }
    }
    if (this.sum > CONTEXT_LIMIT) {
      if (journal?.active === true) {
        const { counts, sum } = this;
        const saved = counts.slice();
        journal.call(() => {
          for (let j = 0; j < saved.length; j++) {
            counts[j] = saved[j];
          }
          this.sum = sum;
        });
      }
      let sum = 0;
      for (let j = 0; j < this.counts.length; j++) {
        this.counts[j] = (this.counts[j] + 1) >> 1;
        sum += this.counts[j];
      }
      this.sum = sum;
    }
  }

  /** Takes back the count a symbol gained at index `i`: its recurrence (`RECUR`) or its entry (`ENTER`). */
  undo(op: number, i: number): void {
    if (op === RECUR) {
      this.counts[i] -= 2;
      this.sum -= 2;
    } else {
      this.syms.splice(i, 1);
      this.counts.splice(i, 1);
      this.sum -= 1;
    }
  }
}

/**
 * One message's contexts: a map per context order, highest first, from a
 * history's key to its context, the escape cells by `cellKey`, and the
 * exclusion each symbol reuses.
 */
interface Contexts {
  readonly tables: readonly KeyMap<Context>[];
  /** Each cell's `[hit, escape]` counts. */
  readonly cells: ([number, number] | undefined)[];
  readonly exclusion: Exclusion;
  /** The symbols coded or learned so far. */
  coded: number;
  /** Whether the last symbol coded was a hit in the highest-order context. */
  top: boolean;
  /** The encoder's journal, which every change to its contexts records its undo in; none on a decoder. */
  readonly journal?: Journal;
}

/**
 * A context under an exclusion: the symbols it has `left`, their counts'
 * `sum`, and a symbol's bucket among them, `[below, below + width)`, of
 * width 0 when the symbol is not among them, and whether the context has
 * seen the symbol at all.
 */
interface Scan {
  left: number;
  sum: number;
  below: number;
  width: number;
  found: boolean;
}

/**
 * Reads a symbol of `context` written under the exclusion, whose symbols
 * left sum to `sum`: the one whose bucket among them holds the residual.
 */
function readLeft(dec: Decoder, context: Context, exclusion: Exclusion, sum: number): number {
  const { syms, counts } = context;
  return dec.parseWeighted(sum, (residual) => {
    let cum = 0;
    for (let j = 0; ; j++) {
      const s = syms[j];
      if (!exclusion.has(s)) {
        const count = counts[j];
        if (residual < cum + count) {
          return [s, cum, count];
        }
        cum += count;
      }
    }
  });
}

/**
 * A cell learns a hit or an escape: 2 more on its side, both halving,
 * rounding up, past `CELL_LIMIT`. The change records its undo in
 * `journal`, an encoder's.
 */
function learnCell(cell: [number, number], escaped: boolean, journal?: Journal): void {
  if (journal?.active === true) {
    journal.pair(cell, cell[0], cell[1]);
  }
  cell[escaped ? 1 : 0] += 2;
  if (cell[0] + cell[1] > CELL_LIMIT) {
    cell[0] = (cell[0] + 1) >> 1;
    cell[1] = (cell[1] + 1) >> 1;
  }
}

/**
 * What the contexts escape to: a table over the symbols, by row, that codes
 * a symbol with members ruled out and learns every symbol the contexts code.
 * `AdaptivePrior` is one; `cost` is the cost, in `COST_UNITS`, the encoder's
 * table as it stands gives a symbol, learning nothing.
 */
export interface SymbolPrior {
  readonly members: number;
  /** One entry per row. */
  readonly bases: readonly unknown[];
  write(enc: Encoder, pos: number, row: number, excluded: Exclusion): void;
  read(dec: Decoder, row: number, excluded: Exclusion): number;
  learn(side: Encoder | Decoder, pos: number, row: number): void;
  cost(enc: Encoder, pos: number, row: number, excluded: Exclusion): number;
}

/**
 * PPM contexts above a prior over `size` symbols: learned contexts for each
 * history length from 1 to `MAX_ORDER`. `who` names the node.
 *
 * A history lists the previous symbols newest first, exactly `MAX_ORDER`
 * of them, each in `[0, size]`, where a value no symbol coded takes, such
 * as `size`, stands for "before the value began". A context of order `k`
 * keys on the first `k` of them.
 */
export class ContextModel {
  readonly size: number;
  /** The context orders, highest first. */
  private readonly orders: readonly number[];
  /** Each message's contexts. */
  private readonly messages = new SlotCache<Contexts, Encoder | Decoder>(this, (side) => ({
    tables: this.orders.map(() => new KeyMap<Context>()),
    cells: [],
    exclusion: new Exclusion(this.size),
    coded: 0,
    top: false,
    journal: side.journal,
  }));
  /** What `visit` returns, its contexts written over by the next visit. */
  private readonly visited: Context[] = [];
  /** Whether the symbol `price` last priced would be a hit in the highest-order context. */
  pricedTop = false;
  /** What `scan` returns. */
  private readonly scratch: Scan = { left: 0, sum: 0, below: 0, width: 0, found: false };

  constructor(
    private readonly prior: SymbolPrior,
    size: number,
    private readonly who: string
  ) {
    if (size !== prior.members) {
      throw new TypeError(`${who} contexts span ${size} symbols, but their prior ${prior.members}`);
    }
    this.size = size;
    const orders: number[] = [];
    for (let k = MAX_ORDER; k > 0; k--) {
      orders.push(k);
    }
    this.orders = orders;
  }

  /**
   * Writes `sym` in `row`, `history` the previous symbols newest first:
   * through the contexts from the longest history down until one has seen
   * it, else through the prior with every escaped context's symbols ruled
   * out. In each context with symbols left after exclusion, the escape
   * decision goes first, through the context's cell, then on a hit the
   * symbol among those left; a context with none left writes nothing.
   * `except`, a symbol other than `sym`, is ruled out of every table from
   * the start. Every context visited learns `sym`, and so does the prior.
   */
  write(enc: Encoder, sym: number, row: number, history: readonly number[], except?: number): void {
    this.check(sym, row, history);
    const state = this.message(enc);
    const { exclusion } = state;
    const contexts = this.visit(enc, history);
    this.open(exclusion, except);
    let hit = -1;
    const pricing = this.pricing(state, contexts);
    for (let i = 0; i < pricing.length; i++) {
      const context = pricing[i];
      // A context that has seen `sym` still has it left: the symbols ruled
      // out are `except` and those of contexts that had not seen it.
      const scan = this.scan(context, exclusion, sym);
      const has = scan.found;
      const cell = this.cell(state, i, scan);
      if (cell !== undefined) {
        const total = cell[0] + cell[1];
        if (has) {
          enc.composeWeighted(0, cell[0], total);
          enc.composeWeighted(scan.below, scan.width, scan.sum);
        } else {
          enc.composeWeighted(cell[0], cell[1], total);
        }
        learnCell(cell, !has, enc.journal);
      }
      if (has) {
        hit = i;
        break;
      }
      this.exclude(exclusion, context);
    }
    this.setTop(state, hit === 0);
    if (hit >= 0) {
      this.prior.learn(enc, sym, row);
    } else {
      this.prior.write(enc, sym, row, exclusion);
    }
    this.teach(state, contexts, sym);
  }

  /** Reads a symbol written by `write` in `row` after `history` under the same `except`. */
  read(dec: Decoder, row: number, history: readonly number[], except?: number): number {
    this.checkRow(row);
    this.checkHistory(history);
    const state = this.message(dec);
    const { exclusion } = state;
    const contexts = this.visit(dec, history);
    this.open(exclusion, except);
    let hit = -1;
    let sym = 0;
    const pricing = this.pricing(state, contexts);
    for (let i = 0; i < pricing.length; i++) {
      const context = pricing[i];
      const scan = this.scan(context, exclusion, -1);
      const cell = this.cell(state, i, scan);
      if (cell !== undefined) {
        const escaped = dec.parseWeighted(cell[0] + cell[1], (r) =>
          r >= cell[0] ? [true, cell[0], cell[1]] : [false, 0, cell[0]]
        );
        learnCell(cell, escaped, dec.journal);
        if (!escaped) {
          sym = readLeft(dec, context, exclusion, scan.sum);
          hit = i;
          break;
        }
      }
      this.exclude(exclusion, context);
    }
    this.setTop(state, hit === 0);
    if (hit >= 0) {
      this.prior.learn(dec, sym, row);
    } else {
      sym = this.prior.read(dec, row, exclusion);
    }
    this.teach(state, contexts, sym);
    return sym;
  }

  /**
   * Learns `sym` as if coded here, writing nothing: contexts update, the
   * prior learns, the cells do not, and the last symbol counts as no hit.
   */
  learn(side: Encoder | Decoder, sym: number, row: number, history: readonly number[]): void {
    this.check(sym, row, history);
    const state = this.message(side);
    this.teach(state, this.visit(side, history), sym);
    this.setTop(state, false);
    this.prior.learn(side, sym, row);
  }

  /**
   * Whether the last symbol coded on `side` was a hit in the highest-order
   * context: false after a hit lower down, the prior, or a learned symbol.
   */
  hitTop(side: Encoder | Decoder): boolean {
    return this.message(side).top;
  }

  /**
   * The cost, in `COST_UNITS`, the model on the encoder, as it stands,
   * gives `sym` here under `except`: each context's escape
   * decision and, on its hit, the symbol's bucket, or the prior's `cost`.
   * Nothing learns, and a context not yet visited, which holds nothing, is
   * left unbuilt.
   */
  price(
    enc: Encoder,
    sym: number,
    row: number,
    history: readonly number[],
    except?: number
  ): number {
    this.check(sym, row, history);
    let cost = 0;
    const state = this.message(enc);
    const { tables, exclusion } = state;
    this.open(exclusion, except);
    this.pricedTop = false;
    for (let i = 0; i < this.orders.length && state.coded >= WARMUP; i++) {
      const context = tables[i].get(this.key(history, this.orders[i]));
      if (context === undefined) {
        continue;
      }
      const scan = this.scan(context, exclusion, sym);
      const has = scan.found;
      const cell = this.cell(state, i, scan);
      if (cell !== undefined) {
        cost += costUnits(has ? cell[0] : cell[1], cell[0] + cell[1]);
      }
      if (has) {
        cost += costUnits(scan.width, scan.sum);
        this.pricedTop = i === 0;
        return cost;
      }
      this.exclude(exclusion, context);
    }
    return cost + this.prior.cost(enc, sym, row, exclusion);
  }

  /** Clears the exclusion, then rules out `except`, a symbol in `[0, size)`, when given. */
  private open(exclusion: Exclusion, except: number | undefined): void {
    exclusion.clear();
    if (except !== undefined) {
      checkSymbol(except, this.size, this.who, 'excluded symbol');
      exclusion.add(except);
    }
  }

  /**
   * The escape cell of `context`, at index `index` among the orders, under
   * the exclusion: undefined when it has no symbols left, else the cell its
   * symbols left and their counts key, built at `CELL_START` on first use.
   */
  private cell(state: Contexts, index: number, scan: Scan): [number, number] | undefined {
    const { left, sum } = scan;
    if (left === 0) {
      return undefined;
    }
    const key = cellKey(index, left, sum);
    const { cells } = state;
    let cell = cells[key];
    if (cell === undefined) {
      cell = [CELL_START[0], CELL_START[1]];
      cells[key] = cell;
      if (state.journal?.active === true) {
        state.journal.call(() => {
          cells[key] = undefined;
        });
      }
    }
    return cell;
  }

  /**
   * `context` under the exclusion, in one pass over its symbols: how many
   * it has left and their counts' sum, and `sym`'s bucket among them. The
   * result is a scratch object the next scan overwrites.
   */
  private scan(context: Context, exclusion: Exclusion, sym: number): Scan {
    const { syms, counts } = context;
    const scan = this.scratch;
    let left = 0;
    let sum = 0;
    let below = 0;
    let width = 0;
    let found = false;
    for (let j = 0; j < syms.length; j++) {
      const s = syms[j];
      if (s === sym) {
        found = true;
      }
      if (!exclusion.has(s)) {
        const count = counts[j];
        left++;
        sum += count;
        if (s < sym) {
          below += count;
        } else if (s === sym) {
          width = count;
        }
      }
    }
    scan.left = left;
    scan.sum = sum;
    scan.below = below;
    scan.width = width;
    scan.found = found;
    return scan;
  }

  /** This message's contexts on `side`. */
  private message(side: Encoder | Decoder): Contexts {
    return this.messages.get(side);
  }

  /** The contexts that price the next symbol: none until the warm-up is over. */
  private pricing(state: Contexts, contexts: readonly Context[]): readonly Context[] {
    return state.coded >= WARMUP ? contexts : [];
  }

  /** Every context of the symbol learns it, and the message counts it. */
  private teach(state: Contexts, contexts: readonly Context[], sym: number): void {
    for (const context of contexts) {
      context.update(sym);
    }
    state.coded++;
    if (state.journal?.active === true) {
      state.journal.set(state, 'coded', state.coded - 1);
    }
  }

  /** Records whether the last symbol coded was a hit in the highest-order context. */
  private setTop(state: Contexts, top: boolean): void {
    if (state.top !== top) {
      state.top = top;
      if (state.journal?.active === true) {
        state.journal.flag(state, 'top', !top);
      }
    }
  }

  /** The contexts of `history`, highest order first, each built on its first visit. */
  private visit(side: Encoder | Decoder, history: readonly number[]): Context[] {
    const { tables, journal } = this.message(side);
    const { orders, visited } = this;
    for (let i = 0; i < orders.length; i++) {
      const key = this.key(history, orders[i]);
      let context = tables[i].get(key);
      if (context === undefined) {
        context = new Context(this.size, journal);
        tables[i].set(key, context);
        if (journal?.active === true) {
          journal.drop(tables[i], key);
        }
      }
      visited[i] = context;
    }
    return visited;
  }

  /**
   * The key of the first `k` history entries: `h[0] + (size + 1)·(h[1] +
   * (size + 1)·h[2])` cut to them. With `size` at most 65536 it stays below
   * 2^49, a safe integer.
   */
  private key(history: readonly number[], k: number): number {
    let key = 0;
    for (let j = k - 1; j >= 0; j--) {
      key = key * (this.size + 1) + history[j];
    }
    return key;
  }

  /**
   * Rules out every symbol `context` has seen. The symbol being coded is
   * never among them, as a context that had seen it would have coded it,
   * nor is it `except`, so at least that member stays in every table below.
   */
  private exclude(exclusion: Exclusion, context: Context): void {
    for (const sym of context.syms) {
      exclusion.add(sym);
    }
  }

  private check(sym: number, row: number, history: readonly number[]): void {
    this.checkRow(row);
    checkSymbol(sym, this.size, this.who, 'symbol');
    this.checkHistory(history);
  }

  /** Refuses a row the prior does not have, before any context is touched. */
  private checkRow(row: number): void {
    if (this.prior.bases[row] === undefined) {
      throw new RangeError(`Row ${row} is outside [0, ${this.prior.bases.length})`);
    }
  }

  /** Refuses a history that is not `MAX_ORDER` integers in `[0, size]`. */
  private checkHistory(history: readonly number[]): void {
    if (history.length !== MAX_ORDER) {
      throw new TypeError(
        `${this.who} history must hold ${MAX_ORDER} symbols, got ${history.length}`
      );
    }
    for (let k = 0; k < MAX_ORDER; k++) {
      const h = history[k];
      // A whole number in [0, 2^32) passes the shift unchanged.
      if (h >>> 0 !== h || h > this.size) {
        checkSymbol(h, this.size, this.who, 'history symbol', true);
      }
    }
  }
}
