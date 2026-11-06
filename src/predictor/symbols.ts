/**
 * The symbol predictor (spec §4.4): one per path and alphabet in a session. A step resolves every
 * voting population, writes each vote to the step's log with its exact-level count and its
 * exponent (pass A), turns the log-masses into masses at one block scale (pass B), smears them
 * through the kernel links into the entries of the coded distribution, quantises it and maps the
 * top entry's share through the confidence map (`distribution`). `write` / `read` code the entry
 * and the escape body; `learn` then updates the run prior, the path's deltas and every population.
 *
 * Populations vote in the prototype's order: message (source 1), path (0), built-in (2), the
 * digit-folded message (5) and path (6), the current value (3). Sticky votes (source 7) follow the
 * population they come from: the path's same-offset ring and the message's recently broken
 * matches. Learning reads the masses before the kernel and the confidence map, as the prototype
 * did; the kernel links and the map learn from the coded side's own quantities.
 */

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
  linMass,
  log2Fix,
  mulShr,
  shl,
  shr,
} from './arith';
import { CorruptInputError } from '../packer/errors';
import type { Ids } from './alphabet';
import { Distribution } from './distribution';
import {
  anchorDepth,
  decayedMean,
  detBucket,
  dist,
  CELLS,
  CELL_UNITS,
  cellOf,
  levBucket,
  longBucket,
  lognTerm,
  shadowCost,
  shadowCostOf,
  valueAdvance,
  valueFeatures,
  valueState,
} from './features';
import type { ValueState } from './features';
import { Population, STRIDE } from './tables';
import type { Entries, Frozen } from './tables';
import { APM_B, BYTE_BASE, CP_BASE, DIGIT, END, HF, NSRC, SRC, levels } from './types';
import type { AlphabetKind, Resolved, RunPrior } from './types';
import { ValueStep, VSTEP_N } from './values';
import { VoteLog, apmShare, apmUpdate, blockOf, learn } from './weights';
import type { PathDeltas } from './weights';

/** What the coder writes to: an `Encoder`, or anything that prices or records the same calls. */
export interface Sink {
  composeWeighted(cum: number, freq: number, total: number): void;
  compose(integer: number, radix: number): void;
  /** The next symbol is a non-end at a step that an end may close. */
  open(): void;
}

/** A frequency table the decoder reads a member of (the packer's `MemberTable`). */
export interface Table {
  locate(residual: number): number;
  cum(i: number): number;
  freq(i: number): number;
}

/** What the coder reads from: a `Decoder`. */
export interface Source {
  parseMember(total: number, table: Table): number;
  parse(radix: number): number;
  /** The state once every digit is read, -1n while digits remain. */
  readonly idle: bigint;
}

/**
 * The switches of the engine's parts, all on by default. The measurement switches them one at a time
 * to isolate D1.
 */
export interface Features {
  /** The current value's population votes (source 3). */
  tree: boolean;
  /** Votes whose position sat at the same value offset carry the offset-agreement feature. */
  offsetAgreement: boolean;
  /** The boundary depth feature distinguishes word, value and record anchoring. */
  depth: boolean;
  /** The path's value features scale its population's votes. */
  valueFeatures: boolean;
  /** The path's level-evidence scores scale its population's votes. */
  levelEvidence: boolean;
  /** The path's novelty history scales the escape. */
  pathNovelty: boolean;
  /** The path's same-offset ring votes. */
  offsetRing: boolean;
  /** The path learns deltas over the shared weights. */
  deltas: boolean;
  /** Whole past values of the path vote before a string value. */
  valueStep: boolean;
}

/** Every switch at its default. */
export function defaultFeatures(): Features {
  return {
    tree: true,
    offsetAgreement: true,
    depth: true,
    valueFeatures: true,
    levelEvidence: true,
    pathNovelty: true,
    offsetRing: true,
    deltas: true,
    valueStep: true,
  };
}

/** One path's state in a session (spec §4.6). */
export interface PathState {
  readonly pop: Population;
  /** The digit-folded twin of `pop`. */
  readonly popF: Population;
  /** Symbols since the path's population last met a symbol new to it. */
  sinceNew: number;
  /** Symbols coded in the path. */
  n: number;
  readonly deltas: PathDeltas;
  /** The path's deltas over the value step's cells. */
  readonly vsDelta: Float64Array;
  readonly values: ValueStep;
  readonly vfeat: ValueState;
  /** Level-evidence scores of the path's levels 1..order, and of its same-offset ring. */
  readonly sn: Float64Array;
  so: number;
  /** The symbols of each distinct past value, by value id. */
  readonly valueSyms: Int32Array[];
}

/**
 * A path's state; `shared`, the message's populations of the path's alphabet, are its own when
 * the path is the message's lone one (session.ts `session`).
 */
export function newPathState(
  o: Resolved,
  shared?: { readonly msg: Population; readonly msgF: Population }
): PathState {
  return {
    pop: shared === undefined ? new Population(o) : shared.msg,
    popF: shared === undefined ? new Population(o) : shared.msgF,
    sinceNew: 0,
    n: 0,
    deltas: new Map(),
    vsDelta: new Float64Array(VSTEP_N),
    values: new ValueStep(o.history, o.quantisation),
    vfeat: valueState(o.history),
    sn: new Float64Array(o.order + 1),
    so: 0,
    valueSyms: [],
  };
}

/** The message-wide state a predictor reads and advances (the session). */
export interface MessageCore {
  readonly ids: Ids;
  readonly features: Features;
  readonly valueFromSecond: boolean;
  /** 1 for every id coded in the message so far. */
  seen: Uint8Array;
  distinct: number;
  /** Symbols since the last boundary symbol. */
  b: number;
  n: number;
  /** The current value's id (−1 before the first) and population. */
  valueId: number;
  valuePop: Population | null;
  valuesStarted: boolean;
  /** Training: told every symbol a predictor takes in (session.ts `SessionOptions.trace`). */
  readonly trace: ((id: number, alphabet: AlphabetKind) => void) | null;
  /**
   * The message's step counter: every predictor's step takes the next number, so a stamp equal
   * to a predictor's current step was written in that step.
   */
  stepNo: number;
  /**
   * The base exponents of the current step by block and feature cell, valid where `memoStamp`
   * holds the step's number; shared by the message's predictors, each reading only what its
   * own step wrote.
   */
  memo: Float64Array;
  memoStamp: Int32Array;
}

/**
 * The confidence map's 24 cell positions as PB shares: 2^16 / (1 + e^−(−8 + 16 i / 23)) rounded,
 * i = 0..23 (the prototype's equal steps of the stretch over [−8, 8]).
 */
export const APM_EDGE = Int32Array.of(
  22,
  44,
  88,
  177,
  353,
  705,
  1398,
  2744,
  5279,
  9793,
  17071,
  27126,
  38410,
  48465,
  55743,
  60257,
  62792,
  64138,
  64831,
  65183,
  65359,
  65448,
  65492,
  65514
);

