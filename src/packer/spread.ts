/**
 * The small-state map of a weighted symbol, which needs nothing beyond the
 * symbol's own bucket.
 *
 * Folding a symbol that owns `[cum, cum + freq)` of `total` states onto a
 * state y below `freq` cannot take the bucket step, whose image for
 * y ≥ freq is [total, ∞). The `total` pairs (symbol, y) map onto [0, total)
 * instead. The plain map cum + y would cost log2(cum + y + 1) bits whatever
 * the symbol's weight. Here the residuals [0, total) are visited in
 * bit-reversed (van der Corput) order, skipping those at or past `total`,
 * and the pair (symbol, y) goes to the position of the y-th visit that lands
 * inside the symbol's bucket. A low-discrepancy order lands in a bucket of
 * width `freq` about once every total/freq visits, so the pair costs about
 * log2((y + 1)·total/freq) bits.
 *
 * Every count is of residuals below `total`, under 2^53, so plain doubles
 * hold them exactly.
 */

/** Bits that cover the residuals below `total`, which is at least 2. */
function bitsFor(total: number): number {
  let bits = 1;
  while (2 ** bits < total) {
    bits++;
  }
  return bits;
}

/** The `bits`-bit reversal of `n`, which lies in [0, 2^bits). */
function reverse(n: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) {
    const bit = n % 2;
    n = (n - bit) / 2;
    r = r * 2 + bit;
  }
  return r;
}

/**
 * How many n in [0, end) have a `bits`-bit reversal below `limit`, for `end`
 * in [0, 2^bits). A digit walk over n from its top bit, which is the
 * reversal's lowest: `tight` counts the prefixes still equal to `end`'s,
 * `free` those already below it, each split by how the reversal's bits so
 * far compare with `limit`'s matching low bits (below, equal, above). The
 * reversal is below `limit` when its top bits, read last, decide so, or when
 * they tie and the lower ones already did.
 */
function visitsBelow(end: number, limit: number, bits: number): number {
  if (limit >= 2 ** bits) {
    return end;
  }
  let [tightLt, tightEq, tightGt] = [0, 1, 0];
  let [freeLt, freeEq, freeGt] = [0, 0, 0];
  const endBits: number[] = [];
  const limitBits: number[] = [];
  for (let i = 0; i < bits; i++) {
    const e = end % 2;
    const l = limit % 2;
    endBits.push(e);
    limitBits.push(l);
    end = (end - e) / 2;
    limit = (limit - l) / 2;
  }
  // Bit i of n is bit bits-1-i of its reversal, compared with the same bit of `limit`.
  for (let i = bits - 1; i >= 0; i--) {
    const limitBit = limitBits[bits - 1 - i];
    const free = freeLt + freeEq + freeGt;
    const tight = tightLt + tightEq + tightGt;
    let lt: number;
    let eq: number;
    let gt: number;
    // A free prefix takes either bit. Under a 0 of `limit`, a 1 makes the
    // reversal greater; under a 1, a 0 makes it smaller; the other bit
    // keeps the comparison.
    if (limitBit === 0) {
      [lt, eq, gt] = [freeLt, freeEq, freeGt + free];
    } else {
      [lt, eq, gt] = [freeLt + free, freeEq, freeGt];
    }
    // A tight prefix under a 1 of `end` takes a 0 and turns free, or a 1
    // and stays tight; under a 0 of `end` it takes a 0 and stays tight.
    if (endBits[i] === 1) {
      if (limitBit === 0) {
        [lt, eq, gt] = [lt + tightLt, eq + tightEq, gt + tightGt];
        [tightLt, tightEq, tightGt] = [0, 0, tight];
      } else {
        lt += tight;
      }
    } else if (limitBit === 1) {
      [tightLt, tightEq, tightGt] = [tight, 0, 0];
    }
    [freeLt, freeEq, freeGt] = [lt, eq, gt];
  }
  return freeLt;
}

/**
 * The smallest n in [lo, hi] with `count(n)` at least `target`, `count`
 * non-decreasing and reaching it by `hi`, which is at most 2^53. The
 * midpoint is taken from the gap, as lo + hi can pass 2^53 and round.
 */
function firstReaching(
  lo: number,
  hi: number,
  target: number,
  count: (n: number) => number
): number {
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (count(mid) >= target) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/**
 * The state the pair (symbol, `y`) folds to, in [0, `total`): the position
 * of the y-th visit inside `[cum, cum + freq)`, with `y` below `freq` and
 * the bucket inside [0, total).
 */
export function spreadOf(cum: number, freq: number, total: number, y: number): number {
  const bits = bitsFor(total);
  const visit =
    firstReaching(
      0,
      2 ** bits,
      y + 1,
      (n) => visitsBelow(n, cum + freq, bits) - visitsBelow(n, cum, bits)
    ) - 1;
  return visitsBelow(visit, total, bits);
}

/**
 * The residual a small `state` in [0, `total`) visits, for the decoder to
 * locate; `visit` goes back into `rankOf` with the bucket found.
 */
export function residualAt(state: number, total: number): { residual: number; visit: number } {
  const bits = bitsFor(total);
  const visit = firstReaching(0, 2 ** bits, state + 1, (n) => visitsBelow(n, total, bits)) - 1;
  return { residual: reverse(visit, bits), visit };
}

/**
 * The y that `spreadOf` was given for the pair whose `visit` landed in
 * `[cum, cum + freq)`: how many visits before it land there too.
 */
export function rankOf(visit: number, cum: number, freq: number, total: number): number {
  const bits = bitsFor(total);
  return visitsBelow(visit, cum + freq, bits) - visitsBelow(visit, cum, bits);
}
