/**
 * Repeats: LZ77-style matches over a sequence of integer items, code points
 * or bytes. Where a match is decodable, a sequence writes a flag telling a
 * match from a literal, and for a match how far back it starts and how many
 * items it copies. A match may instead name one of the last `REPS`
 * distances, and then writes only its length. The encoder finds matches
 * through hash chains over `MIN_MATCH` items; distances and lengths are
 * coded as a log2 bucket through an adaptive table, then uniformly within
 * the bucket.
 */

import {
  CorruptInputError,
  type Encoder,
  type Decoder,
  type Journal,
  COST_UNITS,
  costUnits,
  log2Units,
  type Undoable,
} from '../packer';
import { AdaptiveTable, readLive, writeLive, type LiveCounts, type LiveTable } from './adaptive';
import { KeyMap } from './keymap';

/** The shortest match at a new distance. */
export const MIN_MATCH = 3;

/** The shortest match at a cached distance. */
export const REP_MIN = 2;

/** The distances a sequence keeps for matches to name again. */
export const REPS = 4;

/** Which flag table a position's flag goes through: 2 right after a match, 1 after a literal the highest context coded, else 0. */
export type FlagContext = 0 | 1 | 2;

/** The candidates the finder examines per position. */
export const CHAIN_DEPTH = 256;

/** The log2 buckets of values in `[1, 2^32)`. */
const BUCKETS = 32;

/** The largest maximum a bucketed value is coded under. */
const MAX_BUCKETED = 2 ** 32 - 1;

/** The window of every repeat table. */
const WINDOW = 1024;

/** The log2 bucket of `v`, an integer in `[1, 2^32)`. */
const bucketOf = (v: number): number => 31 - Math.clz32(v);

/** Refuses a number that is not an integer in `[min, max]`, naming it `what`. */
function checkInteger(n: number, min: number, max: number, what: string): void {
  if (!Number.isInteger(n)) {
    throw new TypeError(`${what} must be an integer, got ${n}`);
  }
  if (n < min) {
    throw new RangeError(`${what} ${n} is below the minimum ${min}`);
  }
  if (n > max) {
    throw new RangeError(`${what} ${n} is above the maximum ${max}`);
  }
}

/**
 * A match: `length` items copied from `distance` items back. `rep` is the
 * index of `distance` among the cached distances when the match names it
 * there, and undefined for a new distance.
 */
export interface Match {
  readonly distance: number;
  readonly length: number;
  readonly rep?: number;
}

/** The hash of `items[at..at + MIN_MATCH)`. */
function hashAt(items: readonly number[], at: number): number {
  let h = 0;
  for (let k = 0; k < MIN_MATCH; k++) {
    h = (Math.imul(h, 0x9e3779b1) + items[at + k]) | 0;
  }
  return h;
}

/**
 * The encoder's finder over one message's items: hash chains over
 * `MIN_MATCH` items. A registration records its undo in `journal`.
 */
export class Finder implements Undoable {
  /** The newest registered position of each hash. */
  private readonly head = new KeyMap<number>();
  /** The previous registered position with the same hash, -1 for none, by position. */
  private prev = new Int32Array(64);
  /** The last registered position, -1 before the first. */
  private last = -1;

  /** The items the last position registered is in, which its undo rewinds over. */
  private items: readonly number[] = [];

  constructor(private readonly journal?: Journal) {}

  /**
   * Registers position `at` of `items`, which holds at least `MIN_MATCH`
   * items from it. Each position is registered once, in rising order, so a
   * chain only ever leads to older positions.
   */
  insert(items: readonly number[], at: number): void {
    checkInteger(at, this.last + 1, items.length - MIN_MATCH, 'Position');
    const h = hashAt(items, at);
    if (at >= this.prev.length) {
      const prev = new Int32Array(Math.max(2 * this.prev.length, at + 1));
      prev.set(this.prev);
      this.prev = prev;
    }
    this.prev[at] = this.head.get(h) ?? -1;
    this.head.set(h, at);
    this.last = at;
    if (this.journal?.active === true) {
      this.items = items;
      this.journal.own(this, 0, at);
    }
  }