/** The escape ladder's bands: U+0000–007F, U+0080–07FF, the rest. */
const BAND_LO = [0, 128, 2048];
const BAND_N = [128, 1920, 0x110000 - 2048];
/** The bits of a band that the kernel's escape share charges (the prototype's 7 / 11 / log2 0x110000). */
const BAND_BITS = [7, 11, 21];
const BYTE_BITS = 8;
const STRUCT_BITS = 4;

const P_ONE = POW2[PB];
const LAMBDA_MAX = POW2[24];
const LOGN_MAX = 16 * ONE;
/** log2Fix of the small counts. */
const LOG2_SMALL = new Float64Array(4096);
for (let c = 1; c < LOG2_SMALL.length; c++) {
  LOG2_SMALL[c] = log2Fix(c);
}

function grownI(a: Int32Array, n: number): Int32Array {
  const b = new Int32Array(n);
  b.set(a);
  return b;
}

function grownF(a: Float64Array, n: number): Float64Array {
  const b = new Float64Array(n);
  b.set(a);
  return b;
}

/** The recency bucket of a follower last seen `age` ≥ 1 positions ago: 4 bits of age per bucket, 0..4. */
export function recOf(age: number): number {
  return age < 16 ? 0 : age < 256 ? 1 : age < 4096 ? 2 : age < 65536 ? 3 : 4;
}

/** min(16, log2 n) in RB for n >= 1. */
function lognL(n: number): number {
  return Math.min(LOGN_MAX, log2Fix(n));
}

/** A closed alphabet: its ids in coding order and 1 at each of them. */
export interface Closed {
  readonly ids: Int32Array;
  readonly mask: Uint8Array;
}

/** The closed alphabet of `ids`. */
export function closedOf(ids: Int32Array): Closed {
  let top = 0;
  for (const id of ids) top = Math.max(top, id);
  const mask = new Uint8Array(top + 1);
  for (const id of ids) mask[id] = 1;
  return { ids, mask };
}

/**
 * The symbol predictor of one path and alphabet. A step is `distribution()`, then `write` or
 * `read`, then `learn(a)`; a symbol both sides know is `implied(a)` alone. Code-point ids must be referenced
 * in coding order on both sides: an id is taken with `ids.idOf` only after the step's table is
 * built, as the string coders do.
 */
export class SymbolPredictor {
  /** The coded distribution of the current step. */
  readonly dist = new Distribution();
  /** The current step's votes. */
  readonly log = new VoteLog(256);
  private readonly K: number;
  private readonly text: boolean;
  private off = 0;
  private inValue = false;
  /** The predictor's own closed alphabet (a charset), null when open. */
  private readonly own: Closed | null;
  /** The current step's closed alphabet: the predictor's own, or the step's (spec §6.5). */
  private closed: Int32Array | null = null;
  private inClosed: Uint8Array | null = null;

  // Per-symbol scratch, indexed by id.
  private V: Float64Array = new Float64Array(0);
  private vStamp: Int32Array = new Int32Array(0);
  private pIdx: Int32Array = new Int32Array(0);
  private pN: Int32Array = new Int32Array(0);
  private cStamp: Int32Array = new Int32Array(0);
  private rStamp: Int32Array = new Int32Array(0);
  /**
   * Of a voted id on a text step (valid where `vStamp` is the step): its case partner, and its
   * kernel classes as a sum: 1 for the boundary class, 2 for a digit.
   */
  private kPart: Int32Array = new Int32Array(0);
  private kCls: Int32Array = new Int32Array(0);
  private vList: Int32Array = new Int32Array(64);
  private nv = 0;
  private cand: Int32Array = new Int32Array(64);
  private candP: Float64Array = new Float64Array(64);
  private nc = 0;
  private stepNo = 0;
  private ringNo = 0;
  /**
   * The sources of a shared sweep (`sweepShared`) in log order, and per source its block, extra
   * exponent, level-evidence cell, log-n cell and value-feature flag at the current level.
   */
  private readonly shSrc = new Int32Array(3);
  private readonly shBk = new Int32Array(3);
  private readonly shExtra = new Float64Array(3);
  private readonly shLev = new Int32Array(3);
  private readonly shLi = new Int32Array(3);
  private readonly shTau = new Uint8Array(3);

  private readonly levTerm: Float64Array;
  private readonly levIdx: Int32Array;

  // The current step.
  private allowEnd = true;
  /** The symbol `allowEnd` admits: END, or a structure step's container end. */
  private endSym = END;
  private valuePop: Population | null = null;
  private deltas: PathDeltas | null = null;
  private G = 0;
  private Lesc = 0;
  private pnovIdx = -1;
  private escC = 0;
  private escL = 0;
  private ZL = 0;
  private Zp = 0;
  private lc = 0;
  private lb = 0;
  private ld = 0;
  private Bsum = 0;
  private Dsum = 0;
  private top = -1;
  private apmO = 0;
  private apmFr = 0;
  private readonly kT = new Float64Array(3);
  private readonly digitShare = new Float64Array(10);
  private endShare = 0;
  private nlShare = 0;
  /** Pass A's upper bound on the step's largest vote log-mass. */
  private Mv = -Infinity;

  constructor(
    private readonly core: MessageCore,
    private readonly path: PathState,
    private readonly o: Resolved,
    readonly alphabet: AlphabetKind,
    readonly run: RunPrior,
    private readonly builtin: Frozen | null,
    private readonly msg: Population | null,
    private readonly msgF: Population | null,
    closed: Int32Array | null
  ) {
    this.K = o.order;
    this.own = closed === null ? null : closedOf(closed);
    this.text = alphabet === 'text';
    const cells = NSRC * levels(o.order) * CELLS;
    if (core.memo.length < cells) {
      core.memo = new Float64Array(cells);
      core.memoStamp = new Int32Array(cells);
    }
    this.levTerm = new Float64Array(o.order + 1);
    this.levIdx = new Int32Array(o.order + 1).fill(-1);
  }

  /** The population whose context the message-level features read: the message's, or the path's when separate. */
  context(): Population {
    return this.msg === null ? this.path.pop : this.msg;
  }

  /** Starts a value: offsets count from 0 and the value gets its own population (`Features.tree`). */
  beginValue(): void {
    const c = this.core;
    c.valueId++;
    const node = this.path.pop;
    // A path's first value is, while it is open, the same sequence as the path's population.
    c.valuePop =
      c.features.tree && (!c.valueFromSecond || c.valuesStarted)
        ? node.t === 1
          ? node
          : new Population(this.o)
        : null;
    c.valuesStarted = true;
    this.off = 0;
    this.inValue = true;
  }

  endValue(): void {
    this.core.valuePop = null;
    this.inValue = false;
    this.off = 0;
  }

