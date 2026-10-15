/**
 * Shared validation and bucket arithmetic for user-declared weights: a prior
 * over a node's states, spent exactly through the weighted packer. Integer
 * weights only — both sides must derive bit-identical tables, and floats
 * normalize differently across platforms.
 */

import type { Encoder, Decoder } from '../packer';

/** The triple `parseWeighted` lookups return: the member and its bucket. */
export type Bucket = readonly [number, number, number];

export interface WeightTable {
  readonly cums: readonly number[];
  readonly freqs: readonly number[];
  readonly total: number;
  /** Bucket lookup for `parseWeighted`: the index owning the residual. */
  readonly locate: (residual: number) => Bucket;
}

/**
 * The table of one weight per state. `states` is a positive integer, so every
 * table has at least one bucket and, each weight being at least 1, a
 * positive total.
 */
export function buildWeights(weights: readonly number[], states: number, who: string): WeightTable {
  if (!Number.isInteger(states)) {
    throw new TypeError(`${who} weights need a whole number of values, got ${states}`);
  }
  if (states < 1) {
    throw new RangeError(`${who} weights need at least one value, got ${states}`);
  }
  if (weights.length !== states) {
    throw new TypeError(
      `${who} weights must list one weight per value: expected ${states}, got ${weights.length}`
    );
  }
  const cums: number[] = [];
  let total = 0;
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 1) {
      throw new TypeError(`${who} weights must be positive integers, got ${w}`);
    }
    cums.push(total);
    total += w;
  }
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`${who} weights must sum to a safe integer`);
  }
  const freqs = [...weights];
  const last = cums.length - 1;
  const guide = guideOf(cums, total);
  // The bucket holding `residual`, for a residual in [0, total) as
  // `parseWeighted` passes; one below 0, or NaN, lands in the first bucket and
  // one at or past `total` in the last.
  const locate = (residual: number): Bucket => {
    let lo = 0;
    if (!(residual >= 0)) {
      lo = 0;
    } else if (residual >= total) {
      lo = last;
    } else if (guide !== undefined) {
      // The guide names the bucket owning the lowest residual of the slice
      // `residual` falls in, at or before its own; the scan walks on from
      // there. Both products are safe integers and the quotient is at least
      // 1/total from any integer it is not, more than half its spacing, so
      // the floor is exact.
      lo = guide[Math.floor((residual * guide.length) / total)];
      while (lo < last && cums[lo + 1] <= residual) {
        lo++;
      }
    } else {
      let hi = last;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cums[mid] <= residual) lo = mid;
        else hi = mid - 1;
      }
    }
    return [lo, cums[lo], freqs[lo]];
  };
  return { cums, freqs, total, locate };
}

/** The fewest buckets a table needs before a guide speeds up its lookups. */
const GUIDED = 16;

/**
 * A lookup guide for a table of `cums` over `total`: `total` cut into twice
 * as many equal slices as buckets, each naming the bucket that owns its
 * lowest residual. None for a small table, or one whose slice arithmetic
 * would leave the safe integers.
 */
