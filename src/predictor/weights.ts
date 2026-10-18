/**
 * The message's run-time copy of a prior's learned tables, the hybrid exponents, the step's vote
 * log and the learning rule of spec §5.7.
 *
 * Every parameter is an RB fixed-point integer in bits. Updates are additive in the log domain
 * (D4) and rounded to nearest. The learning signal of a hybrid block is the pre-kernel exact-match
 * share: per vote q = A / Sa - T / Z in PB bits (each quotient rounded to nearest), with A the vote's learning mass when it is for the
 * coded symbol (scaled by its fold share) and T its learning mass; the chain rule gives the block
 * gradient G_b[f] = sum of q * x[f] over the block's votes, in PB + RB bits.
 */

import { E_MIN, HB, ONE, PB, POW2, RB, bitlen, clampi, div, mulShr, shl, shr } from './arith';
import { HF, SRC, levels } from './types';
import type { LoadedPrior, PriorConstants, RunPrior } from './types';

const TWO_26 = POW2[26];
const P_ONE = POW2[PB];
/** The confidence maps' probability clamps, 2^PB / 2^14 from either end. */
export const APM_LO = shr(P_ONE, 14);
export const APM_HI = P_ONE - APM_LO;

/** A fresh mutable copy of a loaded prior's learned tables for one message. */
export function newRunPrior(loaded: LoadedPrior): RunPrior {
  return {
    loaded,
    escape: loaded.escape,
    kernel: loaded.kernel.slice(),
    hybrid: loaded.hybrid.slice(),
    apm: loaded.apm.slice(),
    pnov: loaded.pnov.slice(),
    vfeat: loaded.vfeat.slice(),
    oscale: loaded.oscale.slice(),
    lev: loaded.lev.slice(),
    logn: loaded.logn.slice(),
    vstep: loaded.vstep.slice(),
  };
}

/**
 * a * b / 2^k rounded to nearest with ties away from zero, so that it is odd in each argument.
 * Domain: |a|, |b| < 2^52 with the smaller below 2^26, or with k <= 26 (the larger factor is then
 * split at 2^k); the result below 2^52.
 */
export function smul(a: number, b: number, k: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  const neg = a < 0 !== b < 0;
  let big = a < 0 ? -a : a;
  let small = b < 0 ? -b : b;
  if (small > big) {
    const t = big;
    big = small;
    small = t;
  }
  let r: number;
  if (k === 0) {
    r = big * small;
  } else if (small < TWO_26) {
    r = shr(mulShr(big, small, k - 1) + 1, 1);
  } else {
    if (k > 26) {
      throw new RangeError(`smul: both factors reach 2^26 with k = ${k}`);
    }
    const hi = shr(small, k);
    const lo = small - hi * POW2[k];
    r = big * hi + shr(mulShr(big, lo, k - 1) + 1, 1);
  }
  return neg ? 0 - r : r;
}

/** a / b truncated toward zero, for |a| < 2^53 and 0 < b. */
export function sdiv(a: number, b: number): number {
  return a < 0 ? 0 - div(0 - a, b) : div(a, b);
}

/** The hybrid block of a source at a level (0..order exact, order + 1..order + 4 long). */
export function blockOf(src: number, level: number, order: number): number {
  return src * levels(order) + level;
}

/** A path's sparse per-block deltas over the hybrid parameters (HF per block). */
export type PathDeltas = Map<number, Float64Array>;

/** The path's delta of a block, if the path has learned one. */
export function deltaOf(deltas: PathDeltas, block: number): Float64Array | undefined {
  return deltas.get(block);
}

/** theta_b . x (+ delta_b . x) in RB bits; x holds HF features in RB, all non-negative. */
export function exponent(
  run: RunPrior,
  block: number,
  x: ArrayLike<number>,
  delta?: Float64Array
): number {
  const h = run.hybrid;
  const o = block * HF;
  let e = 0;
  for (let f = 0; f < HF; f++) {
    const xf = x[f];
    if (xf !== 0) {
      e += smul(h[o + f], xf, RB);
      if (delta) {
        e += smul(delta[f], xf, RB);
      }
    }
  }
  return e;
}

function grownInt(a: Int32Array, cap: number): Int32Array {
  const b = new Int32Array(cap);
  b.set(a);
  return b;
}

function grownFloat(a: Float64Array, cap: number): Float64Array {
  const b = new Float64Array(cap);
  b.set(a);
  return b;
}

/**
 * One step's votes, written by the vote pass and read by `learn`. The arrays are kept across steps
 * and grow by doubling; `reset(capacity)` reserves a step's worth before the pass.
 */