  /** Grows the per-symbol scratch to hold id `n − 1`. */
  private ensure(n: number): void {
    if (n <= this.V.length) {
      return;
    }
    let size = this.V.length > 0 ? this.V.length : 256;
    while (size < n) {
      size *= 2;
    }
    this.V = grownF(this.V, size);
    this.vStamp = grownI(this.vStamp, size);
    this.pIdx = grownI(this.pIdx, size);
    this.pN = grownI(this.pN, size);
    this.cStamp = grownI(this.cStamp, size);
    this.rStamp = grownI(this.rStamp, size);
    this.kPart = grownI(this.kPart, size);
    this.kCls = grownI(this.kCls, size);
  }

  /** The base exponent of a block at a feature cell, memoised for the step. */
  private base(block: number, cell: number): number {
    const k = block * CELLS + cell;
    const { memo, memoStamp } = this.core;
    if (memoStamp[k] === this.stepNo) {
      return memo[k];
    }
    // exponent(run, block, x, delta): every feature is a small integer times ONE, so each RB
    // product is the exact integer product.
    const h = this.run.hybrid;
    const o = block * HF;
    const u = cell * HF;
    const r = CELL_UNITS[u + 1];
    const fz = CELL_UNITS[u + 2];
    const depth = CELL_UNITS[u + 3];
    const offAg = CELL_UNITS[u + 4];
    const det = CELL_UNITS[u + 5];
    let e =
      h[o] + r * h[o + 1] + fz * h[o + 2] + depth * h[o + 3] + offAg * h[o + 4] + det * h[o + 5];
    const d = this.deltas === null ? undefined : this.deltas.get(block);
    if (d !== undefined) {
      e += d[0] + r * d[1] + fz * d[2] + depth * d[3] + offAg * d[4] + det * d[5];
    }
    memo[k] = e;
    memoStamp[k] = this.stepNo;
    return e;
  }

  /**
   * The votes of the context entry `x` of `tab` at level `k`, written straight into the log. At
   * level 0 a follower votes with its count; above, with its count clamped to its vote one level
   * down (every follower of a deeper entry is in the order-0 entry), and that vote keeps the
   * difference.
   * `cellK` is the cell of rec 0 without offset agreement: rec adds its bucket, agreement 24.
   */
  private levelVotes(
    tab: Entries,
    x: number,
    src: number,
    k: number,
    cellK: number,
    extra: number,
    levI: number,
    li: number,
    ll: number,
    tau: boolean,
    t: number,
    frozen: boolean,
    offOn: boolean
  ): void {
    const log = this.log;
    const count = tab.n[x];
    log.reserve(log.n + count);
    const { pIdx, pN } = this;
    const { memo, memoStamp } = this.core;
    const stepNo = this.stepNo;
    const bk = blockOf(src, k, this.K);
    const memoAt = bk * CELLS;
    const off = this.off;
    const d = tab.data(x);
    const b = tab.base[x];
    const g = log.open(bk, src, k, levI, li, ll, tau);
    const lCell = log.cell;
    const lSym = log.sym;
    const lCount = log.count;
    const lLearn = log.eLearn;
    const lShare = log.share16;
    const lMassL = log.massLearn;
    let i = log.n;
    let maxN = 0;
    let maxL = -Infinity;
    for (let j = 0; j < count; j++) {
      const o = b + j * STRIDE;
      const s = d[o];
      const c = d[o + 1];
      let n = c;
      if (k > 0) {
        n = c < pN[s] ? c : pN[s];
        lCount[pIdx[s]] -= n;
      }
      let cell = cellK;
      if (!frozen) {
        cell += recOf(t - d[o + 2]);
        if (offOn && d[o + 3] === off) cell += 24;
      }
      const mk = memoAt + cell;
      const eL = (memoStamp[mk] === stepNo ? memo[mk] : this.base(bk, cell)) + extra;
      lCell[i] = cell;
      lSym[i] = s;
      lCount[i] = n;
      lLearn[i] = eL;
      if (n > maxN) maxN = n;
      if (eL > maxL) maxL = eL;
      lShare[i] = P_ONE;
      lMassL[i] = 0;
      pIdx[s] = i;
      pN[s] = n;
      i++;
    }
    log.n = i;
    log.end[g] = i;
    if (maxN >= 1) {
      // Counts only fall after they are written, so this bounds every vote of the segment.
      const lc = maxN < LOG2_SMALL.length ? LOG2_SMALL[maxN] : log2Fix(maxN);
      this.noteM(lc + maxL);
    }
  }

  /**
   * One population's votes, levels 0..m. A symbol votes at level k with n_k = its count clamped
   * to its count at the level it last voted at; that earlier vote's count becomes n_prev − n_k, so
   * every vote carries its exact-level count. Long candidates then move one vote each from the
   * deepest level to their length bucket.
   */
  private sweep(src: number, tab: Entries, E: Int32Array, m: number, pop: Population | null): void {
    if (m < 0) {
      return;
    }
    const K = this.K;
    const f = this.core.features;
    const log = this.log;
    const frozen = pop === null;
    const isNode = src === SRC.node;
    const t = frozen ? 0 : pop.t;
    const b = this.core.b;
    const off = this.off;
    const { pIdx } = this;
    const n0 = tab.n[E[0]];
    const cell0 = cellOf(0, frozen, 0, 0, dist(n0));
    this.levelVotes(tab, E[0], src, 0, cell0, 0, -1, -1, 0, false, t, frozen, false);
    const depthOn = f.depth;
    const offOn = f.offsetAgreement && !frozen;
    const G = isNode ? this.G : 0;
    for (let k = 1; k <= m; k++) {
      const x = E[k];
      const total = tab.total[x];
      const depth = anchorDepth(k, b, off, Infinity, depthOn);
      const li = frozen ? -1 : src * (K + 1) + k;
      const ll = frozen ? 0 : lognL(total > 1 ? total : 1);
      const extra =
        G + (isNode ? this.levTerm[k] : 0) + (frozen ? 0 : lognTerm(this.run.logn[li], total));
      const levI = isNode ? this.levIdx[k] : -1;
      const cellK = cellOf(0, frozen, depth, 0, dist(tab.n[x]));
      this.levelVotes(tab, x, src, k, cellK, extra, levI, li, ll, isNode, t, frozen, offOn);
    }
    if (frozen || m !== K || pop.nc === 0) {
      return;
    }
    const totalK = tab.total[E[K]];
    const detK = dist(tab.n[E[K]]);
    const liK = src * (K + 1) + K;
    const llK = lognL(totalK > 1 ? totalK : 1);
    const extraK = G + (isNode ? this.levTerm[K] : 0) + lognTerm(this.run.logn[liK], totalK);
    const levK = isNode ? this.levIdx[K] : -1;
    for (let c = 0; c < pop.nc; c++) {
      const L = pop.candL[c];
      if (L <= K) {
        continue;
      }
      const p = pop.cand[c];
      const s = pop.seq[p];
      if (log.count[pIdx[s]] < 1) {
        continue;
      }
      log.count[pIdx[s]] -= 1;
      const lb = longBucket(L, K);
      const offAg = offOn && pop.offs[p] === off ? 1 : 0;
      const depth = anchorDepth(L, b, off, Infinity, depthOn);
      const block = blockOf(src, lb, K);
      const cell = cellOf(recOf(t - p), false, depth, offAg, detK);
      const eL = this.base(block, cell) + extraK;
      this.noteM(eL);
      log.push(block, cell, s, 1, eL, P_ONE, src, lb, levK, liK, llK, isNode);
    }
  }

