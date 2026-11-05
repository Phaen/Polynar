/**
 * The number predictor (spec §6.3, prototype r11): an integer at a path is predicted by a mixture
 * of components, each piecewise uniform in dyadic classes around a centre.
 *
 * - Kernels: each of the path's last `history` values h at h + its recency bucket's learned step,
 *   with the signed-class kernel (μ0 at the centre, m±[c] / 2^(c−1) per value of class c).
 * - Spikes: each of those values exactly (identity), weighted by μI.
 * - Siblings: each number coded earlier in the innermost record at another path, at its value plus
 *   a learned step, with its own learned weight.
 * - NOVELTY: the node's own prior (declared bounds or weights, else learned magnitude classes,
 *   mixed with the path's seen range).
 *
 * Every reference kind's weight takes a shared hit-rate cell. When a reference exists, the centre
 * with the most mass at its own value (`top`) is coded first as one binary symbol whose
 * probability the confidence map sharpens; otherwise, or on a miss, the component is coded under
 * the component prior, then the value under the component, and the component is put back through
 * the coder's mixture (`composeMixture` / `parseMixture`) with the posterior at the value as
 * weights, the `TOP_K` heaviest references kept. `top` is removed from every component on a miss.
 *
 * Log-domain quantities are in bits with RB fractional bits; the prototype's natural-log
 * parameters converted once in the prior. Masses are block-scaled per step: the component prior
 * by its largest log-mass, the posterior by its own.
 */

import type { Decoder, Encoder } from '../packer';
import { CorruptInputError } from '../packer/errors';
import {
  HB,
  ONE,
  PB,
  POW2,
  RB,
  SB,
  bitlen,
  clampi,
  div,
  exp2Fix,
  log2Fix,
  mulShr,
  round,
  shl,
  shr,
} from './arith';
import { Distribution } from './distribution';
import { logitToP16 } from './prior';
import { APM_EDGE } from './symbols';
import type { Table } from './symbols';
import { APM_B } from './types';
import type { RangeBuckets, Resolved, RunPrior } from './types';
import { apmShare, apmUpdate, rdiv, smul } from './weights';

/** Recency buckets, classes per sign. */
const NR = 8;
const NC = 64;
/** Parameter layout: wR 0..7, μ0, m+[1..64], m−[1..64], ν, μI. */
const P_MU = NR;
const P_M = NR + 1;
const P_NU = P_M + 2 * NC;
const P_MI = P_NU + 1;
const NP = P_MI + 1;
/** Class cells per centre: μ0 and m±. */
const NCELL = P_NU - P_MU;
/** Magnitude classes 0..64 and the tail, which hands the value to the node's plain spelling. */
const TAIL = NC + 1;
const NCLS = NC + 2;

const P_ONE = POW2[PB];
/**
 * On a miss the encoder writes the value's spelling under every positive-weight component and
 * rolls it back, so the step costs as much as it has components. The TOP_K heaviest posterior
 * weights carry nearly all the mass: the rest are dropped from the coded mixture, not from
 * learning. NOVELTY and RANGE, past the references, are always kept.
 */
const TOP_K = 16;
const TWO_53 = POW2[52] * 2;
const MAX_SAFE = TWO_53 - 1;
/** Steps are held in PB fixed point within ±2^50; a difference that teaches them is clamped to ±2^34. */
const STEP_MAX = POW2[50];
const DIFF_MAX = POW2[34];
/** A reference within this distance of the value counts as a hit of its kind. */
const HIT_D = 3;
/** Hit-rate start (0.5) and bucket edges (0.05, 0.3) in PB. */
const HR_START = POW2[PB - 1];
const HR_RARE = 3277;
const HR_OFTEN = 19661;
/** Reference kinds of the hit-rate cells. */
const K_PAST = 0;
const K_SAME = 1;
const K_SIB = 2;
/** A sibling's starting log-weight, log2(0.05). */
const SIB_START = 0 - log2Fix(20);

/** W[c] = 2^(c − 1), the values of class c on one side, c = 1..64. */
const W = new Float64Array(NC + 1);
W[1] = 1;
for (let c = 2; c <= NC; c++) W[c] = W[c - 1] * 2;

/**
 * The magnitude classes' starting counts in PB, 4 · 2^PB in all: 4 · 2^(−0.15c) normalised over the
 * 66 classes, rounded, the remainder on class 0 (prototype r8 `qStart`).
 */
const QS = new Float64Array(NCLS);
{
  let sum = 0;
  for (let c = 0; c < NCLS; c++) {
    QS[c] = exp2Fix(30 * ONE - div(15 * c * ONE, 100));
    sum += QS[c];
  }
  let used = 0;
  for (let c = 0; c < NCLS; c++) {
    QS[c] = rdiv(shl(QS[c], PB + 2), sum);
    used += QS[c];
  }
  QS[0] += shl(4, PB) - used;
}

/** One path's number state (spec §4.6). */
export class NumberState {
  /** Ring of the last `history` safe values; `n` counts every value entered. */
  readonly hist: Float64Array;
  n = 0;
  /** The path's log-parameters in RB, started from the prior. */
  readonly params: Float64Array;
  /** Learned step per recency bucket, PB fixed point. */
  readonly steps = new Float64Array(NR);
  /** Magnitude class counts (65 = tail) and sign counts. */
  readonly cls = new Float64Array(NCLS);
  ncls = 0;
  readonly sign = Float64Array.of(1, 1);
  /** Per sibling path: its log-weight (RB) and step (PB). */
  readonly sibs = new Map<NumberState, SibState>();
  /** Decayed hit rates per reference kind, PB. */
  readonly hr = Float64Array.of(HR_START, HR_START, HR_START, HR_START);
  /** The smallest and largest value entered (valid once n >= 1). */
  lo = 0;
  hi = 0;
  /** Values in a row that were the top candidate. */
  run = 0;

  /** `start`: the number-start table of the prior the path's space codes under. */
  constructor(
    readonly o: Resolved,
    start: Float64Array
  ) {
    this.hist = new Float64Array(o.history);
    this.params = start.slice();
  }
}

/** A number of the innermost record: its path's state and value. */
export interface RecordEntry {
  readonly state: NumberState;
  readonly value: number;
}

/** The node's declared range: either bound, and a prior over both. */
export interface NumberRange {
  readonly lo?: number;
  readonly hi?: number;
  readonly prior?: RangeBuckets;
}