function guideOf(cums: readonly number[], total: number): Int32Array | undefined {
  const slices = 2 * cums.length;
  if (cums.length < GUIDED || total * slices > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  const guide = new Int32Array(slices);
  let owner = 0;
  for (let slice = 0; slice < slices; slice++) {
    // The lowest residual of the slice: ceil(slice * total / slices).
    const lowest = Math.ceil((slice * total) / slices);
    while (owner < cums.length - 1 && cums[owner + 1] <= lowest) {
      owner++;
    }
    guide[slice] = owner;
  }
  return guide;
}

/** Write the `pos`-th entry of a weight table as one weighted symbol. */
export function writeTable(enc: Encoder, table: WeightTable, pos: number): void {
  if (table.freqs[pos] === undefined) {
    throw new RangeError(`Position ${pos} is not one of the table's ${table.freqs.length} entries`);
  }
  enc.composeWeighted(table.cums[pos], table.freqs[pos], table.total);
}

/** Read one weighted symbol written by `writeTable`: the entry's position. */
export function readTable(dec: Decoder, table: WeightTable): number {
  return dec.parseWeighted(table.total, table.locate);
}

/**
 * An integer CDF over an indexed range: `cdf(v)` is the cumulative weight of
 * all values below `v`, so a value's own weight is `cdf(v + 1) - cdf(v)`.
 * The function is part of the wire format, and both sides must compute
 * bit-identical values — only BigInt and the correctly-rounded float ops
 * (`+ - * /`, `Math.sqrt`) qualify; `Math.exp` and friends vary across engines.
 */
export type Cdf = (v: number) => number;

/**
 * The definition-time checks of an integer range, either bound optional: each
 * bound is an integer, and a pair is non-empty and spans at most 2^53
 * values, so index arithmetic (`index - lo`) stays exact. `show` spells a
 * bound as the value it stands for in an error.
 */
export function checkRange(
  who: string,
  lo?: number,
  hi?: number,
  show: (index: number) => string = String
): void {
  if (lo !== undefined && !Number.isInteger(lo)) {
    throw new TypeError(`${who} min must be an integer, got ${lo}`);
  }
  if (hi !== undefined && !Number.isInteger(hi)) {
    throw new TypeError(`${who} max must be an integer, got ${hi}`);
  }
  if (lo !== undefined && hi !== undefined) {
    if (lo > hi) {
      throw new RangeError(`${who} range is empty: min ${show(lo)} exceeds max ${show(hi)}`);
    }
    if (hi - lo > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`${who} range [${show(lo)}, ${show(hi)}] spans more than 2^53 values`);
    }
  }
}

/**
 * Refuses an index that is not an integer within `[lo, hi]`, either bound
 * optional. `subject` names the value in an error, as in `Value 3`.
 */
export function checkIndex(
  index: number,
  lo: number | undefined,
  hi: number | undefined,
  subject: () => string,
  show: (index: number) => string = String
): void {
  if (!Number.isInteger(index)) {
    throw new TypeError(`${subject()} is not an integer`);
  }
  if (lo !== undefined && index < lo) {
    throw new RangeError(`${subject()} is below the minimum ${show(lo)}`);
  }
  if (hi !== undefined && index > hi) {
    throw new RangeError(`${subject()} is above the maximum ${show(hi)}`);
  }
}

/**
 * The range a prior spreads over: a checked range whose bounds, and the
 * `hi + 1` every CDF is read at, are exact integers.
 */
function checkPriorRange(
  who: string,
  kind: 'cdf' | 'weights',
  lo: number,
  hi: number,
  show: (index: number) => string
): void {
  checkRange(who, lo, hi, show);
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) {
    throw new RangeError(
      `${who} ${kind} requires bounds within ±${Number.MAX_SAFE_INTEGER}, got [${show(lo)}, ${show(hi)}]`
    );
  }
}

/**
 * Eager sanity of a CDF over `[lo, hi]`. Only relative masses matter, so the
 * function is rebased to zero at the lower bound — constant offsets are
 * harmless. Returns the rebased cdf and the range's total mass.
 */
export function validateCdf(
  cdf: Cdf,
  lo: number,
  hi: number,
  who: string,
  show: (index: number) => string = String
): { cdf: Cdf; total: number } {
  checkPriorRange(who, 'cdf', lo, hi, show);
  const base = cdf(lo);
  if (!Number.isSafeInteger(base)) {
    throw new TypeError(`${who} cdf must return safe integers, got ${base} at ${lo}`);
  }
  const end = cdf(hi + 1);
  if (!Number.isSafeInteger(end)) {
    throw new TypeError(`${who} cdf must return safe integers, got ${end} at ${hi + 1}`);
  }
  const total = end - base;
  if (total < 1) {
    throw new TypeError(`${who} cdf must put positive weight on the range, got ${total}`);
  }
  return { cdf: base === 0 ? cdf : (v) => cdf(v) - base, total };
}

/** A node's prior as declared: an integer CDF or a weight per value. */
export type Prior = Cdf | readonly number[];

export const priorKind = (prior: Prior): 'cdf' | 'weights' =>
  typeof prior === 'function' ? 'cdf' : 'weights';

/**
 * A prior resolved over `[lo, hi]`: each value in the range writes and reads
 * as one weighted symbol. `declared` is the prior as given, kept so a later
 * bound change re-validates it. `show` spells a value in an error.
 */
