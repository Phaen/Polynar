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
  /** Direct lookup for `parseWeighted`: the bucket of the i-th index. */
  readonly atIndex: (i: number) => Bucket;
}

export function buildWeights(weights: readonly number[], states: number, who: string): WeightTable {
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
  const atIndex = (i: number): Bucket => [i, cums[i], freqs[i]];
  return { cums, freqs, total, locate, atIndex };
}

/** Write the `pos`-th entry of a weight table as one weighted symbol. */
export function writeTable(enc: Encoder, table: WeightTable, pos: number): void {
  enc.composeWeighted(table.cums[pos], table.freqs[pos], table.total, pos, table.cums.length);
}

/** Read one weighted symbol written by `writeTable`: the entry's position. */
export function readTable(dec: Decoder, table: WeightTable): number {
  return dec.parseWeighted(table.total, table.locate, table.cums.length, table.atIndex);
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
 * Eager sanity of a CDF over `[lo, hi]`. Only relative masses matter, so the
 * function is rebased to zero at the lower bound — constant offsets are
 * harmless. Returns the rebased cdf and the range's total mass.
 */
export function validateCdf(
  cdf: Cdf,
  lo: number,
  hi: number,
  who: string
): { cdf: Cdf; total: number } {
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

/** A prior over `[lo, hi]` as a validated, rebased CDF and its total mass. */
function resolvePrior(
  prior: Prior,
  lo: number,
  hi: number,
  who: string
): { cdf: Cdf; total: number } {
  if (typeof prior === 'function') {
    return validateCdf(prior, lo, hi, who);
  }
  // A weight list is a CDF read off its running totals.
  const { cums, total } = buildWeights(prior, hi - lo + 1, who);
  return { cdf: (v) => (v > hi ? total : cums[v - lo]), total };
}

/**
 * The bucket of one value under a CDF, validated for the encode side.
 * `subject` names the value in an error, as in `Value '3'`.
 */
function cdfBucket(
  cdf: Cdf,
  v: number,
  who: string,
  subject: () => string
): readonly [number, number] {
  const cum = cdf(v);
  const freq = cdf(v + 1) - cum;
  if (!Number.isSafeInteger(cum) || !Number.isSafeInteger(freq) || cum < 0 || freq < 0) {
    throw new TypeError(`${who} cdf must be a non-decreasing integer function, fails at ${v}`);
  }
  if (freq === 0) {
    throw new RangeError(`${subject()} has zero weight under the declared cdf`);
  }
  return [cum, freq];
}

/** Direct lookup under a CDF: the bucket of the i-th value from `lo`. */
const atIndexCdf =
  (cdf: Cdf, lo: number) =>
  (i: number): readonly [number, number, number] => [
    lo + i,
    cdf(lo + i),
    cdf(lo + i + 1) - cdf(lo + i),
  ];

/**
 * Bucket lookup under a CDF: the largest v in `[lo, hi]` with
 * `cdf(v) <= residual`. Zero-weight plateaus resolve past themselves, so
 * unencodable values stay unreachable.
 */
const locateCdf =
  (cdf: Cdf, min: number, max: number) =>
  (residual: number): readonly [number, number, number] => {
    let lo = min;
    let hi = max;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      if (cdf(mid) <= residual) lo = mid;
      else hi = mid - 1;
    }
    return [lo, cdf(lo), cdf(lo + 1) - cdf(lo)];
  };

/**
 * A prior resolved over `[lo, hi]`: each value in the range writes and reads
 * as one weighted symbol. `declared` is the prior as given, kept so a later
 * bound change re-validates it.
 */
export class RangePrior {
  readonly declared: Prior;
  private readonly cdf: Cdf;
  /** cdf(hi + 1), the weight of the whole range. */
  private readonly total: number;
  private readonly lo: number;
  private readonly hi: number;
  private readonly who: string;
  private readonly locate: (residual: number) => Bucket;
  private readonly atIndex: (i: number) => Bucket;

  constructor(declared: Prior, lo: number, hi: number, who: string) {
    const { cdf, total } = resolvePrior(declared, lo, hi, who);
    this.declared = declared;
    this.cdf = cdf;
    this.total = total;
    this.lo = lo;
    this.hi = hi;
    this.who = who;
    this.locate = locateCdf(cdf, lo, hi);
    this.atIndex = atIndexCdf(cdf, lo);
  }

  /** `subject` names the value in an error, as in `Value '3'`. */
  write(enc: Encoder, v: number, subject: () => string): void {
    const [cum, freq] = cdfBucket(this.cdf, v, this.who, subject);
    enc.composeWeighted(cum, freq, this.total, v - this.lo, this.hi - this.lo + 1);
  }

  read(dec: Decoder): number {
    return dec.parseWeighted(this.total, this.locate, this.hi - this.lo + 1, this.atIndex);
  }
}
