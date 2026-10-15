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
  /** The excluded members, in the order they were added. */
  private readonly list: number[] = [];

  /** Over `size` members, a non-negative integer. */
  constructor(readonly size: number) {
    if (!Number.isInteger(size)) {
      throw new TypeError(`Exclusion size must be an integer, got ${size}`);
    }
    if (size < 0) {
      throw new RangeError(`Exclusion size ${size} is negative`);
    }
    this.flags = new Uint8Array(size);
  }

  /** The number of excluded members. */
  get count(): number {
    return this.list.length;
  }

  /** The excluded members, in the order they were added. */
  get members(): readonly number[] {
    return this.list;
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
      this.list.push(pos);
    }
  }

  /** Readmits every member. */
  clear(): void {
    for (const pos of this.list) {
      this.flags[pos] = 0;
    }
    this.list.length = 0;
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

/** Where member `pos`'s bucket starts once the excluded members below it give up their states. */
function excludedCum(table: Table, exclusion: Exclusion | undefined, pos: number): number {
  let cum = table.cum(pos);
  if (exclusion !== undefined) {
    for (const member of exclusion.members) {
      if (member < pos) {
        cum -= table.freq(member);
      }
    }
  }
  return cum;
}

/** The table's total less the states of every excluded member. */
function excludedTotal(table: Table, exclusion: Exclusion | undefined): number {
  let total = table.total;
  if (exclusion !== undefined) {
    for (const member of exclusion.members) {
      total -= table.freq(member);
    }
  }
  return total;
}

/** The width of member `pos`'s bucket: none when it is excluded. */
function excludedFreq(table: Table, exclusion: Exclusion | undefined, pos: number): number {
  const freq = table.freq(pos);
  return exclusion?.has(pos) ? 0 : freq;
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
  return [
    excludedCum(table, exclusion, pos),
    excludedFreq(table, exclusion, pos),
    excludedTotal(table, exclusion),
  ];
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
 * bisection lands past them.
 */
export function readExcluded(dec: Decoder, table: Table, exclusion: Exclusion | undefined): number {
  const locate = (residual: number): readonly [number, number, number] => {
    let lo = 0;
    let hi = table.size - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (excludedCum(table, exclusion, mid) <= residual) lo = mid;
      else hi = mid - 1;
    }
    return [lo, excludedCum(table, exclusion, lo), excludedFreq(table, exclusion, lo)];
  };
  return dec.parseWeighted(excludedTotal(table, exclusion), locate);
}