export class RangePrior {
  readonly declared: Prior;
  /** Rebased to 0 at `lo`; read only at integers in `[lo, hi + 1]`. */
  private readonly cdf: Cdf;
  /** cdf(hi + 1), the weight of the whole range. */
  private readonly total: number;
  private readonly lo: number;
  private readonly hi: number;
  private readonly who: string;
  private readonly show: (index: number) => string;
  /**
   * Bucket lookup for `parseWeighted`, which passes a residual in
   * `[0, total)`: the largest v in `[lo, hi]` with `cdf(v) <= residual`.
   * Zero-weight plateaus resolve past themselves, so unencodable values stay
   * unreachable.
   */
  private readonly locate: (residual: number) => Bucket;

  constructor(
    declared: Prior,
    lo: number,
    hi: number,
    who: string,
    show: (index: number) => string = String
  ) {
    let cdf: Cdf;
    let total: number;
    if (typeof declared === 'function') {
      ({ cdf, total } = validateCdf(declared, lo, hi, who, show));
    } else {
      checkPriorRange(who, 'weights', lo, hi, show);
      // A weight list is a CDF read off its running totals.
      const table = buildWeights(declared, hi - lo + 1, who);
      cdf = (v) => (v > hi ? table.total : table.cums[v - lo]);
      total = table.total;
    }
    this.declared = declared;
    this.cdf = cdf;
    this.total = total;
    this.lo = lo;
    this.hi = hi;
    this.who = who;
    this.show = show;
    this.locate = (residual) => {
      const v = this.bisect((mid) => cdf(mid) <= residual);
      return [v, cdf(v), cdf(v + 1) - cdf(v)];
    };
  }

  /** `subject` names the value in an error, as in `Value 3`. */
  write(enc: Encoder, v: number, subject: () => string): void {
    checkIndex(v, this.lo, this.hi, subject, this.show);
    const [cum, freq] = this.bucket(v, subject);
    enc.composeWeighted(cum, freq, this.total);
  }

  read(dec: Decoder): number {
    return dec.parseWeighted(this.total, this.locate);
  }

  /**
   * The bucket of `v`, an integer in `[lo, hi]`, validated for the encode
   * side: a user CDF is checked where it is read.
   */
  private bucket(v: number, subject: () => string): readonly [number, number] {
    const cum = this.cdf(v);
    const freq = this.cdf(v + 1) - cum;
    if (!Number.isSafeInteger(cum) || !Number.isSafeInteger(freq) || cum < 0 || freq < 0) {
      throw new TypeError(
        `${this.who} cdf must be a non-decreasing integer function, fails at ${v}`
      );
    }
    if (freq === 0) {
      throw new RangeError(`${subject()} has zero weight under the declared cdf`);
    }
    // The decoder reaches v by bisecting on `cdf(mid) <= residual`, which
    // only works where the cdf is non-decreasing along the probes it makes.
    // Walking those same probes for both end residuals of the bucket proves
    // that the whole bucket decodes to v: each probe's verdict is monotone in
    // the residual, so a verdict shared by both ends is shared in between. A
    // descent the probes never cross cannot affect v.
    const last = cum + freq - 1;
    this.bisect((mid) => {
      if (v >= mid) {
        if (!(this.cdf(mid) <= cum)) {
          throw this.descent(mid, v);
        }
        return true;
      }
      if (this.cdf(mid) <= last) {
        throw this.descent(v + 1, mid);
      }
      return false;
    });
    return [cum, freq];
  }

  /**
   * The binary search `parseWeighted` resolves a residual with, shared with
   * the encode side so both walk the same probes: the largest v in `[lo, hi]`
   * where `right(mid)` has held for every probe below it.
   */
  private bisect(right: (mid: number) => boolean): number {
    let min = this.lo;
    let max = this.hi;
    while (min < max) {
      const mid = min + Math.ceil((max - min) / 2);
      if (right(mid)) min = mid;
      else max = mid - 1;
    }
    return min;
  }

  private descent(from: number, to: number): TypeError {
    return new TypeError(
      `${this.who} cdf must be a non-decreasing integer function, fails between ${from} and ${to}`
    );
  }
}