  /** Takes back the registration of position `at`. */
  undo(_op: number, at: number): void {
    this.rewind(this.items, at);
  }

  /**
   * Unregisters every position from `from` on, newest first, so the chains
   * stand as they did before `from` was registered and `from` registers next.
   */
  rewind(items: readonly number[], from: number): void {
    checkInteger(from, 0, this.last + 1, 'Position');
    for (; this.last >= from; this.last--) {
      const h = hashAt(items, this.last);
      const prev = this.prev[this.last];
      if (prev < 0) {
        this.head.delete(h);
      } else {
        this.head.set(h, prev);
      }
    }
  }

  /**
   * Every match for position `at` that is longer than each nearer one,
   * ending within `at + limit` and within `items`, nearest first: the
   * nearest distance of each length the chain improves to, from `MIN_MATCH`
   * items. At most `CHAIN_DEPTH` candidates are examined.
   */
  matches(items: readonly number[], at: number, limit: number): Match[] {
    checkInteger(at, 0, items.length, 'Position');
    const found: Match[] = [];
    const most = Math.min(Math.floor(limit), items.length - at);
    if (most < MIN_MATCH) {
      return found;
    }
    let length = MIN_MATCH - 1;
    let cand = this.head.get(hashAt(items, at)) ?? -1;
    for (let depth = 0; cand >= 0 && depth < CHAIN_DEPTH; cand = this.prev[cand]) {
      if (cand >= at) {
        continue;
      }
      depth++;
      if (items[cand + length] !== items[at + length]) {
        continue;
      }
      let l = 0;
      while (l < most && items[cand + l] === items[at + l]) {
        l++;
      }
      if (l > length) {
        length = l;
        found.push({ distance: at - cand, length: l });
        if (l === most) {
          break;
        }
      }
    }
    return found;
  }
}

/** Refuses a maximum a bucketed value cannot be coded under. */
function checkMax(max: number): void {
  checkInteger(max, 1, MAX_BUCKETED, 'Maximum');
}

/**
 * A live table cut to the buckets of values up to a maximum in bucket
 * `top`: members `0..top`, their buckets unchanged, the total ending at `top`'s.
 */