  /**
   * The votes of the context entry `x` at level `k` for the first `nr` sources of `shSrc`, whose
   * populations are one (a lone path's, session.ts `session`): each follower is read once and
   * votes in every source's segment. The segments lie back to back in source order, each in the
   * entry's order, so a source's vote of the follower at `pIdx[s]` one level down sits `r` entry
   * counts of that level (`prev`) further on. Otherwise as `levelVotes` on a live population,
   * without offset agreement: the lone path's population holds one value, coded at offsets that
   * only grow, so no past position sits at the current offset.
   */
  private levelVotesShared(
    tab: Entries,
    x: number,
    nr: number,
    k: number,
    prev: number,
    cellK: number,
    ll: number,
    t: number
  ): void {
    const log = this.log;
    const count = tab.n[x];
    const i0 = log.n;
    log.reserve(i0 + nr * count);
    const { pIdx, pN, shBk, shExtra } = this;
    const { memo, memoStamp } = this.core;
    const stepNo = this.stepNo;
    const d = tab.data(x);
    const b = tab.base[x];
    for (let r = 0; r < nr; r++) {
      const g = log.open(
        shBk[r],
        this.shSrc[r],
        k,
        this.shLev[r],
        this.shLi[r],
        ll,
        this.shTau[r] === 1
      );
      log.start[g] = i0 + r * count;
      log.end[g] = i0 + (r + 1) * count;
    }
    const lCell = log.cell;
    const lSym = log.sym;
    const lCount = log.count;
    const lLearn = log.eLearn;
    const lShare = log.share16;
    const lMassL = log.massLearn;
    const three = nr === 3;
    const bk0 = shBk[0];
    const bk1 = shBk[1];
    const bk2 = shBk[2];
    const m0 = bk0 * CELLS;
    const m1 = bk1 * CELLS;
    const m2 = bk2 * CELLS;
    const x0 = shExtra[0];
    const x1 = shExtra[1];
    const x2 = shExtra[2];
    const i1 = i0 + count;
    const i2 = i1 + count;
    let max0 = -Infinity;
    let max1 = -Infinity;
    let max2 = -Infinity;
    let maxN = 0;
    for (let j = 0; j < count; j++) {
      const o = b + j * STRIDE;
      const s = d[o];
      const c = d[o + 1];
      let n = c;
      if (k > 0) {
        n = c < pN[s] ? c : pN[s];
        const p = pIdx[s];
        lCount[p] -= n;
        lCount[p + prev] -= n;
        if (three) lCount[p + 2 * prev] -= n;
      }
      const cell = cellK + recOf(t - d[o + 2]);
      if (n > maxN) maxN = n;
      const e0 = (memoStamp[m0 + cell] === stepNo ? memo[m0 + cell] : this.base(bk0, cell)) + x0;
      const e1 = (memoStamp[m1 + cell] === stepNo ? memo[m1 + cell] : this.base(bk1, cell)) + x1;
      if (e0 > max0) max0 = e0;
      if (e1 > max1) max1 = e1;
      let i = i0 + j;
      lCell[i] = cell;
      lSym[i] = s;
      lCount[i] = n;
      lLearn[i] = e0;
      lShare[i] = P_ONE;
      lMassL[i] = 0;
      i = i1 + j;
      lCell[i] = cell;
      lSym[i] = s;
      lCount[i] = n;
      lLearn[i] = e1;
      lShare[i] = P_ONE;
      lMassL[i] = 0;
      if (three) {
        const e2 = (memoStamp[m2 + cell] === stepNo ? memo[m2 + cell] : this.base(bk2, cell)) + x2;
        if (e2 > max2) max2 = e2;
        i = i2 + j;
        lCell[i] = cell;
        lSym[i] = s;
        lCount[i] = n;
        lLearn[i] = e2;
        lShare[i] = P_ONE;
        lMassL[i] = 0;
      }
      pIdx[s] = i0 + j;
      pN[s] = n;
    }
    log.n = i0 + nr * count;
    if (maxN >= 1) {
      const lc = maxN < LOG2_SMALL.length ? LOG2_SMALL[maxN] : log2Fix(maxN);
      const maxL = max0 > max1 ? (max0 > max2 ? max0 : max2) : max1 > max2 ? max1 : max2;
      this.noteM(lc + maxL);
    }
  }

  /**
   * `sweep` of the first `nr` sources of `shSrc` over their one live population `pop`: every
   * entry is read once (`levelVotesShared`, which also says why no vote takes offset agreement);
   * the long candidates then vote per source.
   */
  private sweepShared(nr: number, pop: Population): void {
    const m = pop.m;
    if (m < 0) {
      return;
    }
    const tab = pop.tab;
    const E = pop.E;
    const K = this.K;
    const f = this.core.features;
    const log = this.log;
    const t = pop.t;
    const b = this.core.b;
    const off = this.off;
    const { shSrc, shBk, shExtra, shLev, shLi, shTau } = this;
    for (let r = 0; r < nr; r++) {
      shBk[r] = blockOf(shSrc[r], 0, K);
      shExtra[r] = 0;
      shLev[r] = -1;
      shLi[r] = -1;
      shTau[r] = 0;
    }
    const cell0 = cellOf(0, false, 0, 0, dist(tab.n[E[0]]));
    this.levelVotesShared(tab, E[0], nr, 0, 0, cell0, 0, t);
    const depthOn = f.depth;
    for (let k = 1; k <= m; k++) {
      const x = E[k];
      const total = tab.total[x];
      const depth = anchorDepth(k, b, off, Infinity, depthOn);
      const ll = lognL(total > 1 ? total : 1);
      for (let r = 0; r < nr; r++) {
        const src = shSrc[r];
        const isNode = src === SRC.node;
        const li = src * (K + 1) + k;
        shBk[r] = blockOf(src, k, K);
        shLi[r] = li;
        shExtra[r] = (isNode ? this.G + this.levTerm[k] : 0) + lognTerm(this.run.logn[li], total);
        shLev[r] = isNode ? this.levIdx[k] : -1;
        shTau[r] = isNode ? 1 : 0;
      }
      const cellK = cellOf(0, false, depth, 0, dist(tab.n[x]));
      this.levelVotesShared(tab, x, nr, k, tab.n[E[k - 1]], cellK, ll, t);
    }
    if (m !== K || pop.nc === 0) {
      return;
    }
    const totalK = tab.total[E[K]];
    const countK = tab.n[E[K]];
    const detK = dist(countK);
    const llK = lognL(totalK > 1 ? totalK : 1);
    const { pIdx } = this;
    for (let r = 0; r < nr; r++) {
      const src = shSrc[r];
      const isNode = src === SRC.node;
      const liK = src * (K + 1) + K;
      const extraK = (isNode ? this.G + this.levTerm[K] : 0) + lognTerm(this.run.logn[liK], totalK);
      const levK = isNode ? this.levIdx[K] : -1;
      const at = r * countK;
      for (let c = 0; c < pop.nc; c++) {
        const L = pop.candL[c];
        if (L <= K) {
          continue;
        }
        const p = pop.cand[c];
        const s = pop.seq[p];
        const i = pIdx[s] + at;
        if (log.count[i] < 1) {
          continue;
        }
        log.count[i] -= 1;
        const lb = longBucket(L, K);
        const depth = anchorDepth(L, b, off, Infinity, depthOn);
        const block = blockOf(src, lb, K);
        const cell = cellOf(recOf(t - p), false, depth, 0, detK);
        const eL = this.base(block, cell) + extraK;
        this.noteM(eL);
        log.push(block, cell, s, 1, eL, P_ONE, src, lb, levK, liK, llK, isNode);
      }
    }
  }

