/**
 * Features of a vote and of the current position: the hybrid feature vector
 * `x = [1, rec, frozen, depth, offAg, det]` and its buckets, the log-n slope term, the value
 * features of a path (`vfeat`) and the level evidence (`lev`) scores.
 *
 * Log-domain values are in bits with RB fractional bits (arith.ts).
 */

import { ONE, RB, bitlen, div, log2Fix, mulShr, shr } from './arith';
import type { Entries } from './tables';
import { HF } from './types';

/** The recency bucket of frozen (built-in) votes, which have no position. */
export const FROZEN_REC = 5;

/** The recency bucket of a follower last seen `age` positions ago: 4 bits of age per bucket, 0..4. */
export function recBucket(age: number): number {
  const lg = bitlen(age) - 1;
  return lg >= 16 ? 4 : div(lg, 4);
}

/** The determinism bucket of an entry by its `n` distinct followers: 1 / 2–3 / more. */
export function dist(n: number): number {
  return n <= 1 ? 0 : n <= 3 ? 1 : 2;
}

/** The determinism bucket of a same-offset ring by its distinct symbols: 1 / 2–3 / 4–8 / more. */
export function detBucket(distinct: number): number {
  return distinct <= 1 ? 0 : distinct <= 3 ? 1 : distinct <= 8 ? 2 : 3;
}

/**
 * The deepest boundary an agreement of length `L` reaches back through: none, word (`b` symbols
 * since the last boundary), value (offset `off`), record (`roff`); without depth, anchored or not.
 */
export function anchorDepth(
  L: number,
  b: number,
  off: number,
  roff: number,
  depthOn: boolean
): number {
  if (!depthOn) {
    return L > b ? 1 : 0;
  }
  return L > roff ? 3 : L > off ? 2 : L > b ? 1 : 0;
}

/** The level of a long candidate with agreement `L` beyond `order`: one of four length buckets. */
export function longBucket(L: number, order: number): number {
  return order + 1 + (L <= 12 ? 0 : L <= 24 ? 1 : L <= 48 ? 2 : 3);
}

/**
 * Writes a vote's feature vector in RB units: the constant, the recency bucket (0 for frozen
 * votes), the frozen flag, the boundary depth, the offset agreement and the determinism bucket.
 */
export function featureVector(
  out: Float64Array,
  rec: number,
  frozen: boolean,
  depth: number,
  offAg: number,
  det: number
): Float64Array {
  out[0] = ONE;
  out[1] = frozen ? 0 : rec * ONE;
  out[2] = frozen ? ONE : 0;
  out[3] = depth * ONE;
  out[4] = offAg * ONE;
  out[5] = det * ONE;
  return out;
}

/**
 * Feature cells: every (rec, frozen, depth, offAg, det) a vote can take, as one index
 * `((depth · 2 + offAg) · 4 + det) · 6 + recSlot` with `recSlot` the recency bucket, or
 * `FROZEN_REC` for frozen votes. Depth and det are 0..3, rec 0..4.
 */
export const CELLS = 192;

/** The feature cell of a vote. */
export function cellOf(
  rec: number,
  frozen: boolean,
  depth: number,
  offAg: number,
  det: number
): number {
  return ((depth * 2 + offAg) * 4 + det) * 6 + (frozen ? FROZEN_REC : rec);
}

/** Per cell, HF small integers: the feature vector in units of ONE. */
export const CELL_UNITS = new Int32Array(CELLS * HF);
/** Per cell, the feature vector in RB (`featureVector`). */
export const CELL_X = new Float64Array(CELLS * HF);
for (let depth = 0; depth < 4; depth++) {
  for (let offAg = 0; offAg < 2; offAg++) {
    for (let det = 0; det < 4; det++) {
      for (let slot = 0; slot < 6; slot++) {
        const frozen = slot === FROZEN_REC;
        const c = cellOf(slot, frozen, depth, offAg, det);
        featureVector(CELL_X.subarray(c * HF, c * HF + HF), slot, frozen, depth, offAg, det);
        for (let f = 0; f < HF; f++) CELL_UNITS[c * HF + f] = div(CELL_X[c * HF + f], ONE);
      }
    }
  }
}

/** The largest log-n feature: 16 bits. */
const LOGN_MAX = 16 * ONE;

/**
 * The log-n term of a level group with `total` samples: `slope · min(16, log2 total)` in RB,
 * rounded toward zero. The slope's magnitude stays below 2^26.
 */
export function lognTerm(slope: number, total: number): number {
  const l = Math.min(LOGN_MAX, log2Fix(Math.max(total, 1)));
  return slope < 0 ? 0 - mulShr(l, 0 - slope, RB) : mulShr(l, slope, RB);
}

const QUARTER = shr(ONE, 2);

/**
 * The level-evidence bucket of a score (RB bits): helps a lot (< −1), helps (< −¼), neutral
 * (≤ ¼), hurts (≤ 1), hurts a lot.
 */
export function levBucket(score: number): number {
  return score < -ONE ? 0 : score < -QUARTER ? 1 : score <= QUARTER ? 2 : score <= ONE ? 3 : 4;
}

/**
 * A path's value history for the value features: the last `history` values' symbols, whether
 * each repeated an earlier value in the window when it ended, the current value's symbols and
 * the past values that agree with it so far.
 */