export class VoteLog {
  n = 0;
  block: Int32Array = new Int32Array(0);
  /** HF features per vote, RB. */
  x: Float64Array = new Float64Array(0);
  sym: Int32Array = new Int32Array(0);
  /** The exact-level count. */
  count: Float64Array = new Float64Array(0);
  eLearn: Float64Array = new Float64Array(0);
  eCode: Float64Array = new Float64Array(0);
  /** The fold share credited to the coded symbol, PB; 2^PB when the vote is not split. */
  share16: Float64Array = new Float64Array(0);
  src: Int32Array = new Int32Array(0);
  level: Int32Array = new Int32Array(0);
  levIndex: Int32Array = new Int32Array(0);
  lognIndex: Int32Array = new Int32Array(0);
  /** min(16, log2 total) of the vote's context entry, RB. */
  lognL: Float64Array = new Float64Array(0);
  /** 1 when the vote counts toward the value-feature gradient. */
  tau: Uint8Array = new Uint8Array(0);
  /** Pass B's masses at the step's block scale; the learning mass excludes the fold share. */
  massLearn: Float64Array = new Float64Array(0);
  massCode: Float64Array = new Float64Array(0);
  prev: Int32Array = new Int32Array(0);

  /** The coded symbol as the folded populations (msgF, nodeF) see it; -1 when it equals the symbol. */
  af = -1;
  eEsc = 0;
  massEsc = 0;
  novel = false;
  pnovIndex = -1;
  oscaleEscIndex = -1;
  /** The path's value features this step (small integers). */
  readonly vx = new Float64Array(5);
  /** The kernel side (spec §5.4): the coded symbol's smeared mass, the total, and their parts per link and per outside cell. */
  kernelPa = 0;
  kernelZ = 0;
  readonly kernelA = new Float64Array(3);
  readonly kernelT = new Float64Array(3);
  readonly oscaleA = new Float64Array(6);
  readonly oscaleT = new Float64Array(6);

  /** Learning scratch, sized to the run prior's tables on first use. */
  G: Float64Array = new Float64Array(0);
  mark: Uint8Array = new Uint8Array(0);
  touched: Int32Array = new Int32Array(0);
  levA: Float64Array = new Float64Array(0);
  levT: Float64Array = new Float64Array(0);
  lnA: Float64Array = new Float64Array(0);
  lnT: Float64Array = new Float64Array(0);

  private cap = 0;

  constructor(capacity = 64) {
    this.reserve(capacity);
  }

  /** Ensures room for `capacity` votes, keeping the votes already written. */
  reserve(capacity: number): void {
    if (capacity <= this.cap) {
      return;
    }
    let c = this.cap > 0 ? this.cap : 16;
    while (c < capacity) {
      c *= 2;
    }
    this.block = grownInt(this.block, c);
    this.x = grownFloat(this.x, c * HF);
    this.sym = grownInt(this.sym, c);
    this.count = grownFloat(this.count, c);
    this.eLearn = grownFloat(this.eLearn, c);
    this.eCode = grownFloat(this.eCode, c);
    this.share16 = grownFloat(this.share16, c);
    this.src = grownInt(this.src, c);
    this.level = grownInt(this.level, c);
    this.levIndex = grownInt(this.levIndex, c);
    this.lognIndex = grownInt(this.lognIndex, c);
    this.lognL = grownFloat(this.lognL, c);
    const tau = new Uint8Array(c);
    tau.set(this.tau);
    this.tau = tau;
    this.massLearn = grownFloat(this.massLearn, c);
    this.massCode = grownFloat(this.massCode, c);
    this.prev = grownInt(this.prev, c);
    this.cap = c;
  }

  /** Empties the log for a new step and reserves `capacity` votes. */
  reset(capacity = 0): void {
    this.n = 0;
    this.af = -1;
    this.eEsc = 0;
    this.massEsc = 0;
    this.novel = false;
    this.pnovIndex = -1;
    this.oscaleEscIndex = -1;
    this.vx.fill(0);
    this.kernelPa = 0;
    this.kernelZ = 0;
    this.kernelA.fill(0);
    this.kernelT.fill(0);
    this.oscaleA.fill(0);
    this.oscaleT.fill(0);
    this.reserve(capacity);
  }