/** The node's plain spelling of a value, NOVELTY's body under a declared range and for the tail. */
export interface PlainNumber {
  write(enc: Encoder, x: number): void;
  read(dec: Decoder): number;
}

const KERNEL = 0;
const SPIKE = 1;
const SIBLING = 2;
const NOVELTY = 3;
/** NOVELTY's uniform over the path's seen range (the range prior's in-range part). */
const RANGE = 4;

/** How NOVELTY spells a value: the declared prior, both bounds, one bound, or none. */
const BY_PRIOR = 0;
const BY_BOTH = 1;
const BY_LO = 2;
const BY_HI = 3;
const BY_NONE = 4;

/** A sibling path's learned log-weight (RB) and step (PB). */
interface SibState {
  lw: number;
  step: number;
}

/** A two-entry table for the decoder's read of the top candidate's symbol. */
class Binary implements Table {
  constructor(private readonly f0: number) {}
  locate(residual: number): number {
    return residual < this.f0 ? 0 : 1;
  }
  cum(i: number): number {
    return i === 0 ? 0 : this.f0;
  }
  freq(i: number): number {
    return i === 0 ? this.f0 : P_ONE - this.f0;
  }
}

/** A sign or class table read by the decoder: entries 0..n − 1 over `total`. */
class Weighted implements Table {
  constructor(private readonly f: readonly number[]) {}
  locate(residual: number): number {
    let i = 0;
    let c = this.f[0];
    while (c <= residual) c += this.f[++i];
    return i;
  }
  cum(i: number): number {
    let c = 0;
    for (let j = 0; j < i; j++) c += this.f[j];
    return c;
  }
  freq(i: number): number {
    return this.f[i];
  }
}

/** The bits of the magnitude `m >= 0`: its class, 65 from 2^53 on. */
function magClass(m: number): number {
  return m < TWO_53 ? bitlen(m) : TAIL;
}

function larger(a: number, b: number): number {
  return a > b ? a : b;
}

/**
 * Zeroes all but the `k` (≥ 1) heaviest positive entries among `w[0..n)`; among equal weights the
 * lower index is kept. Entries from `n` on are left as they are. `scratch` holds at least `n`
 * entries.
 */
export function keepHeaviest(w: number[], n: number, k: number, scratch: Float64Array): void {
  let m = 0;
  for (let i = 0; i < n; i++) if (w[i] > 0) scratch[m++] = w[i];
  if (m <= k) return;
  const t = kthLargest(scratch, m, k);
  let above = 0;
  for (let i = 0; i < m; i++) if (scratch[i] > t) above++;
  // The `k − above` first entries equal to the threshold fill the k.
  let ties = k - above;
  for (let i = 0; i < n; i++) {
    const x = w[i];
    if (x > t) continue;
    if (x === t && ties > 0) {
      ties--;
      continue;
    }
    w[i] = 0;
  }
}

/** The `k`-th largest of `a[0..m)`, 1 ≤ k ≤ m, by quickselect; `a` is permuted. */
function kthLargest(a: Float64Array, m: number, k: number): number {
  const target = k - 1;
  let lo = 0;
  let hi = m - 1;
  for (;;) {
    const p = a[shr(lo + hi, 1)];
    // [lo, lt) above the pivot, [lt, i) equal to it, (gt, hi] below it.
    let lt = lo;
    let i = lo;
    let gt = hi;
    while (i <= gt) {
      const x = a[i];
      if (x > p) {
        a[i] = a[lt];
        a[lt] = x;
        lt++;
        i++;
      } else if (x < p) {
        a[i] = a[gt];
        a[gt] = x;
        gt--;
      } else {
        i++;
      }
    }
    if (target < lt) hi = lt - 1;
    else if (target > gt) lo = gt + 1;
    else return p;
  }
}

/** The difference a − b clamped to ±2^34, the reach of a step. */
function diffOf(a: number, b: number): number {
  return clampi(a - b, 0 - DIFF_MAX, DIFF_MAX);
}

/**
 * One value's step at a path: the components and their masses, the top candidate, then, once the
 * value is known, the posterior and the learning.
 */
export class NumberCoder {
  private readonly run: RunPrior;
  private readonly p: Float64Array;
  /** Effective bounds, and whether each was declared within the safe integers' reach. */
  private readonly elo: number;
  private readonly ehi: number;
  private readonly loSet: boolean;
  private readonly hiSet: boolean;
  private readonly mode: number;
  private readonly total: number;

  // The step, built by `prepare`.
  private nc = 0;
  private kind = new Int32Array(0);
  /** Centre (kernel, sibling) or value (spike) per component. */
  private at = new Float64Array(0);
  /** Log-weight per component (RB); a kernel's or spike's recency bucket. */
  private lw = new Float64Array(0);
  private bucket = new Int32Array(0);
  /** The prior-scale mass of each component, and their sum. */
  private mass = new Float64Array(0);
  private Z = 0;
  private off = 0;
  /** The step's siblings, oldest first, and each one's state at this path. */
  private readonly sibE: RecordEntry[] = [];
  private readonly sibS: SibState[] = [];
  /** Per component, its log-mass in the component prior (scratch). */
  private K = new Float64Array(0);
  /**
   * Per (weight slot, class cell), the prior-scale mass `massAt` takes, valid where its stamp is
   * the step's: slots 0..7 the kernels' recency buckets, 8.. the siblings by position.
   */
  private kmass = new Float64Array(0);
  private kstamp = new Float64Array(0);
  private stamp = 0;
  /**
   * The step's distinct reference centres, and per centre the summed mass of the spikes at it;
   * `cid` maps a centre to its index.
   */
  private cents = new Float64Array(0);
  private spikeAt = new Float64Array(0);
  private ncent = 0;
  private readonly cid = new Map<number, number>();
  /** Per kernel or sibling, its centre's index in `cents`. */
  private cix = new Int32Array(0);
  /**
   * Per centre index, its class table, finished for the step whose stamp `tableAt` holds: within
   * a step a class table depends only on the centre, as `top` and the row scale are the step's.
   */
  private readonly tables: Distribution[] = [];
  private tableAt = new Float64Array(0);
  /**
   * The step's kernels and siblings grouped by (weight slot, centre), with the group's log-weight
   * and size: slots as in `kmass`. `gid` maps a kernel's centre index · NR + bucket to its group.
   */
  private gSlot = new Int32Array(0);
  private gAt = new Float64Array(0);
  private gLw = new Float64Array(0);
  private gMult = new Float64Array(0);
  private ng = 0;
  private readonly gid = new Map<number, number>();
  /** Row sums by centre under declared bounds, for this step's row scale. */
  private readonly rows = new Map<number, number>();
  /** Where `spot` put its value: class cell, class and offset within the class. */
  private spCell = 0;
  private spC = 0;
  private spK = 0;
  private readonly hb = new Int32Array(3);
  /** Per class cell, the mass at the row scale `offR`, for a row and the class tables. */
  private readonly E = new Float64Array(NP);
  private offR = 0;
  private rowFull = 0;
  /** Per component, its mass in the component prior: a reference's row without `top`. */
  private prior = new Float64Array(0);
  private hasTop = false;
  /** Components before NOVELTY's: kernels, spikes and siblings. */
  private refs = 0;
  private top = 0;
  private t2 = 0;
  private apmO = 0;
  private apmFr = 0;
  private readonly dist = new Distribution();
  private readonly classes = new Distribution();
  // The posterior at the value, built by `observe`.
  private post = new Float64Array(0);
  /** Per reference, its log-mass at the value and whether it has one (scratch). */
  private L = new Float64Array(0);
  private has = new Uint8Array(0);
  private num = 0;
  /** The positive reference weights `capped` selects among (scratch). */
  private sel = new Float64Array(0);
  // Learning scratch.
  private readonly A = new Float64Array(NP);
  private readonly T = new Float64Array(NP);
  private readonly stepT = new Float64Array(NR);
  private readonly stepG = new Float64Array(NR);
  private readonly numK = new Float64Array(3);
  private readonly ZK = new Float64Array(3);
  private readonly hit = new Uint8Array(3);
  /** NOVELTY's posterior in its two parts: the range prior's share m·R and (1 − m)·prior. */
  private novR = 0;
  private novP = 0;
  private useR = false;
  private inR = false;
  private m16 = 0;
  private so16 = 0;