  /** The path's same-offset ring votes (source 7 blocks) with the ring's own evidence and log-n. */
  private ringVotes(node: Population): void {
    const r = node.offRing.get(this.off);
    if (r === undefined) {
      return;
    }
    const K = this.K;
    const seq = node.seq;
    const st = ++this.ringNo;
    let distinct = 0;
    for (let i = 0; i < r.len; i++) {
      const s = seq[r.at(i)];
      if (this.rStamp[s] !== st) {
        this.rStamp[s] = st;
        distinct++;
      }
    }
    const det = detBucket(distinct);
    const f = this.core.features;
    let levI = -1;
    let lev = 0;
    if (f.levelEvidence) {
      const bk = levBucket(this.path.so);
      if (bk !== 2) {
        levI = bk;
        lev = this.run.lev[bk];
      }
    }
    const li = NSRC * (K + 1);
    const ll = lognL(r.len);
    const ln = lognTerm(this.run.logn[li], r.len);
    const t = node.t;
    for (let i = 0; i < r.len; i++) {
      const p = r.at(i);
      const L = node.agreement(p);
      const lb = L <= K ? L : longBucket(L, K);
      const depth = anchorDepth(L, this.core.b, this.off, Infinity, f.depth);
      const block = blockOf(SRC.sticky, lb, K);
      const deep = lb >= 1;
      const cell = cellOf(recOf(t - p), false, depth, 1, det);
      const eL = this.base(block, cell) + (deep ? this.G : 0) + lev + ln;
      this.noteM(eL);
      this.log.push(block, cell, seq[p], 1, eL, P_ONE, SRC.node, lb, levI, li, ll, deep);
    }
  }

  /** The message's recently broken matches (source 7 blocks): one vote per distance. */
  private mruVotes(pop: Population, src: number): void {
    const K = this.K;
    const t = pop.t;
    const depthOn = this.core.features.depth;
    for (const d of pop.mru) {
      const p = t - d;
      if (pop.mLen >= K && p === pop.mPos) {
        continue;
      }
      const L = pop.agreement(p);
      const lb = L <= K ? L : longBucket(L, K);
      const depth = anchorDepth(L, this.core.b, this.off, Infinity, depthOn);
      const block = blockOf(SRC.sticky, lb, K);
      const cell = cellOf(recOf(d), false, depth, 0, 0);
      const eL = this.base(block, cell);
      this.noteM(eL);
      this.log.push(block, cell, pop.seq[p], 1, eL, P_ONE, src, lb, -1, -1, 0, false);
    }
  }

  /** Notes the log-mass of a vote, or a bound of a segment's, in pass A's bound `Mv`. */
  private noteM(e: number): void {
    if (e > this.Mv) this.Mv = e;
  }

  private addV(s: number, m: number): void {
    if (this.vStamp[s] !== this.stepNo) {
      this.vStamp[s] = this.stepNo;
      this.V[s] = 0;
      if (this.nv === this.vList.length) {
        this.vList = grownI(this.vList, this.nv * 2);
      }
      this.vList[this.nv++] = s;
    }
    this.V[s] += m;
  }

  private vOf(s: number): number {
    return this.vStamp[s] === this.stepNo ? this.V[s] : 0;
  }

  /** Whether `id` can be an entry of this alphabet's distribution at this step. */
  private member(id: number): boolean {
    if (id === this.endSym) {
      return this.allowEnd;
    }
    if (id === END) {
      return false;
    }
    if (this.inClosed !== null) {
      return id < this.inClosed.length && this.inClosed[id] === 1;
    }
    if (this.alphabet === 'text') {
      return id >= CP_BASE;
    }
    if (this.alphabet === 'bytes') {
      return id >= BYTE_BASE && id < CP_BASE;
    }
    return id < DIGIT;
  }

  /** Adds `id` to the step's candidates once when it is a member; returns whether it is. */
  private addCand(id: number): boolean {
    if (!this.member(id)) {
      return false;
    }
    this.ensure(id + 1);
    if (this.cStamp[id] === this.stepNo) {
      return true;
    }
    this.cStamp[id] = this.stepNo;
    if (this.nc === this.cand.length) {
      this.cand = grownI(this.cand, this.nc * 2);
      this.candP = grownF(this.candP, this.nc * 2);
    }
    this.cand[this.nc++] = id;
    return true;
  }

  /** The kernel-smeared mass of symbol `s` (spec §5.4); text only. */
  private smear(s: number): number {
    const ids = this.core.ids;
    let P = 0;
    let p: number;
    let cls: number;
    if (this.vStamp[s] === this.stepNo) {
      P = this.V[s];
      p = this.kPart[s];
      cls = this.kCls[s];
    } else {
      p = ids.partner(s);
      cls = (ids.isBoundaryClass(s) ? 1 : 0) + (ids.isDigit(s) ? 2 : 0);
    }
    if (p >= 0) {
      P += mulShr(this.vOf(p), this.lc, 24);
    }
    if (cls === 1 || cls === 3) {
      P += mulShr(this.Bsum - this.vOf(s), this.lb, 24);
    }
    if (cls >= 2) {
      P += mulShr(this.Dsum - this.vOf(s), this.ld, 24);
    }
    return P;
  }

  /**
   * Members of the alphabet allowed at this step, in id order (a closed alphabet's in its own
   * order). A structure step bounding a container end that may not come yet leaves that end out;
   * a step's closed alphabet holds the end exactly when it may come.
   */
  private memberCount(): number {
    if (this.closed !== null) {
      return this.closed.length + (this.endSym === END && this.allowEnd ? 1 : 0);
    }
    const size = this.alphabet === 'bytes' ? 256 : DIGIT - 1;
    const e = this.endSym === END ? (this.allowEnd ? 1 : 0) : this.allowEnd ? 0 : -1;
    return size + e;
  }

