/**
 * Adaptive priors: a node's declared weights stay fixed while the values a
 * message codes are counted on top of them, so later values of the same
 * node get cheaper the more often they recur. The decoder has read every
 * earlier symbol of the message, so it keeps the same counts. A message's
 * counts live on its encoder or decoder, keyed by the table they belong to,
 * and start over with the next message.
 */

import {
  Encoder,
  SlotCache,
  costUnits,
  type Decoder,
  type Bucket,
  type Journal,
  type Undoable,
} from '../packer';
import {
  type Exclusion,
  type Table,
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

/** The key of the lineage an adaptive node's options carry; only `withLineage` sets it. */
const LINEAGE = Symbol('lineage');

/** Adaptive options carrying a lineage. */
interface Lineal extends AdaptiveOptions {
  readonly [LINEAGE]?: Lineage;
}

/**
 * `options` with `lineage` added, so every adaptive prior a node builds
 * from them joins it, through every rebuild that passes them on.
 */
export function withLineage(options: AdaptiveOptions, lineage: Lineage): AdaptiveOptions {
  const lineal: Lineal = { ...options, [LINEAGE]: lineage };
  return lineal;
}

/** The lineage `options` carry, if any. */
export function lineageOf(options: AdaptiveOptions | undefined): Lineage | undefined {
  return (options as Lineal | undefined)?.[LINEAGE];
}

/**
 * How an adaptive prior over several rows learns, beyond its weights:
 * `pooled` rows learn into one set of counts instead of each its own;
 * `live` rows are what the learned codings weigh against those counts,
 * the declared rows when left out, which the static coding always keeps;
 * and under `keep` the counts halve rounding up, so a member seen in the
 * message keeps a count.
 */
export interface PriorOptions {
  readonly pooled?: boolean;
  readonly live?: readonly (readonly number[])[];
  readonly keep?: boolean;
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

/**
 * A table of `size` members whose buckets change as a message goes on:
 * member `pos` owns `[cum(pos), cum(pos) + freq(pos))` of `total`, and
 * `locate` finds the member owning a residual in `[0, total)`.
 */
export interface LiveTable {
  readonly size: number;
  readonly total: number;
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
  enc.composeWeighted(table.cum(pos), freq, table.total);
}

/** Reads a member written by `writeLive`. */
export function readLive(dec: Decoder, table: LiveTable): number {
  if (table.size === 1) {
    return 0;
  }
  return dec.parseWeighted(table.total, (residual) => table.located(table.locate(residual)));
}

/**
 * One message's view of an adaptive table: the declared weights at `prior`
 * observations' worth, plus the observations learned so far, each worth
 * the weights' total. Integer throughout: member `pos` weighs
 * `weight(pos)·prior + learned(pos)·T` out of `T·(prior + observations)`,
 * which is the declared ratio blended with the observed frequencies. The
 * learned counts halve whenever they exceed `window`, rounding down, or up
 * under `keep`, so a member seen never falls back to its weight alone. The
 * counts record
 * their changes in `journal`, an encoder's. Given `learned`, another
 * table's learned counts, the table shares them, and learning in either
 * learns in both.
 */
export class LiveCounts implements LiveTable {
  /** The observations of each member, halved past the window. */
  readonly learned: Fenwick;

  constructor(
    readonly base: WeightTable,
    readonly prior: number,
    private readonly window: number,
    journal?: Journal,
    learned?: Fenwick,
    private readonly keep = false
  ) {
    this.learned = learned ?? Fenwick.zeros(base.freqs.length, journal);
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

  /**
   * Learns one observation of member `pos`, halving the learned counts past
   * the window, rounding up when the table keeps every member it has seen.
   */
  learn(pos: number): void {
    this.learned.add(pos, 1);
    if (this.learned.total > this.window) {
      this.learned.halve(this.keep);
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

  /** Each message's live table. */
  private readonly lives = new SlotCache<LiveCounts, Encoder | Decoder>(
    this,
    (side) => new LiveCounts(this.base, this.prior, this.window, side.journal)
  );

  /** This message's live table on `side`, with nothing learned yet. */
  live(side: Encoder | Decoder): LiveCounts {
    return this.lives.get(side);
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

/**
 * How many observations a lineage's gathered table counts as in the table
 * of a prior that starts from it: 2, so a node's own values soon outweigh
 * what its kin learned.
 */
export const BLEND_SHARE = 2;

/**
 * The adaptive priors of nodes built alike, as `p.any().adaptive()` builds
 * one per key: a root lineage, whose node only gathers, and a lineage per
 * later node that starts from it. Every adaptive prior built from options
 * carrying a lineage joins it in the order it is built, so a node built
 * the way the root's was pairs each of its priors with the root's prior at
 * the same place.
 */
export class Lineage {
  /** The priors that joined, in order: the root's, which the others pair with. */
  private readonly joined: AdaptivePrior[] = [];

  /** `root` is the lineage this one starts from; none for the root itself. */
  constructor(private readonly root?: Lineage) {}

  /**
   * The root's prior that the next prior to join, over `members` members
   * of weights `rows`, pairs with: none in the root. Throws when the root
   * has no prior at that place, or one of other members or weights.
   */
  pair(
    members: number,
    rows: readonly (readonly number[])[],
    who: string
  ): AdaptivePrior | undefined {
    if (this.root === undefined) {
      return undefined;
    }
    const at = this.joined.length;
    const parent = this.root.joined[at];
    const same = (base: WeightTable, r: number): boolean =>
      base.freqs.length === rows[r].length && base.freqs.every((w, i) => w === rows[r][i]);
    if (
      parent === undefined ||
      parent.members !== members ||
      parent.bases.length !== rows.length ||
      !parent.bases.every(same)
    ) {
      throw new TypeError(`${who} adaptive prior ${at} does not match its lineage's`);
    }
    return parent;
  }

  /** Adds `prior`, which `pair` was asked about, at the next place. */
  join(prior: AdaptivePrior): void {
    this.joined.push(prior);
  }
}

/**
 * One message's table of a prior that starts from its lineage: the root
 * prior's gathered table, every value any node of the lineage learned on
 * top of its weights, counts as `BLEND_SHARE` observations, and the
 * prior's own observations are learned on top, each worth that table's
 * total, halving past `window`. Learning a value teaches the gathered
 * table too. The own observations are kept by member, only for members
 * seen, as a node built per key sees few. Changes record their undo in
 * `journal`, an encoder's, the gathered table's through its own.
 */
class Blend implements Table, Undoable {
  /** The own observations of each member seen, none kept at 0. */
  private learned = new Map<number, number>();
  /** The own observations of all members. */
  private count = 0;

  constructor(
    private readonly gathered: LiveCounts,
    private readonly window: number,
    private readonly journal?: Journal
  ) {}

  get size(): number {
    return this.gathered.size;
  }

  get total(): number {
    return this.gathered.total * (BLEND_SHARE + this.count);
  }

  cum(pos: number): number {
    let below = 0;
    for (const [member, count] of this.learned) {
      if (member < pos) {
        below += count;
      }
    }
    return this.gathered.cum(pos) * BLEND_SHARE + below * this.gathered.total;
  }

  freq(pos: number): number {
    const own = this.learned.get(pos) ?? 0;
    return this.gathered.freq(pos) * BLEND_SHARE + own * this.gathered.total;
  }

  learn(pos: number): void {
    const journal = this.journal;
    const own = this.learned.get(pos);
    this.learned.set(pos, (own ?? 0) + 1);
    this.count++;
    if (journal?.active === true) {
      journal.own(this, 0, pos, own ?? 0);
    }
    if (this.count > this.window) {
      if (journal?.active === true) {
        const { learned, count } = this;
        this.learned = new Map(learned);
        journal.call(() => {
          this.learned = learned;
          this.count = count;
        });
      }
      this.count = 0;
      for (const [member, count] of this.learned) {
        const half = Math.floor(count / 2);
        if (half === 0) {
          this.learned.delete(member);
        } else {
          this.learned.set(member, half);
          this.count += half;
        }
      }
    }
    this.gathered.learn(pos);
  }

  /** Takes back a `learn` of `pos`, which had `own` observations before it. */
  undo(_op: number, pos: number, own: number): void {
    if (own === 0) {
      this.learned.delete(pos);
    } else {
      this.learned.set(pos, own);
    }
    this.count--;
  }
}

/**
 * Member `pos`'s bucket under `excluded`, as `excludedBucket` gives it, in
 * the static table `base` and then in each of `lives`, live tables over
 * `base` that share their learned counts: from one pass over the excluded
 * members, as each bucket splits into its weights' part and its learned
 * part, and the parts are integers that sum exactly. `pos` is never
 * excluded.
 */
function rungBuckets(
  base: WeightTable,
  lives: readonly LiveCounts[],
  excluded: Exclusion | undefined,
  pos: number
): Bucket[] {
  const learned = lives[0].learned;
  let weightsBelow = 0;
  let weightsOut = 0;
  let learnedBelow = 0;
  let learnedOut = 0;
  for (let i = 0; i < (excluded?.count ?? 0); i++) {
    const member = (excluded as Exclusion).member(i);
    const weight = base.freqs[member];
    const count = learned.freq(member);
    weightsOut += weight;
    learnedOut += count;
    if (member < pos) {
      weightsBelow += weight;
      learnedBelow += count;
    }
  }
  const weightsCum = base.cums[pos] - weightsBelow;
  const weightsFreq = base.freqs[pos];
  const learnedCum = learned.cum(pos) - learnedBelow;
  const learnedFreq = learned.freq(pos);
  const scale = base.total;
  const buckets: Bucket[] = [[weightsCum, weightsFreq, scale - weightsOut]];
  for (const { prior } of lives) {
    buckets.push([
      weightsCum * prior + learnedCum * scale,
      weightsFreq * prior + learnedFreq * scale,
      scale * (prior + learned.total) - (weightsOut * prior + learnedOut * scale),
    ]);
  }
  return buckets;
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
  /** The learned counts every row shares, when the rows are pooled. */
  shared?: Fenwick;
  /** The encoder's journal, which every change to the view records its undo in. */
  readonly journal: Journal;
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
  /** The learned counts every row shares, when the rows are pooled. */
  shared?: Fenwick;
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
 * one bit. Every row learns only the values coded in it, unless `options`
 * pool the rows, and may weigh its learned counts against live rows of
 * their own (`PriorOptions`).
 *
 * A value may come with members excluded, ruled out by a model consulted
 * before this one: they own no states in any coding. A value whose
 * exclusion leaves one member is known without being written; it is
 * learned, but the first value and the selector wait for one that is
 * written. A value coded elsewhere entirely is learned through `learn`.
 *
 * A prior built with a lineage it does not root codes every value under
 * the `Blend` of the root's prior instead, with no selector: a node built
 * as a message goes starts from what its kin already learned.
 */
export class AdaptivePrior {
  /** The static table of each row. */
  readonly bases: readonly WeightTable[];
  /** The table of each row the live tables weigh their prior by. */
  private readonly liveBases: readonly WeightTable[];
  /** Whether every row learns into one set of counts. */
  private readonly pooled: boolean;
  /** Whether the learned counts keep every member seen. */
  private readonly keep: boolean;
  /** The prior of each adaptive coding, in selector order from 1. */
  readonly rungs: readonly number[];
  private readonly window: number;
  /** The selector's table: static as likely as every rung together. */
  private readonly selector: WeightTable;
  /** The selector's bucket under each coding, as `composeSelector` takes them. */
  private readonly choices: readonly Bucket[];
  /** Set when the prior joined a lineage it does not root: the root's prior it starts from. */
  private readonly parent?: AdaptivePrior;
  /** The key of the prior's gathered tables in a message's state, when it roots a lineage. */
  private readonly gathering = {};
  /** The key of the prior's blended tables in a message's state, when it has a parent. */
  private readonly blending = {};
  /** Each message's view on an encoder. */
  private readonly writings = new SlotCache<Writing, Encoder>(this, (enc) => ({
    written: 0,
    pending: [],
    live: false,
    lives: [],
    journal: enc.journal,
  }));
  /** Each message's view on a decoder. */
  private readonly readings = new SlotCache<Reading, Decoder>(this, () => ({
    read: 0,
    pending: [],
    coding: 0,
    lives: [],
  }));

  constructor(
    rows: readonly (readonly number[])[],
    readonly members: number,
    window: number | undefined,
    who: string,
    lineage?: Lineage,
    options: PriorOptions = {}
  ) {
    if (rows.length === 0) {
      throw new TypeError(`${who} adaptive prior needs at least one row of weights`);
    }
    checkAdaptiveMembers(members, who);
    if (window !== undefined) {
      checkPositive(window, who, 'window');
    }
    const parent = lineage?.pair(members, rows, who);
    this.parent = parent;
    // A prior paired with its root's has the same weights, and so shares
    // the root's tables.
    this.bases = parent?.bases ?? rows.map((row) => buildWeights(row, members, who));
    const { live, pooled = false, keep = false } = options;
    if (live !== undefined && live.length !== rows.length) {
      throw new TypeError(
        `${who} adaptive prior has ${rows.length} rows, but ${live.length} live rows`
      );
    }
    this.liveBases = live?.map((row) => buildWeights(row, members, who)) ?? this.bases;
    this.pooled = pooled;
    this.keep = keep;
    this.window = Math.max(window ?? DEFAULT_ADAPTIVE_WINDOW, members);
    this.rungs = parent?.rungs ?? ladderRungs(members);
    const total = [...this.bases, ...this.liveBases].reduce(
      (most, base) => Math.max(most, base.total),
      0
    );
    // From the slowest learner down, so an overflow names the rung it binds.
    for (const prior of [...this.rungs].reverse()) {
      checkOverflow(total, prior, this.window, who);
    }
    if (parent !== undefined) {
      // A blend codes every value, so the selector is never used.
      this.selector = parent.selector;
      this.choices = parent.choices;
      checkOverflow(total * (this.rungs[1] + parent.window), BLEND_SHARE, this.window, who);
      lineage?.join(this);
      return;
    }
    const selector = buildWeights(
      [this.rungs.length, ...this.rungs.map(() => 1)],
      1 + this.rungs.length,
      who
    );
    this.selector = selector;
    this.choices = selector.cums.map((cum, i) => [cum, selector.freqs[i], selector.total]);
    lineage?.join(this);
  }

  /**
   * This message's gathered table of `row` on `side`: the weights at the
   * second rung's prior, a middle learner, and every value the lineage's
   * nodes learned.
   */
  private gathered(side: Encoder | Decoder, row: number): LiveCounts {
    const tables = side.state<(LiveCounts | undefined)[]>(this.gathering, () => []);
    return (tables[row] ??= this.built(
      side,
      tables,
      row,
      new LiveCounts(this.bases[row], this.rungs[1], this.window, side.journal)
    ));
  }

  /**
   * `table`, just built as row `row` of `tables` on `side`, which drops it
   * again when a transaction open now rolls back.
   */
  private built<T>(side: Encoder | Decoder, tables: (T | undefined)[], row: number, table: T): T {
    if (side.journal?.active === true) {
      side.journal.call(() => {
        tables[row] = undefined;
      });
    }
    return table;
  }

  /** This message's blended table of `row` on `side`, from the parent's gathered one. */
  private blend(side: Encoder | Decoder, parent: AdaptivePrior, row: number): Blend {
    const tables = side.state<(Blend | undefined)[]>(this.blending, () => []);
    return (tables[row] ??= this.built(
      side,
      tables,
      row,
      new Blend(parent.gathered(side, row), this.window, side.journal)
    ));
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
    if (this.parent !== undefined) {
      const table = this.blend(enc, this.parent, row);
      writeExcluded(enc, table, excluded, pos);
      table.learn(pos);
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
        const buckets = rungBuckets(this.liveBases[row], this.rowLives(state, row), excluded, pos);
        // The static coding keeps the declared rows where the live ones differ.
        if (this.liveBases !== this.bases) {
          buckets[0] = excludedBucket(table, excluded, pos);
        }
        enc.composeAlternatives(this, buckets);
      }
      state.written++;
      if (state.journal.active) {
        state.journal.set(state, 'written', state.written - 1);
      }
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
    this.check(pos, row);
    if (this.parent !== undefined) {
      return excludedBucket(this.blend(enc, this.parent, row), excluded, pos);
    }
    // The slowest rung, twice the members, is above the fastest, at most
    // half of them, so there are always at least two.
    const lives = this.rowLives(this.writing(enc), row);
    return rungBuckets(this.liveBases[row], [lives[1]], excluded, pos)[1];
  }

  /** The cost, in `COST_UNITS`, of the bucket `estimate` gives. */
  cost(enc: Encoder, pos: number, row: number, excluded?: Exclusion): number {
    const [, freq, total] = this.estimate(enc, pos, row, excluded);
    return costUnits(freq, total);
  }

  /** Reads a member written by `write` in context `row` under the same exclusion. */
  read(dec: Decoder, row = 0, excluded?: Exclusion): number {
    const base = this.base(row);
    if (this.members === 1) {
      return 0;
    }
    if (this.parent !== undefined) {
      const table = this.blend(dec, this.parent, row);
      const pos = readExcluded(dec, table, excluded);
      table.learn(pos);
      return pos;
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
    if (this.parent !== undefined) {
      this.blend(side, this.parent, row).learn(pos);
    } else if (side instanceof Encoder) {
      this.teach(this.writing(side), pos, row);
    } else {
      this.study(this.reading(side), pos, row);
    }
  }

  private writing(enc: Encoder): Writing {
    return this.writings.get(enc);
  }

  private reading(dec: Decoder): Reading {
    return this.readings.get(dec);
  }

  /**
   * The encoder's live tables of `row`, one per rung. The first request
   * builds the tables of every row learned so far from the pending values;
   * from then on the values learn directly and a new row starts empty, or
   * from the counts the rows pool.
   */
  private rowLives(state: Writing, row: number): LiveCounts[] {
    const { journal, lives } = state;
    if (!state.live) {
      state.live = true;
      const learned = state.pending.splice(0);
      if (journal.active) {
        journal.call(() => {
          state.live = false;
          for (const n of learned) {
            state.pending.push(n);
          }
        });
      }
      for (let i = 0; i < learned.length; i += 2) {
        this.teach(state, learned[i], learned[i + 1]);
      }
    }
    let tables = lives[row];
    if (tables === undefined) {
      // Every rung learns the same values under the same window, so their
      // learned counts are one table, which the first rung learns into.
      const base = this.liveBases[row];
      const first = new LiveCounts(
        base,
        this.rungs[0],
        this.window,
        journal,
        this.pooled ? (state.shared ??= Fenwick.zeros(this.members, journal)) : undefined,
        this.keep
      );
      tables = this.rungs.map((prior, i) =>
        i === 0
          ? first
          : new LiveCounts(base, prior, this.window, journal, first.learned, this.keep)
      );
      lives[row] = tables;
      if (journal.active) {
        journal.call(() => {
          lives[row] = undefined;
        });
      }
    }
    return tables;
  }

  /**
   * The encoder learns `pos` in `row`: queued while no live table exists,
   * else into the learned counts every rung's table of the row shares.
   */
  private teach(state: Writing, pos: number, row: number): void {
    if (!state.live) {
      state.pending.push(pos, row);
      if (state.journal.active) {
        state.journal.truncate(state.pending, state.pending.length - 2);
      }
      return;
    }
    this.rowLives(state, row)[0].learn(pos);
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
      this.liveBases[row],
      this.rungs[state.coding - 1],
      this.window,
      undefined,
      this.pooled ? (state.shared ??= Fenwick.zeros(this.members)) : undefined,
      this.keep
    ));
  }
}