  constructor(
    private readonly state: NumberState,
    run: RunPrior,
    private readonly o: Resolved,
    private readonly range: NumberRange,
    private readonly plain: PlainNumber
  ) {
    this.run = run;
    this.p = state.params;
    const { lo, hi, prior } = range;
    this.loSet = lo !== undefined && lo >= 0 - MAX_SAFE;
    this.hiSet = hi !== undefined && hi <= MAX_SAFE;
    this.elo = this.loSet ? (lo as number) : 0 - MAX_SAFE;
    this.ehi = this.hiSet ? (hi as number) : MAX_SAFE;
    this.mode =
      prior !== undefined
        ? BY_PRIOR
        : lo !== undefined && hi !== undefined
          ? BY_BOTH
          : lo !== undefined
            ? BY_LO
            : hi !== undefined
              ? BY_HI
              : BY_NONE;
    this.total = o.quantisation > P_ONE ? o.quantisation : P_ONE;
  }

  /**
   * Codes `x`, an integer within the declared range; `siblings` are the numbers coded so far in
   * the innermost record.
   */
  write(enc: Encoder, x: number, siblings: readonly RecordEntry[]): void {
    this.prepare(siblings);
    if (this.hasTop) {
      const hit = x === this.top;
      const t2 = this.t2;
      enc.composeWeighted(hit ? 0 : t2, hit ? t2 : P_ONE - t2, P_ONE);
      this.confidence(hit);
      if (hit) {
        this.observe(x);
        this.learn(x);
        return;
      }
    }
    const weights = this.observe(x);
    enc.composeMixture(this.capped(weights), (j) => this.spell(enc, j, x));
    this.learn(x);
  }

  read(dec: Decoder, siblings: readonly RecordEntry[]): number {
    this.prepare(siblings);
    if (this.hasTop) {
      const hit = dec.parseMember(P_ONE, new Binary(this.t2)) === 0;
      this.confidence(hit);
      if (hit) {
        const x = this.top;
        this.observe(x);
        this.learn(x);
        return x;
      }
    }
    const j = this.dist.idAt(dec.parseMember(this.dist.total, this.dist));
    const x = this.unspell(dec, j);
    dec.parseMixture(this.capped(this.observe(x)), j);
    this.learn(x);
    return x;
  }

  /** Where `v`, a safe integer, lies relative to the centre `C`, into `spCell`, `spC`, `spK`. */
  private spot(C: number, v: number): void {
    if (v === C) {
      this.spCell = P_MU;
      this.spC = 0;
      this.spK = 0;
      return;
    }
    const up = v > C;
    const dd = up ? v - C : C - v;
    const c = dd >= TWO_53 ? 54 : bitlen(dd);
    // The class's inner edge is a safe integer whenever a safe value lies in it.
    this.spK = up ? v - (C + W[c]) : C - W[c] - v;
    this.spCell = P_M + (up ? 0 : NC) + c - 1;
    this.spC = c;
  }

  /**
   * The kernel's log-mass at class cell `cell` of class `c`: μ0, or m±[c] spread over the class's
   * 2^(c − 1) values.
   */
  private kern(cell: number, c: number): number {
    return c === 0 ? this.p[P_MU] : this.p[cell] - (c - 1) * ONE;
  }

  /**
   * How many values of the centre `C`'s class `cell` lie within the declared bounds, 0 when the
   * class lies outside; without a bound on its side a class keeps its full width.
   */
  private span(C: number, cell: number): number {
    if (cell === P_MU) return 1;
    const up = cell < P_M + NC;
    const c = cell - (up ? P_M : P_M + NC) + 1;
    const w = W[c];
    if (up) {
      if (!this.hiSet) return w;
      const room = this.ehi - C;
      return w > room ? 0 : room - w + 1 < w ? room - w + 1 : w;
    }
    if (!this.loSet) return w;
    const room = C - this.elo;
    return w > room ? 0 : room - w + 1 < w ? room - w + 1 : w;
  }

  /**
   * The class cell's mass in a centre's row at the row scale, the cell inside the bounds: a cut
   * class scaled to its part inside.
   */
  private cellMass(C: number, cell: number): number {
    if (cell === P_MU) return this.E[P_MU];
    const n = this.span(C, cell);
    const c = cell - (cell < P_M + NC ? P_M : P_M + NC) + 1;
    return n === W[c]
      ? this.E[cell]
      : exp2Fix(this.p[cell] + this.offR + log2Fix(n) - (c - 1) * ONE);
  }