function restricted(live: LiveCounts, top: number): LiveTable {
  const count = top + 1;
  const table: LiveTable = {
    size: count,
    total: live.cum(top) + live.freq(top),
    cum: (pos) => live.cum(pos),
    freq: (pos) => live.freq(pos),
    locate(residual) {
      let lo = 0;
      let hi = top;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (live.cum(mid) <= residual) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    located: (pos) => live.located(pos),
  };
  return table;
}

/** The width of bucket `b` under `max`: `[2^b, 2^(b+1))` capped at `max`. */
function widthOf(b: number, max: number): number {
  const lo = 2 ** b;
  return Math.min(2 * lo - 1, max) - lo + 1;
}

/**
 * Writes `v`, an integer in `[1, max]`, as its log2 bucket through `table`
 * restricted to the buckets `max` allows, then its offset in the bucket
 * uniformly. `max` is a positive integer below 2^32. The table learns the
 * bucket.
 */
export function writeBucketed(enc: Encoder, table: AdaptiveTable, v: number, max: number): void {
  checkMax(max);
  checkInteger(v, 1, max, 'Value');
  const live = table.live(enc);
  const b = bucketOf(v);
  writeLive(enc, restricted(live, bucketOf(max)), b);
  live.learn(b);
  enc.compose(v - 2 ** b, widthOf(b, max));
}

/** Reads a value written by `writeBucketed` under the same `max`. */
export function readBucketed(dec: Decoder, table: AdaptiveTable, max: number): number {
  checkMax(max);
  const live = table.live(dec);
  const b = readLive(dec, restricted(live, bucketOf(max)));
  live.learn(b);
  return 2 ** b + dec.parse(widthOf(b, max));
}

/** The cost, in `COST_UNITS`, `writeBucketed` would give `v` now, learning nothing. */
function priceBucketed(
  side: Encoder | Decoder,
  table: AdaptiveTable,
  v: number,
  max: number
): number {
  const live = table.live(side);
  const b = bucketOf(v);
  const top = bucketOf(max);
  return costUnits(live.freq(b), live.cum(top) + live.freq(top)) + log2Units(widthOf(b, max));
}

/** Refuses the bounds of a match position: `maxDistance` at least 1, `maxLength` at least `MIN_MATCH`. */
function checkBounds(maxDistance: number, maxLength: number): void {
  checkInteger(maxDistance, 1, MAX_BUCKETED, 'Maximum distance');
  checkInteger(maxLength, MIN_MATCH, MAX_BUCKETED, 'Maximum length');
}

/**
 * Refuses a match outside the bounds of its position: a rep index in
 * `[0, REPS)` with a length from `REP_MIN`, or a new distance with a length
 * from `MIN_MATCH`.
 */
function checkMatch(match: Match, maxDistance: number, maxLength: number): void {
  checkBounds(maxDistance, maxLength);
  checkInteger(match.distance, 1, maxDistance, 'Match distance');
  if (match.rep === undefined) {
    checkInteger(match.length, MIN_MATCH, maxLength, 'Match length');
  } else {
    checkInteger(match.rep, 0, REPS - 1, 'Match rep');
    checkInteger(match.length, REP_MIN, maxLength, 'Match length');
  }
}

/**
 * How a sequence spells its repeats: whether a value spells any, the match
 * flag at each position a repeat is decodable at, and each match. `price*`
 * are the cost, in `COST_UNITS`, the matching `write*` would give its
 * symbols now, learning nothing.
 */
export interface RepeatCoding {
  /** Whether a match may name one of the cached distances again. */
  readonly cached: boolean;
  writeUsed(enc: Encoder, used: boolean): void;
  readUsed(dec: Decoder): boolean;
  writeFlag(enc: Encoder, match: boolean, context: FlagContext): void;
  readFlag(dec: Decoder, context: FlagContext): boolean;
  priceFlag(side: Encoder | Decoder, match: boolean, context: FlagContext): number;
  writeMatch(enc: Encoder, match: Match, maxDistance: number, maxLength: number): void;
  readMatch(dec: Decoder, maxDistance: number, maxLength: number, reps: readonly number[]): Match;
  priceMatch(
    side: Encoder | Decoder,
    match: Match,
    maxDistance: number,
    maxLength: number,
    context: FlagContext
  ): number;
  /** The part of `priceMatch` before the length: the flag, the kind and a new distance. */
  priceHead(
    side: Encoder | Decoder,
    match: Match,
    maxDistance: number,
    context: FlagContext
  ): number;
  /** The part of `priceMatch` for the length: `priceMatch` less `priceHead`. */
  priceLength(side: Encoder | Decoder, match: Match, maxLength: number): number;
}

/**
 * The repeat tables of one node: the per-value branch, the match flag in
 * each flag context, the match kind, distance buckets, length buckets, and
 * the length buckets of a match at a cached distance.
 */
export class Repeats implements RepeatCoding {
  readonly cached = true;
  private readonly used: AdaptiveTable;
  private readonly flags: readonly AdaptiveTable[];
  /** Members 0 to `REPS - 1` name a cached distance, `REPS` a new one. */
  private readonly kind: AdaptiveTable;
  private readonly distance: AdaptiveTable;
  private readonly length: AdaptiveTable;
  private readonly repLength: AdaptiveTable;

  constructor(who: string) {
    this.used = new AdaptiveTable([1, 1], 2, 2, WINDOW, who);
    this.flags = [0, 1, 2].map(() => new AdaptiveTable([1, 1], 2, 2, WINDOW, who));
    this.kind = new AdaptiveTable(new Array<number>(REPS + 1).fill(1), REPS + 1, 2, WINDOW, who);
    const ones = new Array<number>(BUCKETS).fill(1);
    this.distance = new AdaptiveTable(ones, BUCKETS, 2, WINDOW, who);
    this.length = new AdaptiveTable(ones, BUCKETS, 2, WINDOW, who);
    this.repLength = new AdaptiveTable(ones, BUCKETS, 2, WINDOW, who);
  }

  /** The flag table of `context`. */
  private flag(context: FlagContext): AdaptiveTable {
    return this.flags[context];
  }

  /** Writes whether this value spells repeats at all. */
  writeUsed(enc: Encoder, used: boolean): void {
    this.used.write(enc, used ? 1 : 0);
  }

  /** Reads the branch written by `writeUsed`. */
  readUsed(dec: Decoder): boolean {
    return this.used.read(dec) === 1;
  }

  /** Writes whether a match starts at this position, through the flag table of `context`. */
  writeFlag(enc: Encoder, match: boolean, context: FlagContext): void {
    this.flag(context).write(enc, match ? 1 : 0);
  }

  /** Reads the flag written by `writeFlag` in the same context. */
  readFlag(dec: Decoder, context: FlagContext): boolean {
    return this.flag(context).read(dec) === 1;
  }

  /**
   * Writes a match at a position with `maxDistance` items before it and
   * `maxLength` items still allowed: its kind, the rep index or a new
   * distance; for a rep, the length in `[REP_MIN, maxLength]`, coded as
   * `length - REP_MIN + 1` of at most `maxLength - REP_MIN + 1`; for a new
   * distance, the distance in `[1, maxDistance]`, then the length in
   * `[MIN_MATCH, maxLength]`, coded as `length - MIN_MATCH + 1` of at most
   * `maxLength - MIN_MATCH + 1`.
   */
  writeMatch(enc: Encoder, match: Match, maxDistance: number, maxLength: number): void {
    checkMatch(match, maxDistance, maxLength);
    const { rep } = match;
    this.kind.write(enc, rep ?? REPS);
    if (rep !== undefined) {
      writeBucketed(enc, this.repLength, match.length - REP_MIN + 1, maxLength - REP_MIN + 1);
      return;
    }
    writeBucketed(enc, this.distance, match.distance, maxDistance);
    writeBucketed(enc, this.length, match.length - MIN_MATCH + 1, maxLength - MIN_MATCH + 1);
  }

  /**
   * Reads a match written by `writeMatch` under the same bounds, `reps` the
   * `REPS` cached distances: a rep match comes back with its distance
   * looked up there and `rep` set. A cached distance above `maxDistance`
   * was never named, so naming it is corrupt.
   */
  readMatch(dec: Decoder, maxDistance: number, maxLength: number, reps: readonly number[]): Match {
    checkBounds(maxDistance, maxLength);
    const rep = this.kind.read(dec);
    if (rep < REPS) {
      const distance = reps[rep];
      if (distance > maxDistance) {
        throw new CorruptInputError(
          `Repeat distance ${distance} is above the maximum ${maxDistance}`
        );
      }
      const length = readBucketed(dec, this.repLength, maxLength - REP_MIN + 1) + REP_MIN - 1;
      return { distance, length, rep };
    }
    const distance = readBucketed(dec, this.distance, maxDistance);
    const length = readBucketed(dec, this.length, maxLength - MIN_MATCH + 1) + MIN_MATCH - 1;
    return { distance, length };
  }

  /** The cost, in `COST_UNITS`, the flag would be written with now in `context`, learning nothing. */
  priceFlag(side: Encoder | Decoder, match: boolean, context: FlagContext): number {
    const [, freq, total] = this.flag(context).bucket(side, match ? 1 : 0);
    return costUnits(freq, total);
  }

  /**
   * The cost, in `COST_UNITS`, a match would be written with now, its flag
   * in `context`, learning nothing: its flag, its kind, then
   * for a rep its length's bucket and offset, and for a new distance the
   * distance's bucket and offset and the length's.
   */
  priceMatch(
    side: Encoder | Decoder,
    match: Match,
    maxDistance: number,
    maxLength: number,
    context: FlagContext
  ): number {
    checkMatch(match, maxDistance, maxLength);
    return (
      this.priceHead(side, match, maxDistance, context) + this.priceLength(side, match, maxLength)
    );
  }

  priceHead(
    side: Encoder | Decoder,
    match: Match,
    maxDistance: number,
    context: FlagContext
  ): number {
    const { rep } = match;
    const [, freq, total] = this.kind.bucket(side, rep ?? REPS);
    const head = this.priceFlag(side, true, context) + costUnits(freq, total);
    return rep === undefined
      ? head + priceBucketed(side, this.distance, match.distance, maxDistance)
      : head;
  }

  priceLength(side: Encoder | Decoder, match: Match, maxLength: number): number {
    return match.rep === undefined
      ? priceBucketed(side, this.length, match.length - MIN_MATCH + 1, maxLength - MIN_MATCH + 1)
      : priceBucketed(side, this.repLength, match.length - REP_MIN + 1, maxLength - REP_MIN + 1);
  }
}

/** Writes `v`, an integer in `[1, max]`, as its log2 bucket among those `max` allows and its offset in the bucket, each uniformly. */
function writeEven(enc: Encoder, v: number, max: number): void {
  checkMax(max);
  checkInteger(v, 1, max, 'Value');
  const b = bucketOf(v);
  enc.compose(b, bucketOf(max) + 1);
  enc.compose(v - 2 ** b, widthOf(b, max));
}

/** Reads a value written by `writeEven` under the same `max`. */
function readEven(dec: Decoder, max: number): number {
  checkMax(max);
  const b = dec.parse(bucketOf(max) + 1);
  return 2 ** b + dec.parse(widthOf(b, max));
}

/** The cost, in `COST_UNITS`, `writeEven` gives `v`. */
function priceEven(v: number, max: number): number {
  return log2Units(bucketOf(max) + 1) + log2Units(widthOf(bucketOf(v), max));
}

/** Refuses a match naming a cached distance, which fixed-odds repeats never do. */
function checkNew(match: Match, maxDistance: number, maxLength: number): void {
  checkMatch(match, maxDistance, maxLength);
  if (match.rep !== undefined) {
    throw new TypeError('Repeats at fixed odds name no cached distance');
  }
}

/**
 * Repeats at fixed odds, for a node that declares them without learning:
 * the branch and every flag one even bit, a match its distance and length
 * as `Repeats` codes a new distance's, each bucket among those the bound
 * allows equally likely. There is no cache of distances, so every match
 * names its distance.
 */
export const EVEN_REPEATS: RepeatCoding = {
  cached: false,

  writeUsed(enc, used) {
    enc.compose(used ? 1 : 0, 2);
  },

  readUsed(dec) {
    return dec.parse(2) === 1;
  },

  writeFlag(enc, match) {
    enc.compose(match ? 1 : 0, 2);
  },

  readFlag(dec) {
    return dec.parse(2) === 1;
  },

  priceFlag() {
    return COST_UNITS;
  },

  writeMatch(enc, match, maxDistance, maxLength) {
    checkNew(match, maxDistance, maxLength);
    writeEven(enc, match.distance, maxDistance);
    writeEven(enc, match.length - MIN_MATCH + 1, maxLength - MIN_MATCH + 1);
  },

  readMatch(dec, maxDistance, maxLength) {
    checkBounds(maxDistance, maxLength);
    const distance = readEven(dec, maxDistance);
    const length = readEven(dec, maxLength - MIN_MATCH + 1) + MIN_MATCH - 1;
    return { distance, length };
  },

  priceMatch(_side, match, maxDistance, maxLength) {
    checkNew(match, maxDistance, maxLength);
    return (
      COST_UNITS +
      priceEven(match.distance, maxDistance) +
      priceEven(match.length - MIN_MATCH + 1, maxLength - MIN_MATCH + 1)
    );
  },

  priceHead(_side, match, maxDistance) {
    return COST_UNITS + priceEven(match.distance, maxDistance);
  },

  priceLength(_side, match, maxLength) {
    return priceEven(match.length - MIN_MATCH + 1, maxLength - MIN_MATCH + 1);
  },
};
