/**
 * Exclusion: members of a table ruled out before a symbol is coded, because
 * a model consulted earlier for the same symbol has already said it is none
 * of them. An excluded member keeps its index but owns no states, so the
 * others share the states it would have taken and cost less.
 */

import { CorruptInputError, type Encoder, type Decoder, type Bucket } from '../packer';
import type { WeightTable } from './weights';

/** The members an exclusion makes room for before it first grows. */
const FIRST_ROOM = 256;

/**
 * A set of members ruled out of a table: they keep their index but own no
 * states. Its room grows with the largest member excluded, so a table of
 * many members that are rarely excluded costs little.
 */
export class Exclusion {
  /** 1 for each excluded member, over the members there is room for. */
  private flags: Uint8Array;
  /** The excluded members, in the order they were added, in the first `count` slots. */
  private list: Int32Array;
  private added = 0;

  /** Over `size` members, a non-negative integer. */
  constructor(readonly size: number) {
    if (!Number.isInteger(size)) {
      throw new TypeError(`Exclusion size must be an integer, got ${size}`);
    }
    if (size < 0) {
      throw new RangeError(`Exclusion size ${size} is negative`);
    }
    const room = Math.min(size, FIRST_ROOM);
    this.flags = new Uint8Array(room);
    this.list = new Int32Array(room);
  }

  /** The number of excluded members. */
  get count(): number {
    return this.added;
  }

  /** The excluded members, in the order they were added. */
  get members(): readonly number[] {
    return Array.from(this.list.subarray(0, this.added));
  }

  /** Excluded member `i`, `i` in `[0, count)`, in the order they were added. */
  member(i: number): number {
    return this.list[i];
  }

  /** Whether member `pos` is excluded; no position outside the room is. */
  has(pos: number): boolean {
    return this.flags[pos] === 1;
  }

  /** Excludes member `pos`, an integer in `[0, size)`; excluding it again changes nothing. */
  add(pos: number): void {
    if (!Number.isInteger(pos) || pos < 0 || pos >= this.size) {
      throw new RangeError(`Excluded member ${pos} is outside [0, ${this.size})`);
    }
    if (pos >= this.flags.length) {
      this.grow(pos);
    }
    if (this.flags[pos] === 0) {
      this.flags[pos] = 1;
      this.list[this.added++] = pos;
    }
  }

  /** Makes room for member `pos`, doubling the room past it, within the members. */
  private grow(pos: number): void {
    let room = this.flags.length * 2;
    while (room <= pos) {
      room *= 2;
    }
    room = Math.min(room, this.size);
    const flags = new Uint8Array(room);
    flags.set(this.flags);
    const list = new Int32Array(room);
    list.set(this.list);
    this.flags = flags;
    this.list = list;
  }

  /** Readmits every member. */
  clear(): void {
    const { flags, list } = this;
    for (let i = 0; i < this.added; i++) {
      flags[list[i]] = 0;
    }
    this.added = 0;
  }
}

/**
 * A table of `size` members as exclusion sees it: member `pos` owns
 * `[cum(pos), cum(pos) + freq(pos))` of `total`. `LiveCounts`, `Fenwick`
 * and a learned context satisfy it; a static `WeightTable` is wrapped by
 * `staticTable`.
 */
export interface Table {
  readonly size: number;
  readonly total: number;
  cum(pos: number): number;
  freq(pos: number): number;
  /** The largest member whose bucket starts at or below `residual`, an integer in `[0, total)`, where the table finds it faster than bisection. */
  locate?(residual: number): number;
}

/** The static table `base` as a `Table`; a position outside its entries is a RangeError. */
export function staticTable(base: WeightTable): Table {
  const check = (pos: number): void => {
    if (base.freqs[pos] === undefined) {
      throw new RangeError(
        `Position ${pos} is not one of the table's ${base.freqs.length} entries`
      );
    }
  };
  return {
    size: base.cums.length,
    total: base.total,
    cum: (pos) => {
      check(pos);
      return base.cums[pos];
    },
    freq: (pos) => {
      check(pos);
      return base.freqs[pos];
    },
    locate: (residual) => base.locate(residual)[0],
  };
}