  /**
   * The row mass of a centre at the row scale: every class cell, clipped by the declared bounds;
   * kept per centre for the step.
   */
  private rowSum(C: number): number {
    if (!this.loSet && !this.hiSet) return this.rowFull;
    const kept = this.rows.get(C);
    if (kept !== undefined) return kept;
    let sum = this.E[P_MU];
    for (let side = 0; side < 2; side++) {
      // Classes widen outward, so past the first one outside the bounds every one is.
      for (let c = 1; c <= NC; c++) {
        const cell = P_M + side * NC + c - 1;
        if (this.span(C, cell) === 0) break;
        sum += this.cellMass(C, cell);
      }
    }
    this.rows.set(C, sum);
    return sum;
  }

  /** The mass of one value of a centre's class `cell` at the row scale. */
  private valueMass(cell: number): number {
    if (cell === P_MU) return this.E[P_MU];
    const c = cell - (cell < P_M + NC ? P_M : P_M + NC) + 1;
    return exp2Fix(this.p[cell] + this.offR - (c - 1) * ONE);
  }

  private centre(v: number, step: number): number {
    return clampi(v + round(step, PB), this.elo, this.ehi);
  }

  /** The step's components, their prior masses, and the top candidate. */
  private prepare(siblings: readonly RecordEntry[]): void {
    const st = this.state;
    const p = this.p;
    const run = this.run;
    for (let k = 0; k < 3; k++) {
      const r = st.hr[k];
      this.hb[k] = r < HR_RARE ? 0 : r < HR_OFTEN ? 1 : 2;
    }
    const HT = run.numberHit;
    const ht0 = HT[K_PAST * 3 + this.hb[0]];
    const ht1 = HT[K_SAME * 3 + this.hb[1]];
    const ht2 = HT[K_SIB * 3 + this.hb[2]];

    let maxCell = p[P_MU];
    for (let j = P_M; j < P_NU; j++) if (p[j] > maxCell) maxCell = p[j];
    this.offR = SB * ONE - maxCell;
    // Every cell is at most 2^SB, so a row of 129 stays below 2^44.
    let full = 0;
    for (let j = P_MU; j < P_NU; j++) {
      this.E[j] = exp2Fix(p[j] + this.offR);
      full += this.E[j];
    }
    this.rowFull = full;
    this.rows.clear();

    const h = st.n < this.o.history ? st.n : this.o.history;
    // The record's latest `history` numbers at other paths, oldest first: a record that took in
    // the numbers of many inner records keeps the component table and its sums bounded.
    const sibs = this.sibE;
    sibs.length = 0;
    for (let i = siblings.length - 1; i >= 0 && sibs.length < this.o.history; i--) {
      if (siblings[i].state !== st) sibs.push(siblings[i]);
    }
    sibs.reverse();
    this.useR = this.mode === BY_NONE && st.n >= 2;
    const n = 2 * h + sibs.length + (this.useR ? 2 : 1);
    if (this.kind.length < n) {
      this.kind = new Int32Array(n);
      this.at = new Float64Array(n);
      this.lw = new Float64Array(n);
      this.bucket = new Int32Array(n);
      this.mass = new Float64Array(n);
      this.prior = new Float64Array(n);
      this.post = new Float64Array(n);
      this.K = new Float64Array(n);
      this.L = new Float64Array(n);
      this.has = new Uint8Array(n);
      this.cents = new Float64Array(n);
      this.cix = new Int32Array(n);
      this.spikeAt = new Float64Array(n);
      this.gSlot = new Int32Array(n);
      this.gAt = new Float64Array(n);
      this.gLw = new Float64Array(n);
      this.gMult = new Float64Array(n);
    }
    this.nc = n;
    const K = this.K;
    const cells = (NR + sibs.length) * NCELL;
    if (this.kmass.length < cells) {
      this.kmass = new Float64Array(larger(cells, 2 * this.kmass.length));
      this.kstamp = new Float64Array(this.kmass.length);
    }
    this.stamp++;
    let j = 0;
    for (let a = 1; a <= h; a++) {
      const i = st.n - a;
      const b = bitlen(a) - 1 < NR - 1 ? bitlen(a) - 1 : NR - 1;
      const C = this.centre(st.hist[i % this.o.history], st.steps[b]);
      this.kind[j] = KERNEL;
      this.at[j] = C;
      this.bucket[j] = b;
      this.lw[j] = p[b] + ht0;
      K[j] = this.lw[j] + log2Fix(this.rowSum(C)) - this.offR;
      j++;
    }
    for (let a = 1; a <= h; a++) {
      const i = st.n - a;
      const b = bitlen(a) - 1 < NR - 1 ? bitlen(a) - 1 : NR - 1;
      this.kind[j] = SPIKE;
      this.at[j] = st.hist[i % this.o.history];
      this.bucket[j] = b;
      this.lw[j] = p[b] + p[P_MI] + ht1;
      K[j] = this.lw[j];
      j++;
    }
    const sibS = this.sibS;
    sibS.length = 0;
    for (const e of sibs) {
      let s = st.sibs.get(e.state);
      if (s === undefined) {
        s = { lw: SIB_START, step: 0 };
        st.sibs.set(e.state, s);
      }
      sibS.push(s);
      const C = this.centre(e.value, s.step);
      this.kind[j] = SIBLING;
      this.at[j] = C;
      this.lw[j] = s.lw + ht2;
      K[j] = this.lw[j] + log2Fix(this.rowSum(C)) - this.offR;
      j++;
    }
    if (this.useR) {
      // NOVELTY splits into the uniform over [lo, hi] with m · (1 − so) of its weight, and the
      // node's prior with the rest.
      const RT = run.numberRange;
      this.m16 = logitToP16(RT[0]);
      this.so16 = logitToP16(RT[1]);
      const share = mulShr(this.m16, P_ONE - this.so16, PB);
      this.kind[j] = RANGE;
      this.lw[j] = p[P_NU] + log2Fix(this.m16) + log2Fix(P_ONE - this.so16) - 2 * PB * ONE;
      K[j] = this.lw[j];
      j++;
      this.kind[j] = NOVELTY;
      this.lw[j] = p[P_NU] + log2Fix(P_ONE - share) - PB * ONE;
    } else {
      this.kind[j] = NOVELTY;
      this.lw[j] = p[P_NU];
    }
    K[j] = this.lw[j];

    let M = K[0];
    for (let i = 1; i < n; i++) if (K[i] > M) M = K[i];
    // Every mass is at most 2^SB and there are at most 3 · 4096 + 2 of them.
    this.off = SB * ONE - M;
    let Z = 0;
    for (let i = 0; i < n; i++) {
      this.mass[i] = exp2Fix(K[i] + this.off);
      Z += this.mass[i];
    }
    this.Z = Z;

    this.refs = 2 * h + sibs.length;
    this.hasTop = this.refs > 0;
    this.prior.set(this.mass.subarray(0, n));
    if (this.hasTop) {
      this.group();
      this.findTop();
      // On a miss `top` is out of every component: a reference's prior mass loses top's value
      // mass in its row, which with the class tables below is the prototype's P(x) / (1 − t).
      if (this.useR && this.topInRange()) {
        // The range loses `top`, one of its hi − lo + 1 values.
        const spread = st.hi - st.lo;
        const r = n - 2;
        this.prior[r] =
          spread === 0
            ? 0
            : spread >= MAX_SAFE - 1
              ? this.prior[r]
              : exp2Fix(this.lw[r] + log2Fix(spread) - log2Fix(spread + 1) + this.off);
      }
      for (let i = 0; i < this.refs; i++) {
        const kd = this.kind[i];
        if (kd === SPIKE) {
          if (this.at[i] === this.top) this.prior[i] = 0;
          continue;
        }
        const C = this.at[i];
        const row = this.rowSum(C);
        this.spot(C, this.top);
        const rest = row - this.valueMass(this.spCell);
        this.prior[i] = rest > 0 ? exp2Fix(this.lw[i] + log2Fix(rest) - this.offR + this.off) : 0;
      }
    }

    const d = this.dist;
    d.begin(this.total, false);
    for (let i = 0; i < n; i++) {
      if (this.kind[i] === SPIKE && this.hasTop && this.at[i] === this.top) continue;
      // A range of `top` alone holds nothing on a miss.
      if (this.kind[i] === RANGE && this.hasTop && st.lo === st.hi && this.top === st.lo) continue;
      d.add(i, this.prior[i]);
    }
    d.finish(0);
  }

