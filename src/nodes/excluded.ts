/**
 * Exclusion: members of a table ruled out before a symbol is coded, because
 * a model consulted earlier for the same symbol has already said it is none
 * of them. An excluded member keeps its index but owns no states, so the
 * others share the states it would have taken and cost less.
 */

import type { Encoder, Decoder, Bucket } from '../packer';
import type { WeightTable } from './weights';

/** A set of members ruled out of a table: they keep their index but own no states. */
export class Exclusion {
  /** 1 for each excluded member. */
  private readonly flags: Uint8Array;
  /** The excluded members, in the order they were added, in the first `count` slots. */
  private readonly list: Int32Array;
  private added = 0;

  /** Over `size` members, a non-negative integer. */
  constructor(readonly size: number) {
    if (!Number.isInteger(size)) {
      throw new TypeError(`Exclusion size must be an integer, got ${size}`);
    }
    if (size < 0) {
      throw new RangeError(`Exclusion size ${size} is negative`);
    }
    this.flags = new Uint8Array(size);
    this.list = new Int32Array(size);
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

  /** Whether member `pos` is excluded; no position outside the members is. */
  has(pos: number): boolean {
    return this.flags[pos] === 1;
  }

  /** Excludes member `pos`, an integer in `[0, size)`; excluding it again changes nothing. */
  add(pos: number): void {
    if (!Number.isInteger(pos) || pos < 0 || pos >= this.size) {
      throw new RangeError(`Excluded member ${pos} is outside [0, ${this.size})`);
    }
    if (this.flags[pos] === 0) {
      this.flags[pos] = 1;
      this.list[this.added++] = pos;
    }
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
 * Reads a member written by `writeExcluded`. A residual belongs to the
 * largest member whose bucket starts at or below it: the starts never fall,
 * and members with empty buckets share the start of the next one, so the
 * bisection lands past them. A start is the table's less the widths of the
 * excluded members below it, which `shed` sums over the excluded members
 * in ascending order.
 */
export function readExcluded(dec: Decoder, table: Table, exclusion: Exclusion | undefined): number {
  const count = exclusion?.count ?? 0;
  const excluded = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    excluded[i] = (exclusion as Exclusion).member(i);
  }
  excluded.sort();
  const shed = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) {
    shed[i + 1] = shed[i] + table.freq(excluded[i]);
  }
  /** The start of member `pos`'s bucket under the exclusion. */
  const start = (pos: number): number => {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (excluded[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    return table.cum(pos) - shed[lo];
  };
  const locate = (residual: number): readonly [number, number, number] => {
    let lo = 0;
    let hi = table.size - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (start(mid) <= residual) lo = mid;
      else hi = mid - 1;
    }
    // The member found holds the residual, so it owns states: it is not excluded.
    return [lo, start(lo), table.freq(lo)];
  };
  return dec.parseWeighted(table.total - shed[count], locate);
}
