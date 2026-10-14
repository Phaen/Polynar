/**
 * Adaptive priors: a node's declared weights stay fixed while the values a
 * message codes are counted on top of them, so later values of the same
 * node get cheaper the more often they recur. The decoder has read every
 * earlier symbol of the message, so it keeps the same counts. A message's
 * counts live on its encoder or decoder, keyed by the table they belong to,
 * and start over with the next message.
 */

import type { Encoder, Decoder, Bucket } from '../packer';
import { Fenwick } from './fenwick';
import { buildWeights, readTable, writeTable, type WeightTable } from './weights';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * The options of a node's `.adaptive()`: `window` is how many observations
 * the learned counts hold before they halve, raised to the member count of
 * a table with more members, and `DEFAULT_ADAPTIVE_WINDOW` when undefined.
 */
export interface AdaptiveOptions {
  readonly window?: number;
}

/** The observations an adaptive prior holds before halving, unless declared; a table with more members holds that many. */
export const DEFAULT_ADAPTIVE_WINDOW = 1024;

/** The most members an adaptive prior is declared over. */
export const MAX_ADAPTIVE_MEMBERS = 65536;

/**
 * The learning rates an adaptive prior tries per message, as how many
 * observations the declared weights count as, in multiples of the member
 * count: from a quick learner to a slow one.
 */
export const LADDER: readonly number[] = [1 / 32, 1 / 8, 1 / 2, 2];

/** Refuses a count that is not a positive safe integer, as `${who} adaptive ${what}`. */
function checkPositive(n: number, who: string, what: string): void {
  const message = `${who} adaptive ${what} must be a positive integer, got ${n}`;
  if (!Number.isInteger(n)) {
    throw new TypeError(message);
  }
  if (n < 1 || n > MAX_SAFE) {
    throw new RangeError(message);
  }
}

/** Validates a node's adaptive options, keeping only those declared. */
export function checkAdaptation(
  options: AdaptiveOptions | undefined,
  who: string
): AdaptiveOptions {
  const window = options?.window;
  if (window === undefined) {
    return {};
  }
  checkPositive(window, who, 'window');
  return { window };
}

/** Refuses an adaptive prior over more than `MAX_ADAPTIVE_MEMBERS` members. */
export function checkAdaptiveMembers(n: number, who: string): void {
  if (n > MAX_ADAPTIVE_MEMBERS) {
    throw new RangeError(
      `${who} adaptive prior spans ${n} values, above the limit ${MAX_ADAPTIVE_MEMBERS}`
    );
  }
}

/** A live table's members in bucket order, as `parseWeighted` reads them. */
export interface LivePositions {
  readonly count: number;
  readonly at: (index: number) => readonly [number, number, number];
}

/**
 * A table of `size` members whose buckets change as a message goes on:
 * member `pos` owns `[cum(pos), cum(pos) + freq(pos))` of `total`, and
 * `locate` finds the member owning a residual in `[0, total)`.
 */
export interface LiveTable {
  readonly size: number;
  readonly total: number;
  /** The members in bucket order, the same object on every call while `size` holds. */
  readonly positions: LivePositions;
  cum(pos: number): number;
  freq(pos: number): number;
  locate(residual: number): number;
  /** Member `pos` as `parseWeighted` reads it: `[pos, cum(pos), freq(pos)]`. */
  located(pos: number): readonly [number, number, number];
}

/** Writes member `pos` of a live table as one weighted symbol; a lone member writes nothing. */
export function writeLive(enc: Encoder, table: LiveTable, pos: number): void {
  if (table.size === 1) {
    return;
  }
  const freq = table.freq(pos);
  enc.composeWeighted(table.cum(pos), freq, table.total, { index: pos, count: table.size });
}

/** Reads a member written by `writeLive`. */
export function readLive(dec: Decoder, table: LiveTable): number {
  if (table.size === 1) {
    return 0;
  }
  return dec.parseWeighted(
    table.total,
    (residual) => table.located(table.locate(residual)),
    table.positions
  );
}

/** Member `pos`'s bucket in the static table `base`. */
function staticBucket(base: WeightTable, pos: number): Bucket {
  return [base.cums[pos], base.freqs[pos], base.total];
}

/**
 * One message's view of an adaptive table: the declared weights at `prior`
 * observations' worth, plus the observations learned so far, each worth
 * the weights' total. Integer throughout: member `pos` weighs
 * `weight(pos)·prior + learned(pos)·T` out of `T·(prior + observations)`,
 * which is the declared ratio blended with the observed frequencies. The
 * learned counts halve whenever they exceed `window`.
 */
export class LiveCounts implements LiveTable {
  /** The observations of each member, halved past the window. */
  readonly learned: Fenwick;
  readonly positions: LivePositions;