  /**
   * The step's distinct centres and reference groups for `massAt`: kernels of one recency bucket
   * and centre share their log-weight and centre, so they add the same mass at any value.
   */
  private group(): void {
    const cid = this.cid;
    const gid = this.gid;
    cid.clear();
    gid.clear();
    this.ncent = 0;
    this.ng = 0;
    const sib0 = this.refs - this.sibS.length;
    for (let i = 0; i < this.refs; i++) {
      const kd = this.kind[i];
      if (kd === SPIKE) continue;
      const C = this.at[i];
      let ci = cid.get(C);
      if (ci === undefined) {
        ci = this.ncent++;
        cid.set(C, ci);
        this.cents[ci] = C;
        this.spikeAt[ci] = 0;
      }
      this.cix[i] = ci;
      const key = ci * NR + this.bucket[i];
      const g = kd === KERNEL ? gid.get(key) : undefined;
      if (g !== undefined) {
        this.gMult[g]++;
        continue;
      }
      const ng = this.ng++;
      if (kd === KERNEL) gid.set(key, ng);
      this.gSlot[ng] = kd === KERNEL ? this.bucket[i] : NR + i - sib0;
      this.gAt[ng] = C;
      this.gLw[ng] = this.lw[i];
      this.gMult[ng] = 1;
    }
    for (let i = 0; i < this.refs; i++) {
      if (this.kind[i] !== SPIKE) continue;
      const ci = cid.get(this.at[i]);
      if (ci !== undefined) this.spikeAt[ci] += this.mass[i];
    }
  }

  /**
   * The prior-scale mass of every reference at the centre `ci`. Within a step a kernel's
   * log-weight is its recency bucket's and a sibling's its own, and the kernel's log-mass is its
   * class cell's, so each (slot, cell) mass is one `exp2Fix` argument, worked out once. Every term
   * is an integer and the masses of a step sum below 2^50 (at most 3 · 4096 + 2 of at most 2^SB),
   * so a group's size times its term and the sum in any order are exact.
   */
  private massAt(ci: number): number {
    const v = this.cents[ci];
    const kmass = this.kmass;
    const kstamp = this.kstamp;
    const stamp = this.stamp;
    let m = this.spikeAt[ci];
    for (let g = 0; g < this.ng; g++) {
      this.spot(this.gAt[g], v);
      const at = this.gSlot[g] * NCELL + this.spCell - P_MU;
      if (kstamp[at] !== stamp) {
        kstamp[at] = stamp;
        kmass[at] = exp2Fix(this.gLw[g] + this.kern(this.spCell, this.spC) + this.off);
      }
      m += this.gMult[g] * kmass[at];
    }
    return m;
  }

  /** The centre of most mass at its own value (lowest on ties), its share and the map's sharpening. */
  private findTop(): void {
    let best = -1;
    let top = 0;
    for (let ci = 0; ci < this.ncent; ci++) {
      const c = this.cents[ci];
      const m = this.massAt(ci);
      if (m > best || (m === best && c < top)) {
        best = m;
        top = c;
      }
    }
    this.top = top;
    // Z holds the step's largest mass, 2^SB, so it is positive and the shift is too.
    const s = bitlen(this.Z) - HB;
    const t16 = clampi(div(shl(shr(best, s), PB), shr(this.Z, s)), 0, P_ONE);
    let i = 0;
    while (i < APM_B - 2 && APM_EDGE[i + 1] <= t16) i++;
    const fr = clampi(div(shl(t16 - APM_EDGE[i], RB), APM_EDGE[i + 1] - APM_EDGE[i]), 0, ONE);
    const r = this.state.run;
    const row = r === 0 ? 0 : r === 1 ? 1 : r <= 3 ? 2 : r <= 7 ? 3 : 4;
    this.apmO = row * APM_B + i;
    this.apmFr = fr;
    const q = apmShare(this.run, this.apmO, fr, this.run.numberConf);
    this.t2 = clampi(shr(t16 + 3 * q, 2), 1, P_ONE - 1);
  }

  /** The confidence map and the run learn whether the value was the top candidate. */
  private confidence(hit: boolean): void {
    const run = this.run;
    apmUpdate(run, this.apmO, this.apmFr, hit ? P_ONE : 0, run.loaded.constants, run.numberConf);
    this.state.run = hit ? this.state.run + 1 : 0;
  }