  private memberAt(k: number): number {
    const e = this.allowEnd && this.endSym === END ? 1 : 0;
    if (k < e) {
      return END;
    }
    if (this.closed !== null) {
      return this.closed[k - e];
    }
    if (this.alphabet === 'bytes') {
      return BYTE_BASE + k - e;
    }
    const id = k + 1 - e;
    return !this.allowEnd && this.endSym !== END && id >= this.endSym ? id + 1 : id;
  }

  /**
   * Builds the step's distribution (spec §4.4 steps 1–6). `endSym` (END unless a structure step
   * bounds a container's end) is an entry only when `allowEnd`; END is none when `endSym` is
   * another symbol. `only` closes the step's alphabet to its members where the predictor's own
   * alphabet is open (a declared node's structure symbols). The table depends on the shared past
   * alone.
   */
  distribution(allowEnd = true, endSym = END, only: Closed | null = null): Distribution {
    const core = this.core;
    const f = core.features;
    const ids = core.ids;
    const run = this.run;
    const K = this.K;
    const path = this.path;
    const node = path.pop;
    const nodeF = path.popF;
    const msg = this.msg;
    const msgF = this.msgF;
    const value = core.valuePop;
    this.ensure(ids.size());
    // A lone path's populations are the message's: each resolves once.
    if (msg !== null) msg.resolve();
    if (node !== msg) node.resolve();
    if (msgF !== null) msgF.resolve();
    if (nodeF !== msgF) nodeF.resolve();
    if (value !== null && value !== node) value.resolve();
    const ctx = msg === null ? node : msg;
    const B = this.builtin;
    if (B !== null) B.lookup(ctx.h, ctx.n);
    this.stepNo = ++core.stepNo;
    this.allowEnd = allowEnd;
    this.endSym = endSym;
    const closed = only ?? this.own;
    this.closed = closed === null ? null : closed.ids;
    this.inClosed = closed === null ? null : closed.mask;
    this.valuePop = value;
    const log = this.log;
    log.reset();
    this.nv = 0;

    // Position features.
    this.G = 0;
    if (f.valueFeatures) {
      const vx = valueFeatures(path.vfeat, this.off, this.inValue ? core.valueId : -1);
      for (let i = 0; i < 5; i++) {
        log.vx[i] = vx[i];
        this.G += vx[i] * run.vfeat[i];
      }
    }
    this.deltas = f.deltas ? path.deltas : null;
    if (f.levelEvidence) {
      for (let k = 1; k <= K; k++) {
        const bk = levBucket(path.sn[k]);
        this.levIdx[k] = bk === 2 ? -1 : bk;
        this.levTerm[k] = bk === 2 ? 0 : run.lev[bk];
      }
    }
    const digits = ids.digitIds();
    const nl = ids.newlineId();
    const t0 = ctx.tab;
    let dsum = 10;
    for (let d = 0; d < 10; d++) dsum += t0.count(0, digits[d]);
    for (let d = 0; d < 10; d++)
      this.digitShare[d] = div((1 + t0.count(0, digits[d])) * P_ONE, dsum);
    const cE = t0.count(0, END);
    const cN = t0.count(0, nl);
    this.endShare = div((1 + cE) * P_ONE, 2 + cE + cN);
    this.nlShare = div((1 + cN) * P_ONE, 2 + cE + cN);

    // Pass A.
    this.Mv = -Infinity;
    // A lone path's populations are the message's, and its first value's population is the
    // path's: the sources of one population read its entries once, in a shared sweep. Pass B and
    // learning sum each vote's integers, so the order of segments leaves them unchanged, and the
    // message's level-0 votes still come first, so pass B meets the symbols in the same order.
    const shs = this.shSrc;
    let valueShared = false;
    if (msg !== null && node === msg) {
      shs[0] = SRC.msg;
      shs[1] = SRC.node;
      valueShared = value === node;
      if (valueShared) shs[2] = SRC.value;
      this.sweepShared(valueShared ? 3 : 2, msg);
      this.mruVotes(msg, SRC.msg);
    } else {
      if (msg !== null) {
        this.sweep(SRC.msg, msg.tab, msg.E, msg.m, msg);
        this.mruVotes(msg, SRC.msg);
      }
      this.sweep(SRC.node, node.tab, node.E, node.m, node);
      if (msg === null) this.mruVotes(node, SRC.node);
    }
    if (f.offsetRing) this.ringVotes(node);
    if (B !== null) this.sweep(SRC.builtin, B.tab, B.E, B.m, null);
    if (msgF !== null && nodeF === msgF) {
      shs[0] = SRC.msgF;
      shs[1] = SRC.nodeF;
      this.sweepShared(2, msgF);
    } else {
      if (msgF !== null) this.sweep(SRC.msgF, msgF.tab, msgF.E, msgF.m, msgF);
      this.sweep(SRC.nodeF, nodeF.tab, nodeF.E, nodeF.m, nodeF);
    }
    if (value !== null && !valueShared) this.sweep(SRC.value, value.tab, value.E, value.m, value);

    // The escape's log-mass.
    let Lesc = run.escape + log2Fix(core.distinct + 1);
    this.pnovIdx = -1;
    if (f.pathNovelty) {
      const n0 = node.tab.n[0];
      this.pnovIdx =
        Math.min(7, bitlen(path.sinceNew + 1) - 1) * 4 +
        (n0 <= 4 ? 0 : n0 <= 16 ? 1 : n0 <= 64 ? 2 : 3);
      Lesc += run.pnov[this.pnovIdx];
    }
    this.Lesc = Lesc;

    // One block scale for the coded and the learning side, from a bound on the largest log-mass
    // (spec §5.3): pass A's per-segment maxima of log2Fix(count) and of the exponents, and the
    // escape's.
    const MSGF = SRC.msgF;
    const NODEF = SRC.nodeF;
    const M = Lesc > this.Mv ? Lesc : this.Mv;

    // Pass B. A vote's mass is floor(count * 2^((e + off) / ONE)). M takes log2Fix(count), which
    // both tables' floors keep below log2 count by less than log2(1 + 2^-12) + 2^-24, so a mass
    // exceeds 2^((M + off) / ONE) by a factor below 1 + 2^-11, and one bit of headroom keeps every
    // mass below 2^SB. The bit costs no precision: the coded side shifts the masses down to HB bits
    // (bitlen(vmax) - HB) and the learning side does too (learn's s), and HB < SB - 1.
    const off = (SB - 1) * ONE - M;
    let ZL = 0;
    for (let g = 0; g < log.segs; g++) {
      const src = log.src[g];
      const folded = src === MSGF || src === NODEF;
      const end = log.end[g];
      for (let i = log.start[g]; i < end; i++) {
        const c = log.count[i];
        if (c < 1) continue;
        const el = log.eLearn[i];
        const ml = linMass(c, el + off);
        log.massLearn[i] = ml;
        ZL += ml;
        const s = log.sym[i];
        if (folded && (s === DIGIT || s === nl)) {
          if (s === DIGIT) {
            for (let d = 0; d < 10; d++) this.addV(digits[d], mulShr(ml, this.digitShare[d], PB));
          } else {
            this.addV(END, mulShr(ml, this.endShare, PB));
            this.addV(nl, mulShr(ml, this.nlShare, PB));
          }
        } else {
          this.addV(s, ml);
        }
      }
    }
    this.ZL = ZL;
    this.escL = Math.max(1, exp2Fix(Lesc + off));
    let escC = this.escL;
    let vmax = escC;
    for (let i = 0; i < this.nv; i++) {
      const v = this.V[this.vList[i]];
      if (v > vmax) vmax = v;
    }
    const sh = bitlen(vmax) - HB;
    if (sh > 0) {
      for (let i = 0; i < this.nv; i++) {
        const s = this.vList[i];
        this.V[s] = shr(this.V[s], sh);
      }
      escC = Math.max(1, shr(escC, sh));
    }
    this.escC = escC;

    // The table: candidates, the kernel smear, quantisation, the confidence map.
    this.nc = 0;
    let anyB = false;
    let anyD = false;
    let Bsum = 0;
    let Dsum = 0;
    this.kT.fill(0);
    if (this.text) {
      const kn = run.kernel;
      this.lc = Math.min(LAMBDA_MAX, exp2Fix(kn[0] + 24 * ONE));
      this.lb = Math.min(LAMBDA_MAX, exp2Fix(kn[1] + 24 * ONE));
      this.ld = Math.min(LAMBDA_MAX, exp2Fix(kn[2] + 24 * ONE));
    }
    // The top symbol is the member of largest mass, the lowest id among equals.
    let top = -1;
    let tv = 0;
    for (let i = 0; i < this.nv; i++) {
      const t = this.vList[i];
      const v = this.V[t];
      if (this.addCand(t) && (v > tv || (v === tv && top >= 0 && t < top))) {
        top = t;
        tv = v;
      }
      if (!this.text) continue;
      const p = ids.partner(t);
      const bc = ids.isBoundaryClass(t);
      const dg = ids.isDigit(t);
      this.kPart[t] = p;
      this.kCls[t] = (bc ? 1 : 0) + (dg ? 2 : 0);
      if (p >= 0) {
        this.addCand(p);
        this.kT[0] += mulShr(v, this.lc, 24);
      }
      if (bc) {
        anyB = true;
        Bsum += v;
        this.kT[1] += 2 * mulShr(v, this.lb, 24);
      }
      if (dg) {
        anyD = true;
        Dsum += v;
        this.kT[2] += 9 * mulShr(v, this.ld, 24);
      }
    }
    this.Bsum = Bsum;
    this.Dsum = Dsum;
    if (anyB) {
      const bnd = ids.boundaryIds();
      for (let i = 0; i < 3; i++) this.addCand(bnd[i]);
    }
    if (anyD) {
      for (let d = 0; d < 10; d++) this.addCand(digits[d]);
    }
    let Zp = escC;
    for (let i = 0; i < this.nc; i++) {
      const s = this.cand[i];
      const P = this.text ? this.smear(s) : this.vOf(s);
      this.candP[i] = P;
      Zp += P;
    }
    this.Zp = Zp;

    this.top = top;

    const total = this.o.quantisation;
    let hasEscape = (this.text && this.closed === null) || this.nc < this.memberCount();
    let escMass = escC;
    let dropped: Uint8Array | null = null;
    // A dropped candidate is coded through the escape, so a drop on a closed alphabet whose
    // every member voted opens one.
    let over = this.nc + (hasEscape ? 1 : 0) - div(total, 2);
    if (over > 0) {
      if (!hasEscape) {
        hasEscape = true;
        over++;
      }
      dropped = new Uint8Array(this.nc);
      escMass += this.dropSmallest(over, dropped, top);
    }
    const d = this.dist;
    d.begin(total, hasEscape);
    for (let i = 0; i < this.nc; i++) {
      if (dropped === null || dropped[i] === 0) d.add(this.cand[i], this.candP[i]);
    }
    d.finish(escMass);

    if (top >= 0) {
      const cm = ctx.m;
      const row = (cm < 0 ? 0 : dist(ctx.tab.n[ctx.E[cm]])) * (K + 1) + (cm < 0 ? 0 : cm);
      const s16 = div(shl(tv, PB), Zp);
      let i = 0;
      while (i < APM_B - 2 && APM_EDGE[i + 1] <= s16) i++;
      const fr = clampi(div(shl(s16 - APM_EDGE[i], RB), APM_EDGE[i + 1] - APM_EDGE[i]), 0, ONE);
      const o = row * APM_B + i;
      this.apmO = o;
      this.apmFr = fr;
      d.rescaleTop(d.indexOf(top), shr(s16 + 3 * apmShare(run, o, fr), 2));
    }
    return d;
  }

