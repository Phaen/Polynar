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
  /** Member count and direct lookup for `parseWeighted`: the bucket of the i-th index. */
  readonly position: { readonly count: number; readonly at: (i: number) => Bucket };
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
  // The bucket holding `residual`, for a residual in [0, total) as
  // `parseWeighted` passes; one below 0, or NaN, lands in the first bucket and
  // one at or past `total` in the last.
  const locate = (residual: number): Bucket => {
    let lo = 0;
    let hi = cums.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cums[mid] <= residual) lo = mid;
      else hi = mid - 1;
    }
    return [lo, cums[lo], freqs[lo]];
  };
  // An index that names no entry owns no weight: an empty bucket at the end.
  const at = (i: number): Bucket => [i, cums[i] ?? total, freqs[i] ?? 0];
  return { cums, freqs, total, locate, position: { count: cums.length, at } };
}

/** Write the `pos`-th entry of a weight table as one weighted symbol. */
export function writeTable(enc: Encoder, table: WeightTable, pos: number): void {
  if (table.freqs[pos] === undefined) {
    throw new RangeError(`Position ${pos} is not one of the table's ${table.freqs.length} entries`);
  }
  enc.composeWeighted(table.cums[pos], table.freqs[pos], table.total, {
    index: pos,
    count: table.cums.length,
  });
}

/** Read one weighted symbol written by `writeTable`: the entry's position. */
export function readTable(dec: Decoder, table: WeightTable): number {
  return dec.parseWeighted(table.total, table.locate, table.position);
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
 * bound is an integer, and a pair is non-empty and spans fewer than 2^53
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
    if (hi - lo >= Number.MAX_SAFE_INTEGER) {
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
  /**
   * Direct lookup for `parseWeighted`, which passes an index in
   * `[0, count)`: the bucket of the i-th value from `lo`.
   */
  private readonly position: { readonly count: number; readonly at: (i: number) => Bucket };

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
      let min = lo;
      let max = hi;
      while (min < max) {
        const mid = min + Math.ceil((max - min) / 2);
        if (cdf(mid) <= residual) min = mid;
        else max = mid - 1;
      }
      return [min, cdf(min), cdf(min + 1) - cdf(min)];
    };
    this.position = {
      count: hi - lo + 1,
      at: (i) => [lo + i, cdf(lo + i), cdf(lo + i + 1) - cdf(lo + i)],
    };
  }

  /** `subject` names the value in an error, as in `Value 3`. */
  write(enc: Encoder, v: number, subject: () => string): void {
    checkIndex(v, this.lo, this.hi, subject, this.show);
    const [cum, freq] = this.bucket(v, subject);
    enc.composeWeighted(cum, freq, this.total, {
      index: v - this.lo,
      count: this.hi - this.lo + 1,
    });
  }

  read(dec: Decoder): number {
    return dec.parseWeighted(this.total, this.locate, this.position);
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
    return [cum, freq];
  }
}