/**
 * Member `pos`'s bucket in `table` with the members of `exclusion` ruled
 * out: `[cum, freq, total]`, `cum` less the excluded widths below `pos`,
 * `total` less all of them, and `freq` 0 when `pos` itself is excluded.
 */
export function excludedBucket(
  table: Table,
  exclusion: Exclusion | undefined,
  pos: number
): Bucket {
  let cum = table.cum(pos);
  const freq = table.freq(pos);
  let total = table.total;
  if (exclusion === undefined) {
    return [cum, freq, total];
  }
  for (let i = 0; i < exclusion.count; i++) {
    const member = exclusion.member(i);
    const width = table.freq(member);
    total -= width;
    if (member < pos) {
      cum -= width;
    }
  }
  return [cum, exclusion.has(pos) ? 0 : freq, total];
}

/**
 * Writes member `pos` under the exclusion as one weighted symbol; a bucket
 * holding every state writes nothing. Without an exclusion it writes what `writeLive`
 * writes for a live table.
 */
export function writeExcluded(
  enc: Encoder,
  table: Table,
  exclusion: Exclusion | undefined,
  pos: number
): void {
  const [cum, freq, total] = excludedBucket(table, exclusion, pos);
  enc.composeWeighted(cum, freq, total);
}

/**
 * The excluded members `readExcluded` sorts and the sums of their widths,
 * reused across reads: a read finishes before the next begins.
 */
let scratchExcluded = new Int32Array(FIRST_ROOM);
let scratchShed = new Float64Array(FIRST_ROOM + 1);

/**
 * Reads a member written by `writeExcluded`. A residual belongs to the
 * largest member whose bucket starts at or below it: the starts never fall,
 * and members with empty buckets share the start of the next one, so the
 * search lands past them. A start is the table's less the widths of the
 * excluded members below it, which `shed` sums over the excluded members
 * in ascending order.
 *
 * A table that locates its own residuals is searched from the residual up:
 * shifted by the widths of the `k` lowest excluded members, the residual
 * falls in the table's member `pos`, and when exactly `k` excluded members
 * lie at or below `pos` it is the one; else `k` becomes their count and the
 * search repeats. `k` only grows and never passes the count below the
 * member sought, so it settles there. Any other table is bisected.
 */
export function readExcluded(dec: Decoder, table: Table, exclusion: Exclusion | undefined): number {
  const count = exclusion?.count ?? 0;
  if (count >= scratchExcluded.length) {
    scratchExcluded = new Int32Array(2 * count);
    scratchShed = new Float64Array(2 * count + 1);
  }
  const excluded = scratchExcluded;
  const shed = scratchShed;
  for (let i = 0; i < count; i++) {
    excluded[i] = (exclusion as Exclusion).member(i);
  }
  excluded.subarray(0, count).sort();
  for (let i = 0; i < count; i++) {
    shed[i + 1] = shed[i] + table.freq(excluded[i]);
  }
  // A corrupt input can rule out every member that owns states, leaving
  // nothing a valid message could have written.
  if (table.total - shed[count] <= 0) {
    throw new CorruptInputError('Input reads a symbol where every one is ruled out');
  }
  /** How many excluded members lie below `pos`, or at it too when `at`, `from` known to. */
  const below = (pos: number, at: boolean, from: number): number => {
    let lo = from;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (excluded[mid] < pos || (at && excluded[mid] === pos)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const own = table.locate;
  if (own !== undefined) {
    return dec.parseWeighted(table.total - shed[count], (residual) => {
      for (let k = 0; ; ) {
        const pos = own.call(table, residual + shed[k]);
        const at = below(pos, true, k);
        if (at === k) {
          return [pos, table.cum(pos) - shed[k], table.freq(pos)];
        }
        k = at;
      }
    });
  }
  /** The start of member `pos`'s bucket under the exclusion. */
  const start = (pos: number): number => table.cum(pos) - shed[below(pos, false, 0)];
  return dec.parseWeighted(table.total - shed[count], (residual) => {
    let lo = 0;
    let hi = table.size - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (start(mid) <= residual) lo = mid;
      else hi = mid - 1;
    }
    // The member found holds the residual, so it owns states: it is not excluded.
    return [lo, start(lo), table.freq(lo)];
  });
}
