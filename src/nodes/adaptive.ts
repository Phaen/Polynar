/**
 * Adaptive priors: a node's declared weights stay fixed while the values a
 * message codes are counted on top of them, so later values of the same
 * node get cheaper the more often they recur. The decoder has read every
 * earlier symbol of the message, so it keeps the same counts. A message's
 * counts live on its encoder or decoder, keyed by the table they belong to,
 * and start over with the next message.
 */

import { Encoder, type Decoder, type Bucket } from '../packer';
import {
  type Exclusion,
  excludedBucket,
  readExcluded,
  staticTable,
  writeExcluded,
} from './excluded';
import { Fenwick } from './fenwick';
import { buildWeights, readTable, type WeightTable } from './weights';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * The options of a node's `.adaptive()`: `window` is how many observations
 * the learned counts hold before they halve, raised to the member count of
 * a table with more members, and `DEFAULT_ADAPTIVE_WINDOW` when undefined.
 */
export interface AdaptiveOptions {
  readonly window?: number;
}

/**
 * The options of `p.string` and `p.binary`'s `.adaptive()`: `separate` keeps
 * the node's characters or bytes learning on their own, instead of with
 * every other node of its alphabet and window in the message.
 */
export interface SequenceAdaptiveOptions extends AdaptiveOptions {
  readonly separate?: boolean;
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
  /**
   * The values learned before any live table exists, as position and row
   * pairs: the tables are built when the selector first needs them, from
   * these, so a node written once per message never builds any.
   */
  readonly pending: number[];
  /** Whether the live tables exist; the pending values are replayed when they are first built. */
  live: boolean;
  readonly lives: (LiveCounts[] | undefined)[];
}

/**
 * A decoder's view of one message: values read so far, the values learned
 * before the selector was read as position and row pairs, the selector once
 * read, and each row's live table under the chosen rung.
 */
interface Reading {
  read: number;
  readonly pending: number[];
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
 * one bit. Every row learns only the values coded in it.
 *
 * A value may come with members excluded, ruled out by a model consulted
 * before this one: they own no states in any coding. A value whose
 * exclusion leaves one member is known without being written; it is
 * learned, but the first value and the selector wait for one that is
 * written. A value coded elsewhere entirely is learned through `learn`.
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

  /** The static table of `row`, refusing a row outside the rows and a position outside `[0, members)`. */
  private check(pos: number, row: number): WeightTable {
    const base = this.base(row);
    if (!Number.isInteger(pos)) {
      throw new TypeError(`Position ${pos} is not an integer`);
    }
    if (pos < 0 || pos >= this.members) {
      throw new RangeError(`Position ${pos} is outside [0, ${this.members})`);
    }
    return base;
  }

  /**
   * Writes member `pos`, an integer in `[0, members)`, in context `row`,
   * with the members of `excluded` ruled out; `pos` is never one of them.
   */
  write(enc: Encoder, pos: number, row = 0, excluded?: Exclusion): void {
    const base = this.check(pos, row);
    if (this.members === 1) {
      return;
    }
    const state = this.writing(enc);
    if (excluded === undefined || excluded.count < this.members - 1) {
      const table = staticTable(base);
      if (state.written === 0) {
        writeExcluded(enc, table, excluded, pos);
      } else {
        if (state.written === 1) {
          enc.composeSelector(this, this.choices);
        }
        enc.composeAlternatives(
          this,
          [table, ...this.rowLives(state, base, row)].map((t) => excludedBucket(t, excluded, pos)),
          { index: pos, count: this.members }
        );
      }
      state.written++;
    }
    this.teach(state, pos, row);
  }

