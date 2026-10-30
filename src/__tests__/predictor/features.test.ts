import { ONE, log2Fix } from '../../predictor/arith';
import {
  FROZEN_REC,
  anchorDepth,
  decayedMean,
  detBucket,
  dist,
  featureVector,
  levBucket,
  longBucket,
  lognTerm,
  shadowCost,
  shadowCostOf,
  valueAdvance,
  valueFeatures,
  valueState,
} from '../../predictor/features';
import type { ValueState } from '../../predictor/features';
import { Entries } from '../../predictor/tables';

/** Loads `counts` as the followers 300.. of entry `x`. */
function fill(tab: Entries, x: number, counts: readonly number[]): void {
  counts.forEach((c, i) => {
    if (c > 0) tab.load(x, 300 + i, c);
  });
}

/** A table with `counts` in entry 0 or, for a level entry, in a hashed entry beside it. */
function entryOf(counts: readonly number[], order0 = false): { tab: Entries; x: number } {
  const tab = new Entries(1);
  const x = order0 ? 0 : tab.make(1, 1);
  fill(tab, x, counts);
  return { tab, x };
}

describe('buckets', () => {
  it('puts frozen votes past every recency bucket', () => {
    expect(FROZEN_REC).toBe(5);
  });

  it('dist buckets distinct followers', () => {
    expect(dist(entryOf([]).tab.n[1])).toBe(0);
    expect(dist(entryOf([3]).tab.n[1])).toBe(0);
    expect(dist(entryOf([1, 1]).tab.n[1])).toBe(1);
    expect(dist(entryOf([1, 1, 1]).tab.n[1])).toBe(1);
    expect(dist(entryOf([1, 1, 1, 1]).tab.n[1])).toBe(2);
  });

  it('detBucket buckets distinct ring symbols', () => {
    expect([0, 1, 2, 3, 4, 8, 9, 64].map(detBucket)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('anchorDepth finds the deepest boundary crossed', () => {
    expect(anchorDepth(2, 3, 5, 9, true)).toBe(0);
    expect(anchorDepth(3, 3, 5, 9, true)).toBe(0);
    expect(anchorDepth(4, 3, 5, 9, true)).toBe(1);
    expect(anchorDepth(6, 3, 5, 9, true)).toBe(2);
    expect(anchorDepth(10, 3, 5, 9, true)).toBe(3);
    expect(anchorDepth(64, 3, 5, Infinity, true)).toBe(2);
    expect(anchorDepth(3, 3, 5, 9, false)).toBe(0);
    expect(anchorDepth(10, 3, 5, 9, false)).toBe(1);
  });

  it('longBucket buckets agreement beyond the order', () => {
    const L = [9, 12, 13, 24, 25, 48, 49, 64];
    expect(L.map((x) => longBucket(x, 8))).toEqual([9, 9, 10, 10, 11, 11, 12, 12]);
    expect(longBucket(3, 2)).toBe(3);
  });

  it('levBucket splits at −1, −¼, ¼ and 1 bits', () => {
    const Q = ONE / 4;
    const scores = [-ONE - 1, -ONE, -Q - 1, -Q, 0, Q, Q + 1, ONE, ONE + 1];
    expect(scores.map(levBucket)).toEqual([0, 1, 1, 2, 2, 2, 3, 3, 4]);
  });
});

describe('featureVector', () => {
  it('writes the six features in RB units', () => {
    const out = new Float64Array(6);
    expect(Array.from(featureVector(out, 3, false, 2, 1, 1))).toEqual([
      ONE,
      3 * ONE,
      0,
      2 * ONE,
      ONE,
      ONE,
    ]);
    expect(Array.from(featureVector(out, FROZEN_REC, true, 0, 0, 2))).toEqual([
      ONE,
      0,
      ONE,
      0,
      0,
      2 * ONE,
    ]);
  });
});

describe('lognTerm', () => {
  it('scales the slope by log2 of the sample count, capped at 16', () => {
    expect(lognTerm(ONE, 8)).toBe(3 * ONE);
    expect(lognTerm(-ONE, 8)).toBe(-3 * ONE);
    expect(lognTerm(ONE, 1)).toBe(0);
    expect(lognTerm(ONE, 0)).toBe(0);
    expect(lognTerm(-ONE, 0)).toBe(0);
    expect(lognTerm(ONE, 2 ** 20)).toBe(16 * ONE);
    expect(lognTerm(-ONE / 2, 2 ** 40)).toBe(-8 * ONE);
    const l3 = log2Fix(3);
    expect(lognTerm(ONE / 2, 3)).toBe(Math.floor(l3 / 2));
    expect(lognTerm(-ONE / 2, 3)).toBe(-Math.floor(l3 / 2));
    const err = lognTerm(ONE / 8, 1000) / ONE - Math.log2(1000) / 8;
    expect(Math.abs(err)).toBeLessThan(2 ** -10);
  });
});

describe('value features', () => {
  function run(P: ValueState, vid: number, syms: readonly number[]): number[][] {
    const out: number[][] = [];
    syms.forEach((a, off) => {
      out.push(Array.from(valueFeatures(P, off, vid)));
      valueAdvance(P, a, off);
    });
    return out;
  }

  it('follows a scripted history with a window of 3', () => {
    const P = valueState(3);
    expect(Array.from(valueFeatures(P, 0, -1))).toEqual([0, 0, 0, 0, 0]);
    expect(run(P, 0, [1, 2])).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(run(P, 1, [1, 2])).toEqual([
      [1, 1, 0, 0, 0],
      [1, 1, 2, 0, 0],
    ]);
    expect(P.reps).toBe(0);
    expect(run(P, 2, [1, 3, 4])).toEqual([
      [1, 2, 0, 1, 2],
      [1, 2, 2, 1, 2],
      [0, 0, 3, 1, 2],
    ]);
    expect(P.reps).toBe(1);
    expect(run(P, 3, [5])).toEqual([[1, 2, 0, 0, 2]]);
    expect(Array.from(valueFeatures(P, 3, 3))).toEqual([0, 0, 4, 0, 2]);
    expect(P.vals).toEqual([
      [1, 2],
      [1, 2],
      [1, 3, 4],
    ]);
    // [1, 2] leaves the window: it was no repeat.
    expect(run(P, 4, [1, 2])).toEqual([
      [1, 2, 0, 0, 2],
      [1, 2, 2, 0, 2],
    ]);
    expect(P.match).toEqual([0]);
    expect(P.reps).toBe(1);
    expect(P.repFlags).toEqual([true, false, false]);
    // A repeat enters while the repeat [1, 2] leaves.
    run(P, 5, [9]);
    expect(P.repFlags).toEqual([false, false, true]);
    expect(P.reps).toBe(1);
    run(P, 6, [8]);
    run(P, 7, [7]);
    expect(P.reps).toBe(1);
    // The last repeat leaves with its flag.
    expect(run(P, 8, [6])).toEqual([[1, 2, 0, 1, 0]]);
    expect(P.reps).toBe(0);
    expect(P.vals).toEqual([[9], [8], [7]]);
  });

  it('closes a value at a structure symbol', () => {
    const P = valueState(8);
    run(P, 0, [1]);
    expect(Array.from(valueFeatures(P, 0, -1))).toEqual([0, 0, 0, 0, 0]);
    expect(P.vid).toBe(-1);
    expect(P.vals).toEqual([[1]]);
    valueAdvance(P, 4, 0);
    expect(P.cur).toEqual([]);
    expect(run(P, 1, [1])).toEqual([[1, 1, 0, 0, 0]]);
  });

  it('buckets progress and the repeat rate', () => {
    const P = valueState(64);
    run(P, 0, [1, 1, 1, 1]);
    run(P, 1, [1, 1, 1, 1]);
    expect(run(P, 2, [1, 1, 1, 1, 1])).toEqual([
      [1, 2, 0, 1, 2],
      [1, 2, 1, 1, 2],
      [1, 2, 2, 1, 2],
      [1, 2, 3, 1, 2],
      [1, 2, 3, 1, 2],
    ]);
    expect(P.match).toEqual([]);
    expect(Array.from(valueFeatures(P, 5, 2))).toEqual([0, 0, 4, 1, 2]);
    const Q = valueState(64);
    for (const [vid, s] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 1],
    ]) {
      run(Q, vid, [s]);
    }
    expect(run(Q, 5, [6])).toEqual([[1, 3, 0, 1, 1]]);
    const R = valueState(64);
    for (let vid = 0; vid < 4; vid++) run(R, vid, [1]);
    expect(run(R, 4, [1])).toEqual([[1, 3, 0, 1, 3]]);
  });
});

describe('level evidence', () => {
  function floating(c0: number, d: number, c: number, total: number): number {
    const p0 = (c0 + 1) / d;
    return Math.log2(p0) - Math.log2((c + p0) / (total + 1));
  }

  it('shadowCost matches the floating cost within 2^−10 bits', () => {
    let s = 12345;
    const next = (n: number): number => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s % n;
    };
    for (let i = 0; i < 500; i++) {
      const tab = new Entries(1);
      fill(tab, 0, [1 + next(50), next(30), 1 + next(400), next(3)]);
      const x = tab.make(1, 1);
      fill(tab, x, [next(40), next(5), next(9)]);
      for (let a = 300; a < 305; a++) {
        const c0 = tab.count(0, a);
        const d = tab.total[0] + tab.n[0] + 1;
        const want = floating(c0, d, tab.count(x, a), tab.total[x]);
        expect(Math.abs(shadowCost(tab, x, a) / ONE - want)).toBeLessThan(2 ** -10);
      }
    }
  });

  it('shadowCostOf takes ring counts and stays exact-enough on huge totals', () => {
    const { tab } = entryOf([5, 3], true);
    const d = tab.total[0] + tab.n[0] + 1;
    const ring = shadowCostOf(tab, 300, 4, 6) / ONE;
    expect(Math.abs(ring - floating(5, d, 4, 6))).toBeLessThan(2 ** -10);
    expect(shadowCostOf(tab, 300, 0, 0)).toBe(0);
    const big = entryOf([2 ** 20, 7], true);
    big.tab.total[0] = 2 ** 40;
    const D = big.tab.total[0] + big.tab.n[0] + 1;
    for (const [c, total] of [
      [2 ** 20, 2 ** 30],
      [0, 2 ** 30],
      [2 ** 29, 2 ** 30],
    ]) {
      for (const a of [300, 301, 302]) {
        const want = floating(big.tab.count(0, a), D, c, total);
        expect(Math.abs(shadowCostOf(big.tab, a, c, total) / ONE - want)).toBeLessThan(2 ** -10);
      }
    }
  });

  it('decayedMean moves 1/256 of the way', () => {
    expect(decayedMean(0, 256 * ONE)).toBe(ONE);
    expect(decayedMean(256, 0)).toBe(255);
    expect(decayedMean(-256, 0)).toBe(-255);
    expect(decayedMean(0, -1)).toBe(-1);
    let m = 0;
    for (let i = 0; i < 4096; i++) m = decayedMean(m, -ONE);
    expect(Math.abs(m / ONE + 1)).toBeLessThan(2 ** -10);
  });
});