  /** The magnitude NOVELTY's classes measure: from the lone bound, else from 0. */
  private magnitude(x: number): number {
    return this.mode === BY_LO
      ? x - (this.range.lo as number)
      : this.mode === BY_HI
        ? (this.range.hi as number) - x
        : x < 0
          ? 0 - x
          : x;
  }

  /** log2 of NOVELTY's prior at `x` (RB), before the range prior. */
  private priorLog(x: number): number {
    const st = this.state;
    if (this.mode === BY_PRIOR) {
      // A value of weight 0 is never written, though corrupt input can decode one.
      const [, freq, total] = (this.range.prior as RangeBuckets).bucketOf(x);
      return log2Fix(freq > 0 ? freq : 1) - log2Fix(total);
    }
    if (this.mode === BY_BOTH) {
      const span = (this.range.hi as number) - (this.range.lo as number);
      return span >= MAX_SAFE ? 0 - 53 * ONE : 0 - log2Fix(span + 1);
    }
    const c = magClass(this.magnitude(x));
    let L = log2Fix(st.cls[c] * P_ONE + QS[c]) - log2Fix((st.ncls + 4) * P_ONE);
    if (this.mode === BY_NONE && c !== 0 && c !== TAIL) {
      L += log2Fix(st.sign[x < 0 ? 1 : 0]) - log2Fix(st.sign[0] + st.sign[1]);
    }
    return c === TAIL ? L - 53 * ONE : c >= 2 ? L - (c - 1) * ONE : L;
  }

  /**
   * The posterior of every component at `x` (the mixture's weights), block-scaled by its largest
   * log-mass; NOVELTY's at least 1. NOVELTY's learning parts follow the prototype's prior
   * m · R + (1 − m) · prior: `novR` the first, `novP` the second.
   */
  private observe(x: number): number[] {
    const st = this.state;
    const n = this.nc;
    const refs = this.refs;
    const safe = Number.isSafeInteger(x);
    const L = this.L;
    const has = this.has;
    has.fill(0, 0, refs);
    const nu = this.p[P_NU];
    const lp = this.priorLog(x);
    // NOVELTY's parts: the prior's with weight 1 − m, and with weight m either the uniform over
    // the seen range (in it) or so times the prior (outside it).
    let lP = nu + lp;
    let lR = 0;
    let lX = 0;
    this.inR = false;
    if (this.useR) {
      this.inR = safe && x >= st.lo && x <= st.hi;
      const spread = st.hi - st.lo;
      const lspan = spread >= MAX_SAFE ? 53 * ONE : log2Fix(spread + 1);
      const lm = nu + log2Fix(this.m16) - PB * ONE;
      lR = lm + log2Fix(P_ONE - this.so16) - PB * ONE - lspan;
      lX = lm + log2Fix(this.so16) - PB * ONE + lp;
      lP = nu + log2Fix(P_ONE - this.m16) - PB * ONE + lp;
    }
    let M = lP;
    if (this.useR) {
      M = larger(M, lX);
      if (this.inR) M = larger(M, lR);
    }
    if (safe) {
      for (let i = 0; i < refs; i++) {
        if (this.kind[i] === SPIKE) {
          if (this.at[i] !== x) continue;
          L[i] = this.lw[i];
        } else {
          this.spot(this.at[i], x);
          L[i] = this.lw[i] + this.kern(this.spCell, this.spC);
        }
        has[i] = 1;
        if (L[i] > M) M = L[i];
      }
    }
    // The posterior's own scale; at most 3 · 4096 + 2 masses of at most 2^SB.
    const off = SB * ONE - M;
    const w: number[] = new Array<number>(n).fill(0);
    let num = 0;
    for (let i = 0; i < refs; i++) {
      this.post[i] = has[i] === 1 ? exp2Fix(L[i] + off) : 0;
      w[i] = this.post[i];
      num += w[i];
    }
    this.novP = exp2Fix(lP + off);
    let rest = this.novP;
    if (this.useR) {
      const inside = this.inR ? exp2Fix(lR + off) : 0;
      const outside = exp2Fix(lX + off);
      this.novR = this.inR ? inside : outside;
      w[n - 2] = inside;
      // NOVELTY carries the prior with weight 1 − m + m · so wherever the value lies, so its
      // posterior holds both parts; the uniform over the range is a component of its own.
      rest += outside;
    } else {
      this.novR = 0;
    }
    w[n - 1] = rest > 0 ? rest : 1;
    const nov = this.novR + this.novP;
    this.post[n - 1] = nov > 0 ? nov : 1;
    this.num = num + this.post[n - 1];
    return w;
  }

  /** The mixture weights `w` with only the TOP_K heaviest references kept, in place. */
  private capped(w: number[]): number[] {
    const refs = this.refs;
    if (refs <= TOP_K) return w;
    if (this.sel.length < refs) this.sel = new Float64Array(larger(refs, 2 * this.sel.length));
    keepHeaviest(w, refs, TOP_K, this.sel);
    return w;
  }

  /**
   * The class table of component `j`'s centre: every cell inside the bounds, at the row scale;
   * built once per step and centre.
   */
  private classTable(j: number): Distribution {
    const C = this.at[j];
    const ci = this.cix[j];
    if (ci >= this.tableAt.length) {
      const grown = new Float64Array(larger(ci + 1, 2 * this.tableAt.length));
      grown.set(this.tableAt);
      this.tableAt = grown;
    }
    while (this.tables.length <= ci) this.tables.push(new Distribution());
    const d = this.tables[ci];
    if (this.tableAt[ci] === this.stamp) return d;
    this.tableAt[ci] = this.stamp;
    d.begin(this.total, false);
    // A centre is a reference's, so the step has a top candidate.
    this.spot(C, this.top);
    const tc = this.spCell;
    for (let cell = P_MU; cell < P_NU; cell++) {
      const n = this.span(C, cell);
      if (cell !== tc) {
        if (n > 0) d.add(cell - P_MU, this.cellMass(C, cell));
      } else if (n > 1) {
        // The class without `top`; a class of top alone is no entry.
        d.add(cell - P_MU, this.cellMass(C, cell) - this.valueMass(cell));
      }
    }
    d.finish(0);
    return d;
  }

  /** The offset of `top` in a centre's class `cell`, or −1 when `top` is not in it. */
  private topIn(C: number, cell: number): number {
    this.spot(C, this.top);
    return this.spCell === cell ? this.spK : -1;
  }