export interface ValueState {
  readonly history: number;
  readonly vals: number[][];
  readonly repFlags: boolean[];
  /** The repeats among `vals`. */
  reps: number;
  cur: number[];
  /** The current value's id, −1 outside a value. */
  vid: number;
  /** Indices into `vals` of the past values whose prefix equals `cur`. */
  readonly match: number[];
  /** The median past length (the upper one for an even count), 0 without past values. */
  med: number;
  /** More than one past value and all of one length. */
  sameLen: boolean;
  /** The last features computed. */
  readonly vx: Int32Array;
}

export function valueState(history: number): ValueState {
  return {
    history,
    vals: [],
    repFlags: [],
    reps: 0,
    cur: [],
    vid: -1,
    match: [],
    med: 0,
    sameLen: false,
    vx: new Int32Array(5),
  };
}

function sameValue(u: readonly number[], v: readonly number[]): boolean {
  return u.length === v.length && u.every((y, i) => y === v[i]);
}

/** Moves the current value into the history, dropping the oldest past `history`. */
function closeValue(P: ValueState): void {
  const v = P.cur;
  const rep = P.vals.some((u) => sameValue(u, v));
  P.vals.push(v);
  P.repFlags.push(rep);
  if (rep) {
    P.reps++;
  }
  if (P.vals.length > P.history) {
    P.vals.shift();
    if (P.repFlags.shift()) {
      P.reps--;
    }
  }
}

/** Offset `off` against the median past length `med`: < ¼, < ½, < ¾, ≤ 1, beyond; 0 without one. */
function progress(off: number, med: number): number {
  if (med === 0 || 4 * off < med) {
    return 0;
  }
  if (2 * off < med) {
    return 1;
  }
  if (4 * off < 3 * med) {
    return 2;
  }
  return off <= med ? 3 : 4;
}

/**
 * The five value features of a symbol at offset `off` of value `valueId` (−1 outside a value: all
 * zeros): some past value agrees with the prefix, how many (0 / 1 / 2–3 / more), progress through
 * the median past length (< ¼, < ½, < ¾, ≤ 1, beyond), constant past length, and the repeat rate
 * of past values (0, < ¼, < ¾, more). Returns the state's `vx`, overwritten on the next call.
 */
export function valueFeatures(P: ValueState, off: number, valueId: number): Int32Array {
  const vx = P.vx;
  if (valueId !== P.vid) {
    if (P.vid >= 0) {
      closeValue(P);
    }
    P.vid = valueId;
    P.cur = [];
    P.match.length = 0;
    for (let i = 0; i < P.vals.length; i++) {
      P.match.push(i);
    }
    const lens = Int32Array.from(P.vals, (u) => u.length).sort();
    P.med = lens.length > 0 ? lens[shr(lens.length, 1)] : 0;
    P.sameLen = lens.length > 1 && lens[0] === lens[lens.length - 1];
  }
  if (valueId < 0) {
    vx.fill(0);
    return vx;
  }
  const n = P.match.length;
  const total = P.vals.length;
  const reps = P.reps;
  vx[0] = n > 0 ? 1 : 0;
  vx[1] = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3;
  vx[2] = progress(off, P.med);
  vx[3] = P.sameLen ? 1 : 0;
  vx[4] = reps === 0 ? 0 : 4 * reps < total ? 1 : 4 * reps < 3 * total ? 2 : 3;
  return vx;
}

/** After symbol `a` is coded at offset `off`: keeps the past values that still agree. */
export function valueAdvance(P: ValueState, a: number, off: number): void {
  if (P.vid < 0) {
    return;
  }
  P.cur.push(a);
  const match = P.match;
  let w = 0;
  for (const i of match) {
    if (P.vals[i][off] === a) {
      match[w++] = i;
    }
  }
  match.length = w;
}

/**
 * The shadow cost of a level in RB bits for symbol `a`: log2(p0) − log2(p) with the path's
 * order-0 estimate p0 = (c0 + 1) / D, D = total + n + 1 of entry 0 of `tab`, and the level's estimate
 * p = (c + p0) / (total + 1), where `c` and `total` are the level group's count of `a` and its
 * size (c ≤ total). Negative when the level predicts `a` better. When (total + 1) · D would pass
 * 2^52, D and c0 + 1 are shifted down by the excess first; with c = 0 the cost is then
 * log2(total + 1) directly, as p = p0 / (total + 1).
 */
export function shadowCostOf(tab: Entries, a: number, c: number, total: number): number {
  const c0 = tab.count(0, a);
  const d = tab.total[0] + tab.n[0] + 1;
  const head = log2Fix(c0 + 1) - log2Fix(d);
  const s = bitlen(total + 1) + bitlen(d) - 52;
  if (s <= 0) {
    return head - log2Fix(c * d + c0 + 1) + log2Fix((total + 1) * d);
  }
  if (c === 0) {
    return log2Fix(total + 1);
  }
  const ds = shr(d, s);
  return head - log2Fix(c * ds + shr(c0 + 1, s)) + log2Fix((total + 1) * ds);
}

/** `shadowCostOf` for the level entry `x` of `tab`. */
export function shadowCost(tab: Entries, x: number, a: number): number {
  return shadowCostOf(tab, a, tab.count(x, a), tab.total[x]);
}

/** The level-evidence mean after one more shadow cost: decay 1 − 1/256. */
export function decayedMean(mean: number, shadow: number): number {
  return mean - shr(mean, 8) + shr(shadow, 8);
}