  /** Appends a vote (masses 0 until pass B) and returns its index. */
  push(
    block: number,
    x: ArrayLike<number>,
    sym: number,
    count: number,
    eLearn: number,
    eCode: number,
    share16: number,
    src: number,
    level: number,
    levIndex: number,
    lognIndex: number,
    lognL: number,
    tau: boolean,
    prev: number
  ): number {
    const i = this.n;
    if (i >= this.cap) {
      this.reserve(i + 1);
    }
    this.block[i] = block;
    const o = i * HF;
    for (let f = 0; f < HF; f++) {
      this.x[o + f] = x[f];
    }
    this.sym[i] = sym;
    this.count[i] = count;
    this.eLearn[i] = eLearn;
    this.eCode[i] = eCode;
    this.share16[i] = share16;
    this.src[i] = src;
    this.level[i] = level;
    this.levIndex[i] = levIndex;
    this.lognIndex[i] = lognIndex;
    this.lognL[i] = lognL;
    this.tau[i] = tau ? 1 : 0;
    this.massLearn[i] = 0;
    this.massCode[i] = 0;
    this.prev[i] = prev;
    this.n = i + 1;
    return i;
  }

  /** Sizes the learning scratch to a run prior. */
  scratch(run: RunPrior): void {
    const nb = run.hybrid.length;
    if (this.G.length !== nb) {
      this.G = new Float64Array(nb);
      this.mark = new Uint8Array(div(nb, HF));
      this.touched = new Int32Array(div(nb, HF));
    }
    if (this.levA.length !== run.lev.length) {
      this.levA = new Float64Array(run.lev.length);
      this.levT = new Float64Array(run.lev.length);
    }
    if (this.lnA.length !== run.logn.length) {
      this.lnA = new Float64Array(run.logn.length);
      this.lnT = new Float64Array(run.logn.length);
    }
  }
}

/** a / b rounded to nearest (ties upward) for 0 <= a < 2^51 and 0 < b < 2^51. */
export function rdiv(a: number, b: number): number {
  return div(2 * a + b, 2 * b);
}

/** A / Sa - T / Z in PB bits for accumulators already under 2^HB, Sa and Z at least 1. */
function grad(a: number, sa: number, t: number, z: number): number {
  return rdiv(shl(a, PB), sa) - rdiv(shl(t, PB), z);
}

/** The path delta rate rho(n) * eta in RB: rho(n) = rho0 * N0 / (N0 + n). */
export function deltaRate(c: PriorConstants, pathN: number): number {
  return smul(div(c.rho0 * c.n0, c.n0 + pathN), c.eta, RB);
}

/**
 * Learns from one coded symbol `a` (spec §5.7): the hybrid blocks and the path's deltas, the
 * escape, pnov, the value-feature slopes, the level-evidence cells, the log-n slopes, and from the
 * kernel side the link weights and the outside multipliers. `Sa` and `Z` are the step's learning
 * accumulators (Sa = the escape's mass plus the coded symbol's votes when it is novel). Deltas
 * learn on the blocks of every source but the built-in.
 */
