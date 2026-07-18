/**
 * Shared validation and bucket arithmetic for user-declared weights: a prior
 * over a node's states, spent exactly through the weighted packer. Integer
 * weights only — both sides must derive bit-identical tables, and floats
 * normalize differently across platforms.
 */

import { isArray } from './guards';

export interface WeightTable {
  readonly cums: readonly number[];
  readonly freqs: readonly number[];
  readonly total: number;
}

export function buildWeights(weights: readonly number[], states: number, who: string): WeightTable {
  if (!isArray(weights) || weights.length !== states) {
    throw new TypeError(`${who} weights must list one weight per value`);
  }
  const cums: number[] = [];
  let total = 0;
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 1) {
      throw new TypeError(`${who} weights must be positive integers`);
    }
    cums.push(total);
    total += w;
  }
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`${who} weights must sum to a safe integer`);
  }
  return { cums, freqs: [...weights], total };
}

/** Bucket lookup for `parseWeighted`: the index owning the residual. */
export const locateWeighted =
  (table: WeightTable) =>
  (residual: number): readonly [number, number, number] => {
    let lo = 0;
    let hi = table.cums.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (table.cums[mid] <= residual) lo = mid;
      else hi = mid - 1;
    }
    return [lo, table.cums[lo], table.freqs[lo]];
  };

/**
 * An integer CDF over an indexed range: `cdf(v)` is the cumulative weight of
 * all values below `v`, so a value's own weight is `cdf(v + 1) - cdf(v)`.
 * The function is part of the wire format, and both sides must compute
 * bit-identical values — stick to BigInt or the correctly-rounded float ops
 * (`+ - * /`, `Math.sqrt`); `Math.exp` and friends vary across engines.
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
  if (typeof cdf !== 'function') {
    throw new TypeError(`${who} cdf must be a function`);
  }
  const base = cdf(lo);
  if (!Number.isSafeInteger(base)) {
    throw new TypeError(`${who} cdf must return safe integers`);
  }
  const total = cdf(hi + 1) - base;
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new TypeError(`${who} cdf must put positive weight on the range`);
  }
  return { cdf: base === 0 ? cdf : (v) => cdf(v) - base, total };
}

/** The bucket of one value under a CDF, validated for the encode side. */
export function cdfBucket(cdf: Cdf, v: number, who: string): readonly [number, number] {
  const cum = cdf(v);
  const freq = cdf(v + 1) - cum;
  if (!Number.isSafeInteger(cum) || !Number.isSafeInteger(freq) || cum < 0 || freq < 0) {
    throw new TypeError(`${who} cdf must be a non-decreasing integer function`);
  }
  if (freq === 0) {
    throw new RangeError(`Value '${v}' has zero weight under the declared cdf`);
  }
  return [cum, freq];
}

/**
 * Bucket lookup under a CDF: the largest v in `[lo, hi]` with
 * `cdf(v) <= residual`. Zero-weight plateaus resolve past themselves, so
 * unencodable values stay unreachable.
 */
export const locateCdf =
  (cdf: Cdf, lo: number, hi: number) =>
  (residual: number): readonly [number, number, number] => {
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      if (cdf(mid) <= residual) lo = mid;
      else hi = mid - 1;
    }
    return [lo, cdf(lo), cdf(lo + 1) - cdf(lo)];
  };