  constructor(
    private readonly base: WeightTable,
    private readonly prior: number,
    private readonly window: number
  ) {
    this.learned = Fenwick.zeros(base.freqs.length);
    this.positions = { count: this.learned.size, at: (i) => this.located(i) };
  }

  get size(): number {
    return this.learned.size;
  }

  get total(): number {
    return this.base.total * (this.prior + this.learned.total);
  }

  cum(pos: number): number {
    return this.base.cums[pos] * this.prior + this.learned.cum(pos) * this.base.total;
  }

  freq(pos: number): number {
    return this.base.freqs[pos] * this.prior + this.learned.freq(pos) * this.base.total;
  }

  located(pos: number): readonly [number, number, number] {
    return [pos, this.cum(pos), this.freq(pos)];
  }

  /** Member `pos`'s bucket as `[cum, freq, total]`. */
  bucket(pos: number): Bucket {
    return [this.cum(pos), this.freq(pos), this.total];
  }

  /**
   * The largest member whose bucket starts at or below `residual`, by
   * bisection: every bucket holds at least `prior` states, so the starts
   * rise strictly.
   */
  locate(residual: number): number {
    let lo = 0;
    let hi = this.size - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum(mid) <= residual) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Learns one observation of member `pos`, halving the learned counts past the window. */
  learn(pos: number): void {
    this.learned.add(pos, 1);
    if (this.learned.total > this.window) {
      this.learned.halve();
    }
  }
}

/**
 * Refuses a window whose largest bucket total, `total·(prior + window)`,
 * passes the safe integers: a value is coded while the learned total is at
 * most `window`.
 */
function checkOverflow(total: number, prior: number, window: number, who: string): void {
  if (total * (prior + window) > MAX_SAFE) {
    throw new RangeError(
      `${who} adaptive prior ${prior} and window ${window} overflow with weights totalling ${total}`
    );
  }
}

/**
 * An adaptive table over a node's `count` members. The declared weights
 * count as `prior` observations and never change; the values a message
 * codes are learned on top, one observation each, and the learned counts
 * halve whenever they exceed `window` or `count`, whichever is larger (a
 * smaller window would halve on nearly every value), so the table follows
 * the message's recent values. Only ratios matter: weights scaled by a constant give
 * every symbol the same cost.
 */
export class AdaptiveTable {
  /** The static table of the weights. */
  readonly base: WeightTable;
  private readonly window: number;

  constructor(
    weights: readonly number[],
    count: number,
    private readonly prior: number,
    window: number,
    who: string
  ) {
    checkAdaptiveMembers(count, who);
    checkPositive(prior, who, 'prior');
    checkPositive(window, who, 'window');
    this.base = buildWeights(weights, count, who);
    this.window = Math.max(window, count);
    checkOverflow(this.base.total, prior, this.window, who);
  }

  /** This message's live table on `side`, with nothing learned yet. */
  live(side: Encoder | Decoder): LiveCounts {
    return side.state(this, () => new LiveCounts(this.base, this.prior, this.window));
  }

  /** The bucket of member `pos` in this message's live table. */
  bucket(side: Encoder | Decoder, pos: number): Bucket {
    return this.live(side).bucket(pos);
  }

  /** Writes member `pos` from the live table, then learns it. */
  write(enc: Encoder, pos: number): void {
    const live = this.live(enc);
    writeLive(enc, live, pos);
    live.learn(pos);
  }

  /** Reads a member written by `write`, then learns it. */
  read(dec: Decoder): number {
    const live = this.live(dec);
    const pos = readLive(dec, live);
    live.learn(pos);
    return pos;
  }
}

/** The priors of an adaptive prior over `members` members: `LADDER` scaled, at least 1 each, in ladder order without repeats. */
function ladderRungs(members: number): number[] {
  return [...new Set(LADDER.map((f) => Math.max(1, Math.round(f * members))))];
}

/** An encoder's view of one message: values written so far and each row's live tables, one per rung. */
interface Writing {
  written: number;
  readonly lives: (LiveCounts[] | undefined)[];
}

/**
 * A decoder's view of one message: values read so far, the first one and
 * its row, the selector once read, and each row's live table under the
 * chosen rung.
 */
interface Reading {
  read: number;
  first: number;
  firstRow: number;
  coding: number;
  readonly lives: (LiveCounts | undefined)[];
}