export function learn(
  run: RunPrior,
  log: VoteLog,
  Sa: number,
  Z: number,
  a: number,
  deltas: PathDeltas | null,
  pathN: number,
  rates: PriorConstants = run.loaded.constants
): void {
  log.scratch(run);
  const s0 = bitlen(Z > Sa ? Z : Sa) - HB;
  const s = s0 > 0 ? s0 : 0;
  const z = Math.max(1, shr(Z, s));
  const sa = Math.max(1, shr(Sa, s));
  const af = log.af >= 0 ? log.af : a;
  const { G, mark, touched, levA, levT, lnA, lnT } = log;
  let nt = 0;
  let tauA = 0;
  let tauT = 0;
  for (let i = 0; i < log.n; i++) {
    const m = log.massLearn[i];
    if (m === 0) {
      continue;
    }
    const ms = shr(m, s);
    const src = log.src[i];
    const hit = log.sym[i] === (src === SRC.msgF || src === SRC.nodeF ? af : a);
    const q =
      (hit ? rdiv(shl(mulShr(m, log.share16[i], PB + s), PB), sa) : 0) - rdiv(shl(ms, PB), z);
    if (q !== 0) {
      const b = log.block[i];
      if (mark[b] === 0) {
        mark[b] = 1;
        touched[nt++] = b;
      }
      const o = b * HF;
      const xo = i * HF;
      for (let f = 0; f < HF; f++) {
        G[o + f] += q * log.x[xo + f];
      }
    }
    if (log.tau[i] === 1) {
      tauT += ms;
      if (hit) {
        tauA += ms;
      }
    }
    const li = log.levIndex[i];
    if (li >= 0) {
      levT[li] += ms;
      if (hit) {
        levA[li] += ms;
      }
    }
    const ni = log.lognIndex[i];
    if (ni >= 0) {
      const d = smul(ms, log.lognL[i], RB);
      lnT[ni] += d;
      if (hit) {
        lnA[ni] += d;
      }
    }
  }

  const eta = rates.eta;
  const cl = rates.clamps;
  const L = levels(run.loaded.order);
  const rr = deltas ? deltaRate(rates, pathN) : 0;
  const h = run.hybrid;
  for (let j = 0; j < nt; j++) {
    const b = touched[j];
    const o = b * HF;
    let d: Float64Array | undefined;
    if (deltas && div(b, L) !== SRC.builtin) {
      d = deltas.get(b);
      if (!d) {
        d = new Float64Array(HF);
        deltas.set(b, d);
      }
    }
    for (let f = 0; f < HF; f++) {
      const g = G[o + f];
      if (g !== 0) {
        if (d) {
          d[f] = clampi(d[f] + smul(rr, g, PB + RB), -cl.delta, cl.delta);
        }
        h[o + f] = clampi(h[o + f] + smul(eta, g, PB + RB), -cl.cell, cl.cell);
        G[o + f] = 0;
      }
    }
    mark[b] = 0;
  }

  if (log.massEsc > 0) {
    const e = shr(log.massEsc, s);
    const g = grad(log.novel ? e : 0, sa, e, z);
    run.escape = clampi(run.escape + smul(eta, g, PB), -cl.cell, cl.cell);
    const pi = log.pnovIndex;
    if (pi >= 0) {
      run.pnov[pi] = clampi(run.pnov[pi] + smul(rates.rates.pnov, g, PB), -cl.cell, cl.cell);
    }
  }

  const gt = grad(tauA, sa, tauT, z);
  if (gt !== 0) {
    for (let f = 0; f < 5; f++) {
      const v = log.vx[f];
      if (v !== 0) {
        const r = rates.rates.vfeat[f] * v;
        run.vfeat[f] = clampi(run.vfeat[f] + smul(r, gt, PB), -cl.vfeat, cl.vfeat);
      }
    }
  }

  for (let i = 0; i < levA.length; i++) {
    const g = grad(levA[i], sa, levT[i], z);
    if (g !== 0) {
      run.lev[i] = clampi(run.lev[i] + smul(rates.rates.lev, g, PB), -cl.lev, cl.lev);
    }
    levA[i] = 0;
    levT[i] = 0;
  }
  for (let i = 0; i < lnA.length; i++) {
    const g = grad(lnA[i], sa, lnT[i], z);
    if (g !== 0) {
      run.logn[i] = clampi(run.logn[i] + smul(rates.rates.logn, g, PB), -cl.logn, cl.logn);
    }
    lnA[i] = 0;
    lnT[i] = 0;
  }

  if (log.kernelZ > 0) {
    const kt = log.kernelZ > log.kernelPa ? log.kernelZ : log.kernelPa;
    const k0 = bitlen(kt) - HB;
    const ks = k0 > 0 ? k0 : 0;
    const pa = Math.max(1, shr(log.kernelPa, ks));
    const kz = Math.max(1, shr(log.kernelZ, ks));
    for (let j = 0; j < 3; j++) {
      const g = grad(shr(log.kernelA[j], ks), pa, shr(log.kernelT[j], ks), kz);
      if (g !== 0) {
        run.kernel[j] = clampi(run.kernel[j] + smul(rates.rates.kernel, g, PB), E_MIN, 0);
      }
    }
    const [lo, hi] = cl.oscale;
    for (let j = 0; j < 6; j++) {
      const g = grad(shr(log.oscaleA[j], ks), pa, shr(log.oscaleT[j], ks), kz);
      if (g !== 0) {
        run.oscale[j] = clampi(run.oscale[j] + smul(rates.rates.oscale, g, PB), lo, hi);
      }
    }
  }
}

/** The confidence map's interpolated probability at cell `o` (row * APM_B + cell) and fraction fr (RB), PB bits. */
export function apmShare(run: RunPrior, o: number, fr: number): number {
  const p0 = run.apm[o];
  return p0 + smul(run.apm[o + 1] - p0, fr, RB);
}

/**
 * Moves the confidence map's two cells at `o` and `o + 1` toward the outcome y (2^PB when the top
 * symbol was coded, else 0), each by its interpolation weight, at the PB rate `rates.apm`.
 */
export function apmUpdate(
  run: RunPrior,
  o: number,
  fr: number,
  y: number,
  rates: PriorConstants = run.loaded.constants
): void {
  const e = y - apmShare(run, o, fr);
  const r = rates.rates.apm;
  const apm = run.apm;
  apm[o] = clampi(apm[o] + smul(r * (ONE - fr), e, PB + RB), APM_LO, APM_HI);
  apm[o + 1] = clampi(apm[o + 1] + smul(r * fr, e, PB + RB), APM_LO, APM_HI);
}