  /**
   * The drop rule (spec §5.5): the `k` candidates of smallest mass, the highest id first among
   * equals, leave the table and their mass joins the escape; END and the top symbol never leave.
   */
  private dropSmallest(k: number, dropped: Uint8Array, top: number): number {
    const order: number[] = [];
    for (let i = 0; i < this.nc; i++) {
      if (this.cand[i] !== END && this.cand[i] !== top) order.push(i);
    }
    const P = this.candP;
    const c = this.cand;
    order.sort((x, y) => (P[x] !== P[y] ? P[x] - P[y] : c[y] - c[x]));
    let mass = 0;
    for (let i = 0; i < k; i++) {
      dropped[order[i]] = 1;
      mass += P[order[i]];
    }
    return mass;
  }

  /** Writes symbol `a` under the current step's table, its escape body when it has no entry. */
  write(enc: Sink, a: number): void {
    const d = this.dist;
    let i = d.indexOf(a);
    if (i < 0) {
      if (!d.hasEscape || !this.member(a)) {
        throw new RangeError(`symbol ${a} is not in the ${this.alphabet} alphabet`);
      }
      i = d.n - 1;
    }
    enc.composeWeighted(d.cum(i), d.freq(i), d.total);
    if (d.hasEscape && i === d.n - 1) {
      if (this.text && this.closed === null) {
        const cp = this.core.ids.cpOf(a);
        const band = cp < 128 ? 0 : cp < 2048 ? 1 : 2;
        const lad = this.run.loaded.constants.ladder;
        enc.composeWeighted(
          band === 0 ? 0 : band === 1 ? lad[0] : lad[0] + lad[1],
          lad[band],
          lad[0] + lad[1] + lad[2]
        );
        enc.compose(cp - BAND_LO[band], BAND_N[band]);
      } else {
        let r = 0;
        const count = this.memberCount();
        for (let k = 0; k < count; k++) {
          const m = this.memberAt(k);
          if (m === a) break;
          if (d.indexOf(m) < 0) r++;
        }
        enc.compose(r, count - d.n + 1);
      }
    }
  }