  /** Writes `x` as component `j`: the component, then the value under it. */
  private spell(enc: Encoder, j: number, x: number): void {
    const d = this.dist;
    const i = d.indexOf(j);
    enc.composeWeighted(d.cum(i), d.freq(i), d.total);
    const kd = this.kind[j];
    if (kd === SPIKE) return;
    if (kd === NOVELTY) {
      this.novelty(enc, x);
      return;
    }
    if (kd === RANGE) {
      this.inRange(enc, x);
      return;
    }
    const C = this.at[j];
    this.spot(C, x);
    // `classTable` and `topIn` spot `top`, so x's spot is read first.
    const cell = this.spCell;
    const sk = this.spK;
    const t = this.classTable(j);
    const ci = t.indexOf(cell - P_MU);
    enc.composeWeighted(t.cum(ci), t.freq(ci), t.total);
    const tk = this.topIn(C, cell);
    const width = this.span(C, cell) - (tk >= 0 ? 1 : 0);
    const k = tk >= 0 && sk > tk ? sk - 1 : sk;
    if (width > MAX_SAFE) enc.composeBig(BigInt(k), BigInt(width));
    else enc.compose(k, width);
  }

  /** Reads the value of component `j`, its component already read. */
  private unspell(dec: Decoder, j: number): number {
    const kd = this.kind[j];
    if (kd === SPIKE) return this.at[j];
    if (kd === NOVELTY) return this.unnovelty(dec);
    if (kd === RANGE) return this.unrange(dec);
    const C = this.at[j];
    const t = this.classTable(j);
    const cell = t.idAt(dec.parseMember(t.total, t)) + P_MU;
    const tk = this.topIn(C, cell);
    if (cell === P_MU) return C;
    // A class of `top` alone has no entry in the class table, so the width is at least 1.
    const width = this.span(C, cell) - (tk >= 0 ? 1 : 0);
    const up = cell < P_M + NC;
    const c = cell - (up ? P_M : P_M + NC) + 1;
    const k0 = width > MAX_SAFE ? dec.parseBig(BigInt(width)) : BigInt(dec.parse(width));
    const k = tk >= 0 && k0 >= BigInt(tk) ? k0 + 1n : k0;
    const v = up ? BigInt(C) + BigInt(W[c]) + k : BigInt(C) - BigInt(W[c]) - k;
    if (v < BigInt(0 - MAX_SAFE) || v > BigInt(MAX_SAFE)) {
      throw new CorruptInputError('Number is outside the safe integers');
    }
    return Number(v);
  }

  /** Whether `top` lies in the seen range, which then codes over one value fewer. */
  private topInRange(): boolean {
    return this.hasTop && this.top >= this.state.lo && this.top <= this.state.hi;
  }

  /** RANGE's body: the value's offset in the seen range, `top` taken out. */
  private inRange(enc: Encoder, x: number): void {
    const { lo, hi } = this.state;
    const cut = this.topInRange();
    const k = cut && x > this.top ? x - lo - 1 : x - lo;
    const extra = cut ? 0 : 1;
    if (hi - lo < MAX_SAFE) {
      enc.compose(k, hi - lo + extra);
    } else {
      enc.composeBig(BigInt(k), BigInt(hi) - BigInt(lo) + BigInt(extra));
    }
  }

  private unrange(dec: Decoder): number {
    const { lo, hi } = this.state;
    const cut = this.topInRange();
    const extra = cut ? 0 : 1;
    const x =
      hi - lo < MAX_SAFE
        ? lo + dec.parse(hi - lo + extra)
        : Number(BigInt(lo) + dec.parseBig(BigInt(hi) - BigInt(lo) + BigInt(extra)));
    return cut && x >= this.top ? x + 1 : x;
  }

  /** The magnitude classes' table. */
  private magTable(): Distribution {
    const st = this.state;
    const d = this.classes;
    d.begin(this.total, false);
    for (let c = 0; c < NCLS; c++) d.add(c, st.cls[c] * P_ONE + QS[c]);
    d.finish(0);
    return d;
  }

  /** NOVELTY's body: the plain spelling under a declared range, else class, sign and offset. */
  private novelty(enc: Encoder, x: number): void {
    if (this.mode === BY_PRIOR || this.mode === BY_BOTH) {
      this.plain.write(enc, x);
      return;
    }
    const m = this.magnitude(x);
    const c = magClass(m);
    const t = this.magTable();
    enc.composeWeighted(t.cum(c), t.freq(c), t.total);
    if (c === TAIL) {
      this.plain.write(enc, x);
      return;
    }
    const sg = this.state.sign;
    if (this.mode === BY_NONE && c !== 0) {
      const neg = x < 0;
      enc.composeWeighted(neg ? sg[0] : 0, sg[neg ? 1 : 0], sg[0] + sg[1]);
    }
    if (c >= 2) enc.compose(m - W[c], W[c]);
  }

  private unnovelty(dec: Decoder): number {
    if (this.mode === BY_PRIOR || this.mode === BY_BOTH) return this.plain.read(dec);
    const t = this.magTable();
    const c = t.idAt(dec.parseMember(t.total, t));
    if (c === TAIL) return this.plain.read(dec);
    if (c > 53) throw new CorruptInputError('Number magnitude class is past the safe integers');
    const sg = this.state.sign;
    const neg =
      this.mode === BY_NONE &&
      c !== 0 &&
      dec.parseMember(sg[0] + sg[1], new Weighted([sg[0], sg[1]])) === 1;
    const m = c >= 2 ? W[c] + dec.parse(W[c]) : c;
    if (this.mode === BY_NONE) return neg ? 0 - m : m;
    const b = this.mode === BY_LO ? (this.range.lo as number) : (this.range.hi as number);
    const x = this.mode === BY_LO ? b + m : b - m;
    // A bound past the safe integers reaches only some offsets exactly.
    if ((this.mode === BY_LO ? x - b : b - x) !== m) {
      throw new CorruptInputError('Number is outside the exact reach of its bound');
    }
    return x;
  }