  /**
   * An estimate, on the encoder, of the bucket `write` would give member
   * `pos` in context `row` under `excluded`: its bucket in the live table
   * of the second-fastest rung, a middle guess at the coding the selector
   * will name. The checks are `write`'s; nothing is learned.
   */
  estimate(enc: Encoder, pos: number, row = 0, excluded?: Exclusion): Bucket {
    const base = this.check(pos, row);
    // The slowest rung, twice the members, is above the fastest, at most
    // half of them, so there are always at least two.
    return excludedBucket(this.rowLives(this.writing(enc), base, row)[1], excluded, pos);
  }

  /** Reads a member written by `write` in context `row` under the same exclusion. */
  read(dec: Decoder, row = 0, excluded?: Exclusion): number {
    const base = this.base(row);
    if (this.members === 1) {
      return 0;
    }
    const state = this.reading(dec);
    let pos: number;
    if (excluded !== undefined && excluded.count === this.members - 1) {
      // The value is never excluded, so the one member left is it.
      pos = 0;
      while (excluded.has(pos)) {
        pos++;
      }
    } else if (state.read === 0) {
      state.read = 1;
      pos = readExcluded(dec, staticTable(base), excluded);
    } else {
      if (state.read === 1) {
        state.read = 2;
        state.coding = readTable(dec, this.selector);
        // Under the static coding no live table is consulted, so none is
        // built; under a rung, the values learned so far are its tables'
        // first lessons, in the order they came.
        if (state.coding > 0) {
          for (let i = 0; i < state.pending.length; i += 2) {
            this.live(state, state.pending[i + 1]).learn(state.pending[i]);
          }
        }
        state.pending.length = 0;
      }
      pos = readExcluded(
        dec,
        state.coding === 0 ? staticTable(base) : this.live(state, row),
        excluded
      );
    }
    this.study(state, pos, row);
    return pos;
  }

  /**
   * Learns member `pos` in context `row`, a value coded elsewhere that this
   * prior still counts: the encoder's live tables learn it at once, the
   * decoder's once its selector names their rung.
   */
  learn(side: Encoder | Decoder, pos: number, row = 0): void {
    this.check(pos, row);
    if (this.members === 1) {
      return;
    }
    if (side instanceof Encoder) {
      this.teach(this.writing(side), pos, row);
    } else {
      this.study(this.reading(side), pos, row);
    }
  }

  private writing(enc: Encoder): Writing {
    return enc.state<Writing>(this, () => ({ written: 0, pending: [], live: false, lives: [] }));
  }

  private reading(dec: Decoder): Reading {
    return dec.state<Reading>(this, () => ({ read: 0, pending: [], coding: 0, lives: [] }));
  }

  /** The encoder's live tables of `row`, one per rung, built on first use. */
  /**
   * The encoder's live tables of `row`, one per rung. The first request
   * builds the tables of every row learned so far from the pending values;
   * from then on the values learn directly and a new row starts empty.
   */
  private rowLives(state: Writing, base: WeightTable, row: number): LiveCounts[] {
    if (!state.live) {
      state.live = true;
      const learned = state.pending.splice(0);
      for (let i = 0; i < learned.length; i += 2) {
        this.teach(state, learned[i], learned[i + 1]);
      }
    }
    return (state.lives[row] ??= this.rungs.map(
      (prior) => new LiveCounts(base, prior, this.window)
    ));
  }

  /** Every rung's live table learns `pos`. */
  /**
   * The encoder learns `pos` in `row`: queued while no live table exists,
   * else into every rung's table of the row.
   */
  private teach(state: Writing, pos: number, row: number): void {
    if (!state.live) {
      state.pending.push(pos, row);
      return;
    }
    for (const live of this.rowLives(state, this.bases[row], row)) {
      live.learn(pos);
    }
  }

  /**
   * The decoder learns `pos` in `row`: queued until the selector is read,
   * then into the chosen rung's table; under the static coding, not at all.
   */
  private study(state: Reading, pos: number, row: number): void {
    if (state.read < 2) {
      state.pending.push(pos, row);
    } else if (state.coding > 0) {
      this.live(state, row).learn(pos);
    }
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