  /** Reads a symbol under the current step's table. */
  read(dec: Source): number {
    const d = this.dist;
    const i = dec.parseMember(d.total, d);
    if (!d.hasEscape || i !== d.n - 1) {
      return d.idAt(i);
    }
    if (this.text && this.closed === null) {
      const lad = this.run.loaded.constants.ladder;
      const band = dec.parseMember(lad[0] + lad[1] + lad[2], {
        locate: (r) => (r < lad[0] ? 0 : r < lad[0] + lad[1] ? 1 : 2),
        cum: (b) => (b === 0 ? 0 : b === 1 ? lad[0] : lad[0] + lad[1]),
        freq: (b) => lad[b],
      });
      return this.core.ids.idOf(dec.parse(BAND_N[band]) + BAND_LO[band]);
    }
    const count = this.memberCount();
    let r = dec.parse(count - d.n + 1);
    let k = 0;
    for (; ; k++) {
      if (d.indexOf(this.memberAt(k)) < 0 && r-- === 0) break;
    }
    return this.memberAt(k);
  }

  /** The escape share's ladder bits for symbol `a`. */
  private ladderBits(a: number): number {
    if (this.closed !== null) {
      return bitlen(this.closed.length);
    }
    if (!this.text) {
      return this.alphabet === 'bytes' ? BYTE_BITS : STRUCT_BITS;
    }
    const cp = this.core.ids.cpOf(a);
    return BAND_BITS[cp < 128 ? 0 : cp < 2048 ? 1 : 2];
  }

  /** Learns from coded symbol `a` and moves every population past it (spec §4.4 step 8). */
  learn(a: number): void {
    const core = this.core;
    const f = core.features;
    const ids = core.ids;
    const log = this.log;
    const run = this.run;
    const path = this.path;
    const node = path.pop;
    const B = this.builtin;
    const seen = a < core.seen.length && core.seen[a] === 1;
    const novel = !seen && !(B !== null && B.tab.has(0, a));
    const af = ids.foldDigit(a);
    log.af = af === a ? -1 : af;
    if (af === DIGIT || af === ids.newlineId()) {
      const share =
        af === DIGIT
          ? this.digitShare[ids.cpOf(a) - 0x30]
          : a === END
            ? this.endShare
            : this.nlShare;
      for (let g = 0; g < log.segs; g++) {
        const src = log.src[g];
        if (src !== SRC.msgF && src !== SRC.nodeF) continue;
        const end = log.end[g];
        for (let i = log.start[g]; i < end; i++) {
          if (log.sym[i] === af) log.share16[i] = share;
        }
      }
    }
    let Sa = 0;
    for (let g = 0; g < log.segs; g++) {
      const src = log.src[g];
      const want = src === SRC.msgF || src === SRC.nodeF ? af : a;
      const end = log.end[g];
      for (let i = log.start[g]; i < end; i++) {
        if (log.sym[i] === want) {
          Sa += mulShr(log.massLearn[i], log.share16[i], PB);
        }
      }
    }
    if (novel) Sa += this.escL;
    log.novel = novel;
    log.eEsc = this.Lesc;
    log.massEsc = this.escL;
    log.pnovIndex = this.pnovIdx;

    // The kernel side.
    const ladder = this.ladderBits(a);
    let Pa = novel ? shr(this.escC, ladder) : 0;
    const p = ids.partner(a);
    this.ensure(ids.size());
    if (this.text) {
      Pa += this.smear(a);
      log.kernelA[0] = p >= 0 ? mulShr(this.vOf(p), this.lc, 24) : 0;
      log.kernelA[1] = ids.isBoundaryClass(a) ? mulShr(this.Bsum - this.vOf(a), this.lb, 24) : 0;
      log.kernelA[2] = ids.isDigit(a) ? mulShr(this.Dsum - this.vOf(a), this.ld, 24) : 0;
      log.kernelT.set(this.kT);
    } else {
      Pa += this.vOf(a);
    }
    log.kernelPa = Pa;
    log.kernelZ = this.Zp;
    learn(run, log, Sa, this.ZL + this.escL, a, this.deltas, path.n);
    if (this.top >= 0) apmUpdate(run, this.apmO, this.apmFr, a === this.top ? P_ONE : 0);

    if (f.levelEvidence) {
      const tab = node.tab;
      for (let k = 1; k <= node.m; k++)
        path.sn[k] = decayedMean(path.sn[k], shadowCost(tab, node.E[k], a));
      const r = node.offRing.get(this.off);
      if (r !== undefined) {
        let c = 0;
        for (let i = 0; i < r.len; i++) if (node.seq[r.at(i)] === a) c++;
        path.so = decayedMean(path.so, shadowCostOf(tab, a, c, r.len));
      }
    }
    this.advance(a);
  }

  /**
   * Moves the state both sides keep in step past `a`: the seen set, every population, the value
   * features and the counters. Nothing here reads the step's votes.
   */
  private advance(a: number): void {
    const core = this.core;
    if (core.trace !== null) core.trace(a, this.alphabet);
    const ids = core.ids;
    const path = this.path;
    const node = path.pop;
    if (!(a < core.seen.length && core.seen[a] === 1)) {
      if (a >= core.seen.length) {
        const s = new Uint8Array(Math.max(a + 1, core.seen.length * 2));
        s.set(core.seen);
        core.seen = s;
      }
      core.seen[a] = 1;
      core.distinct++;
    }
    const off = this.off;
    const af = ids.foldDigit(a);
    path.sinceNew = node.tab.has(0, a) ? path.sinceNew + 1 : 0;
    if (this.msg !== null) this.msg.update(a, off);
    if (node !== this.msg) node.update(a, off);
    if (this.msgF !== null) this.msgF.update(af, off);
    if (path.popF !== this.msgF) path.popF.update(af, off);
    if (this.valuePop !== null && this.valuePop !== node) this.valuePop.update(a, off);
    core.b = ids.isBoundary(a) ? 0 : core.b + 1;
    core.n++;
    if (core.features.valueFeatures) valueAdvance(path.vfeat, a, off);
    path.n++;
    if (this.inValue) this.off++;
  }

  /** One coded step: the table, the symbol and its learning. */
  code(enc: Sink, a: number, allowEnd = true, endSym = END, only: Closed | null = null): void {
    this.distribution(allowEnd, endSym, only);
    if (allowEnd && a !== endSym) enc.open();
    this.write(enc, a);
    this.learn(a);
  }

  /** One read step. */
  decode(dec: Source, allowEnd = true, endSym = END, only: Closed | null = null): number {
    const idle = dec.idle;
    this.distribution(allowEnd, endSym, only);
    const a = this.read(dec);
    // Past the input, a read that leaves the state as it was carries nothing: a valid message
    // never spends such a read on anything but the end here (see `Encoder.toDigits`).
    if (allowEnd && a !== endSym && idle >= 0n && dec.idle === idle) {
      throw new CorruptInputError('Input ran out inside a value that only its end may close');
    }
    this.learn(a);
    return a;
  }

  /**
   * A symbol of a value both sides know: taken into the populations, nothing coded or learned.
   * The value step already paid for it, so it is no evidence for the step's weights.
   */
  implied(a: number): void {
    this.advance(a);
  }
}