  /** Learning after the value (r11 lines 110–120), then the path's state takes it. */
  private learn(x: number): void {
    const st = this.state;
    const p = this.p;
    const run = this.run;
    const c0 = run.loaded.constants;
    const eta = c0.rates.number;
    const n = this.nc;
    const safe = Number.isSafeInteger(x);

    // Both sums hold their step's largest mass, 2^SB, so both shifts are positive.
    const sp = bitlen(this.num) - HB;
    const num = shr(this.num, sp);
    const sz = bitlen(this.Z) - HB;
    const Z = shr(this.Z, sz);
    /** Share of a posterior mass, of a prior mass, in PB. */
    const qa = (a: number): number => rdiv(shl(shr(a, sp), PB), num);
    const qt = (t: number): number => rdiv(shl(shr(t, sz), PB), Z);

    const { A, T, numK, ZK, hit, stepT, stepG } = this;
    A.fill(0);
    T.fill(0);
    numK.fill(0);
    ZK.fill(0);
    hit.fill(0);
    stepT.fill(0);
    stepG.fill(0);
    let kernels = 0;
    // The kernel weights' log-sum, for the class cells' T factorised as (Σ w) · e[cell].
    let lwMax = 0;
    let anyK = false;
    for (let i = 0; i < this.refs; i++) {
      if (this.kind[i] === SPIKE) continue;
      if (!anyK || this.lw[i] > lwMax) lwMax = this.lw[i];
      anyK = true;
    }
    let wsum = 0;
    for (let i = 0; i < this.refs; i++) {
      const kd = this.kind[i];
      const post = this.post[i];
      const mass = this.mass[i];
      if (kd === KERNEL) {
        kernels++;
        const b = this.bucket[i];
        A[b] += post;
        T[b] += mass;
        numK[K_PAST] += post;
        ZK[K_PAST] += mass;
        wsum += exp2Fix(this.lw[i] - lwMax + SB * ONE);
        if (safe) {
          this.spot(this.at[i], x);
          A[this.spCell] += post;
          if (x - this.at[i] <= HIT_D && this.at[i] - x <= HIT_D) hit[K_PAST] = 1;
        }
      } else if (kd === SPIKE) {
        const b = this.bucket[i];
        A[b] += post;
        T[b] += mass;
        A[P_MI] += post;
        T[P_MI] += mass;
        numK[K_SAME] += post;
        ZK[K_SAME] += mass;
        if (safe && this.at[i] === x) hit[K_SAME] = 1;
      } else {
        numK[K_SIB] += post;
        ZK[K_SIB] += mass;
        wsum += exp2Fix(this.lw[i] - lwMax + SB * ONE);
        if (safe) {
          this.spot(this.at[i], x);
          A[this.spCell] += post;
          if (x - this.at[i] <= HIT_D && this.at[i] - x <= HIT_D) hit[K_SIB] = 1;
        }
      }
    }
    A[P_NU] = this.post[n - 1];
    T[P_NU] = this.mass[n - 1] + (this.useR ? this.mass[n - 2] : 0);
    if (anyK) {
      const lw = log2Fix(wsum) - SB * ONE + lwMax;
      for (let cell = P_MU; cell < P_NU; cell++) T[cell] = exp2Fix(lw + p[cell] + this.off);
    }

    const cn = c0.clamps.number;
    for (let j = 0; j < NP; j++) {
      if (A[j] === 0 && T[j] === 0) continue;
      const g = qa(A[j]) - qt(T[j]);
      if (g !== 0) p[j] = clampi(p[j] + smul(eta, g, PB), 0 - cn, cn);
    }

    // Siblings' weights and steps.
    const sibS = this.sibS;
    const sib0 = this.refs - sibS.length;
    const rate = c0.rates.step;
    for (let k = 0; k < sibS.length; k++) {
      const s = sibS[k];
      const i = sib0 + k;
      const g = qa(this.post[i]) - qt(this.mass[i]);
      s.lw = clampi(s.lw + smul(eta, g, PB), 0 - cn, cn);
      if (safe) {
        const share = div(shl(shr(this.post[i], sp), PB), num);
        const delta = smul(share, shl(diffOf(x, this.sibE[k].value), PB) - s.step, PB);
        s.step = clampi(s.step + smul(rate, delta, RB), 0 - STEP_MAX, STEP_MAX);
      }
    }

    // The range prior's mix and outside share.
    if (this.useR) {
      const RT = run.numberRange;
      const cr = c0.clamps.range;
      const qm = qa(this.novR);
      const qp = qa(this.novP);
      const g0 = smul(P_ONE - this.m16, qm, PB) - smul(this.m16, qp, PB);
      const g1 = this.inR ? 0 - smul(this.so16, qm, PB) : smul(P_ONE - this.so16, qm, PB);
      RT[0] = clampi(RT[0] + smul(eta, g0, PB), 0 - cr, cr);
      RT[1] = clampi(RT[1] + smul(eta, g1, PB), 0 - cr, cr);
    }

    // Hit-rate cells and rates.
    const HT = run.numberHit;
    const ch = c0.clamps.hit;
    const dec = c0.decays.hit;
    for (let k = 0; k < 3; k++) {
      if (k === K_SIB ? sibS.length === 0 : kernels === 0) continue;
      const g = qa(numK[k]) - qt(ZK[k]);
      const c = k * 3 + this.hb[k];
      HT[c] = clampi(HT[c] + smul(eta, g, PB), 0 - ch, ch);
      st.hr[k] = st.hr[k] - shr(st.hr[k], dec) + (hit[k] === 1 ? shr(P_ONE, dec) : 0);
    }

    // Steps toward the kernels' targets by responsibility.
    if (safe) {
      for (let i = 0; i < this.refs; i++) {
        if (this.kind[i] !== KERNEL) continue;
        const b = this.bucket[i];
        const share = div(shl(shr(this.post[i], sp), PB), num);
        const v = st.hist[(st.n - 1 - i + this.o.history * 2) % this.o.history];
        stepT[b] += share * diffOf(x, v);
        stepG[b] += share;
      }
      for (let b = 0; b < NR; b++) {
        if (stepG[b] === 0) continue;
        const delta = stepT[b] - smul(stepG[b], st.steps[b], PB);
        st.steps[b] = clampi(st.steps[b] + smul(rate, delta, RB), 0 - STEP_MAX, STEP_MAX);
      }
    }

    // Magnitude classes and signs, the seen range, the history and the record.
    const c = magClass(this.magnitude(x));
    st.cls[c]++;
    st.ncls++;
    if (c !== 0) st.sign[x < 0 ? 1 : 0]++;
    if (safe) {
      if (st.n === 0 || x < st.lo) st.lo = x;
      if (st.n === 0 || x > st.hi) st.hi = x;
      st.hist[st.n % this.o.history] = x;
      st.n++;
    }
  }
}