/**
 * The user-facing adaptive prior over `members` members, with one row of
 * declared weights per context the node codes in (a plain node has one).
 * Each message spells the node's symbols in whichever is cheapest: the
 * static weights, or an adaptive table at one of the ladder's rungs, the
 * weights counting as that rung's prior observations, its window raised to
 * `members` when smaller. The first value goes through the static table, so
 * a node written once per message costs what its static form does; a
 * selector before the second value tells the decoder how the rest are
 * spelled: 0 static, `i` the `i`-th rung, a tie going to the lower index.
 * The selector weighs static as all rungs together, so staying static costs
 * one bit. Every row learns only the values written in it.
 */
export class AdaptivePrior {
  /** The static table of each row. */
  readonly bases: readonly WeightTable[];
  /** The prior of each adaptive coding, in selector order from 1. */
  readonly rungs: readonly number[];
  private readonly window: number;
  /** The selector's table: static as likely as every rung together. */
  private readonly selector: WeightTable;
  /** The selector's bucket under each coding, as `composeSelector` takes them. */
  private readonly choices: readonly Bucket[];

  constructor(
    rows: readonly (readonly number[])[],
    readonly members: number,
    window: number | undefined,
    who: string
  ) {
    if (rows.length === 0) {
      throw new TypeError(`${who} adaptive prior needs at least one row of weights`);
    }
    checkAdaptiveMembers(members, who);
    if (window !== undefined) {
      checkPositive(window, who, 'window');
    }
    this.bases = rows.map((row) => buildWeights(row, members, who));
    this.window = Math.max(window ?? DEFAULT_ADAPTIVE_WINDOW, members);
    this.rungs = ladderRungs(members);
    const total = this.bases.reduce((most, base) => Math.max(most, base.total), 0);
    // From the slowest learner down, so an overflow names the rung it binds.
    for (const prior of [...this.rungs].reverse()) {
      checkOverflow(total, prior, this.window, who);
    }
    const selector = buildWeights(
      [this.rungs.length, ...this.rungs.map(() => 1)],
      1 + this.rungs.length,
      who
    );
    this.selector = selector;
    this.choices = selector.cums.map((cum, i) => [cum, selector.freqs[i], selector.total]);
  }

  /** The static table of `row`, which must be one of the rows. */
  private base(row: number): WeightTable {
    const base = this.bases[row];
    // Any row outside the list (negative, fractional, NaN, past the end)
    // reads undefined.
    if (base === undefined) {
      throw new RangeError(`Row ${row} is outside [0, ${this.bases.length})`);
    }
    return base;
  }

  /** Writes member `pos`, an integer in `[0, members)`, in context `row`. */
  write(enc: Encoder, pos: number, row = 0): void {
    const base = this.base(row);
    if (!Number.isInteger(pos)) {
      throw new TypeError(`Position ${pos} is not an integer`);
    }
    if (pos < 0 || pos >= this.members) {
      throw new RangeError(`Position ${pos} is outside [0, ${this.members})`);
    }
    if (this.members === 1) {
      return;
    }
    const state = enc.state<Writing>(this, () => ({ written: 0, lives: [] }));
    const lives = (state.lives[row] ??= this.rungs.map(
      (prior) => new LiveCounts(base, prior, this.window)
    ));
    if (state.written === 0) {
      writeTable(enc, base, pos);
    } else {
      if (state.written === 1) {
        enc.composeSelector(this, this.choices);
      }
      enc.composeAlternatives(
        this,
        [staticBucket(base, pos), ...lives.map((live) => live.bucket(pos))],
        { index: pos, count: this.members }
      );
    }
    state.written++;
    for (const live of lives) {
      live.learn(pos);
    }
  }

  /** Reads a member written by `write` in context `row`. */
  read(dec: Decoder, row = 0): number {
    const base = this.base(row);
    if (this.members === 1) {
      return 0;
    }
    const state = dec.state<Reading>(this, () => ({
      read: 0,
      first: 0,
      firstRow: 0,
      coding: 0,
      lives: [],
    }));
    if (state.read === 0) {
      state.read = 1;
      state.first = readTable(dec, base);
      state.firstRow = row;
      return state.first;
    }
    if (state.read === 1) {
      state.read = 2;
      state.coding = readTable(dec, this.selector);
      // Under the static coding no live table is consulted, so none is
      // built; under a rung, the first value is its table's first lesson.
      if (state.coding > 0) {
        this.live(state, state.firstRow).learn(state.first);
      }
    }
    if (state.coding === 0) {
      return readTable(dec, base);
    }
    const live = this.live(state, row);
    const pos = readLive(dec, live);
    live.learn(pos);
    return pos;
  }

  /** The live table of `row` under the rung a message's selector chose. */
  private live(state: Reading, row: number): LiveCounts {
    return (state.lives[row] ??= new LiveCounts(
      this.bases[row],
      this.rungs[state.coding - 1],
      this.window
    ));
  }
}
