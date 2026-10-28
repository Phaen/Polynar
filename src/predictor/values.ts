/**
 * The value step (spec §6.3): before a string value at a path, every distinct past value of the
 * path and NEW form one distribution. Each past occurrence votes for its value with the log-weight
 * theta[agreement of the message before it with now] + theta[values ago] + theta[record agreement]
 * + base - log2 n, base = theta[repeat rate] + theta[top share] + theta[distinct count]; NEW votes
 * with theta[novelty rate] + theta[top share] + theta[distinct count] from its own cells. theta is
 * the run prior's vstep cell plus the path's delta. The last `history` occurrences carry the full
 * features; older ones vote through agreement 0, the values-ago bucket "more" and record agreement 0
 * (D6). Record agreement is 0 until records arrive. The sequence cells (values agreeing with the
 * path's last values, the same list index) are used when `sequence` is on.
 */

import { HB, ONE, PB, SB, bitlen, clampi, div, exp2Fix, log2Fix, shl, shr } from './arith';
import { Distribution } from './distribution';
import { ESCAPE } from './types';
import type { PriorConstants } from './types';
import { deltaRate, rdiv, smul } from './weights';

export const VS_L = 0;
export const VS_REC = 10;
export const VS_REP = 18;
export const VS_NEW = 22;
export const VS_A = 28;
export const VS_SH = 34;
export const VS_SQ = 50;
export const VS_AN = 55;
export const VS_CP = 57;
export const VS_O0 = 59;
export const VS_AG = 68;
export const VSTEP_N = 76;

/** Context agreement is measured up to this many symbols. */
const MAX_L = 64;
/** The values-ago bucket of occurrences outside the history window. */
const REC_MORE = 7;

/** Context agreement length bucket (10). */
export function vsL(L: number): number {
  return L <= 3 ? L : L <= 5 ? 4 : L <= 8 ? 5 : L <= 12 ? 6 : L <= 24 ? 7 : L <= 48 ? 8 : 9;
}

/** Values-ago bucket (8). */
export function vsRec(ago: number): number {
  return ago <= 1
    ? 0
    : ago <= 2
      ? 1
      : ago <= 4
        ? 2
        : ago <= 8
          ? 3
          : ago <= 16
            ? 4
            : ago <= 64
              ? 5
              : ago <= 256
                ? 6
                : 7;
}

/** Repeat-rate bucket of reps / n (4): 0, below 1/4, below 3/4, more. */
export function vsRep(reps: number, n: number): number {
  return reps === 0 ? 0 : 4 * reps < n ? 1 : 4 * reps < 3 * n ? 2 : 3;
}

/** Novelty-rate bucket of nNew / n (6): below 1/16, 1/8, 1/4, 1/2, 3/4, more. */
export function vsNew(nNew: number, n: number): number {
  return 16 * nNew < n
    ? 0
    : 8 * nNew < n
      ? 1
      : 4 * nNew < n
        ? 2
        : 2 * nNew < n
          ? 3
          : 4 * nNew < 3 * n
            ? 4
            : 5;
}

/** Top value's share of occurrences top / n (4): all, at least 3/4, at least 1/2, less. */
export function vsTop(top: number, n: number): number {
  return top >= n ? 0 : 4 * top >= 3 * n ? 1 : 2 * top >= n ? 2 : 3;
}

/** Distinct values (4): 1, 2-3, 4-8, more. */
export function vsDist(d: number): number {
  return d <= 1 ? 0 : d <= 3 ? 1 : d <= 8 ? 2 : 3;
}

/** Record agreement in RB bits (6): 0, below 2, 4, 8, 16, more. */
export function vsA(A: number): number {
  return A <= 0 ? 0 : A < 2 * ONE ? 1 : A < 4 * ONE ? 2 : A < 8 * ONE ? 3 : A < 16 * ONE ? 4 : 5;
}

/** Sequence agreement bucket (5): 0, 1, 2-3, 4-7, 8 values. */
function vsSeq(LV: number): number {
  return LV <= 1 ? LV : LV <= 3 ? 2 : LV <= 7 ? 3 : 4;
}

function grown(a: Float64Array, cap: number): Float64Array {
  const b = new Float64Array(cap);
  b.set(a);
  return b;
}

/**
 * The occurrences of a path's values and the cells they vote through: the part the value step
 * and the restricted member step share. Ids are small integers; `votes` gives each id its mass at
 * one block scale, NEW its own, and `learnCells` moves the cells by the chosen entry's share.
 */
abstract class Occurrences {
  /** The step's coded distribution, reused every step. */
  readonly dist = new Distribution();
  /** Occurrences recorded so far, values first seen, repeats, and the largest count. */
  n = 0;
  nNew = 0;
  reps = 0;
  top = 0;
  /** Distinct ids recorded so far. */
  distinct = 0;

  protected count: Float64Array;
  /** Occurrences per id that left the history window (and, for members, the declared weights). */
  protected older: Float64Array;
  /** Ring of the last history + 8 occurrences: value id, message position, list index. */
  private readonly cap: number;
  private readonly occV: Int32Array;
  private readonly occPos: Float64Array;
  private readonly occList: Int32Array;

  /** The pending step: per full occurrence its mass and cells, per id its total and older mass. */
  protected pending = false;
  private k = 0;
  private readonly wOcc: Float64Array;
  private readonly cL: Int32Array;
  private readonly cR: Int32Array;
  private readonly cS: Int32Array;
  private readonly cN: Int32Array;
  protected V: Float64Array;
  private wOld: Float64Array;
  /** NEW's mass and the step's total (NEW included) at the step's block scale. */
  protected wNew = 0;
  protected Z = 0;
  private cRep = 0;
  private cNew = 0;
  private cOT = 0;
  private cOD = 0;
  private cNT = 0;
  private cND = 0;
  private readonly cellA = new Float64Array(VSTEP_N);
  private readonly cellT = new Float64Array(VSTEP_N);

  constructor(
    readonly history: number,
    readonly quantisation: number,
    readonly sequence: boolean,
    size: number
  ) {
    this.count = new Float64Array(size);
    this.older = new Float64Array(size);
    this.V = new Float64Array(size);
    this.wOld = new Float64Array(size);
    this.cap = history + 8;
    this.occV = new Int32Array(this.cap);
    this.occPos = new Float64Array(this.cap);
    this.occList = new Int32Array(this.cap);
    this.wOcc = new Float64Array(history);
    this.cL = new Int32Array(history);
    this.cR = new Int32Array(history);
    this.cS = new Int32Array(history);
    this.cN = new Int32Array(history);
  }

  /** Room for ids below `size`. */
  protected grow(size: number): void {
    this.count = grown(this.count, size);
    this.older = grown(this.older, size);
    this.V = new Float64Array(size);
    this.wOld = new Float64Array(size);
  }

  /**
   * The masses of ids 0..d − 1 in `V` and NEW's in `wNew` for the value at message position `t`
   * (`seq` the message population's symbols), at one block scale; `Z` is their sum.
   */
  protected votes(
    seq: Int32Array,
    t: number,
    listIndex: number,
    vstep: Float64Array,
    delta: Float64Array | null,
    d: number
  ): void {
    const n = this.n;
    const th = (i: number): number => (delta ? vstep[i] + delta[i] : vstep[i]);
    const st = vsTop(this.top, n);
    const sd = vsDist(this.distinct);
    this.cRep = VS_REP + vsRep(this.reps, n);
    this.cNew = VS_NEW + vsNew(this.nNew, n);
    this.cOT = VS_SH + st;
    this.cOD = VS_SH + 4 + sd;
    this.cNT = VS_SH + 8 + st;
    this.cND = VS_SH + 12 + sd;
    // A member step's first value has no occurrences; its count is taken as 1.
    const base = th(this.cRep) + th(this.cOT) + th(this.cOD) - log2Fix(n > 0 ? n : 1);
    const eNew = th(this.cNew) + th(this.cNT) + th(this.cND);
    const cA = VS_A + vsA(0);
    const j0 = n > this.history ? n - this.history : 0;
    const k = n - j0;
    const wOcc = this.wOcc;
    let M = eNew;
    for (let i = 0; i < k; i++) {
      const j = j0 + i;
      const r = j % this.cap;
      const p = this.occPos[r];
      let L = 0;
      while (L < MAX_L && p - 1 - L >= 1 && seq[t - 1 - L] === seq[p - 1 - L]) {
        L++;
      }
      const cl = VS_L + vsL(L);
      const cr = VS_REC + vsRec(n - j);
      let e = th(cl) + th(cr) + th(cA) + base;
      this.cL[i] = cl;
      this.cR[i] = cr;
      if (this.sequence) {
        let LV = 0;
        while (
          LV < 8 &&
          j - 1 - LV >= 0 &&
          this.occV[(j - 1 - LV) % this.cap] === this.occV[(n - 1 - LV) % this.cap]
        ) {
          LV++;
        }
        const cs = VS_SQ + vsSeq(LV);
        const lx = this.occList[r];
        const cn = listIndex >= 0 && lx >= 0 ? VS_AN + (lx === listIndex ? 1 : 0) : -1;
        e += th(cs) + (cn >= 0 ? th(cn) : 0);
        this.cS[i] = cs;
        this.cN[i] = cn;
      }
      wOcc[i] = e;
      if (e > M) {
        M = e;
      }
    }
    const eOld = th(VS_L) + th(VS_REC + REC_MORE) + th(cA) + base;
    const wOld = this.wOld;
    let entries = k + 1;
    for (let v = 0; v < d; v++) {
      const o = this.older[v];
      if (o > 0) {
        const e = eOld + log2Fix(o);
        wOld[v] = e;
        entries++;
        if (e > M) {
          M = e;
        }
      }
    }
    // Every entry is at most 2^sb, so the sum stays below 2^52 however many values the path has.
    const lim = 52 - bitlen(entries);
    const off = (SB < lim ? SB : lim) * ONE - M;
    const V = this.V;
    V.fill(0, 0, d);
    let Z = 0;
    for (let i = 0; i < k; i++) {
      const w = exp2Fix(wOcc[i] + off);
      wOcc[i] = w;
      V[this.occV[(j0 + i) % this.cap]] += w;
      Z += w;
    }
    for (let v = 0; v < d; v++) {
      if (this.older[v] > 0) {
        const w = exp2Fix(wOld[v] + off);
        wOld[v] = w;
        V[v] += w;
        Z += w;
      } else {
        wOld[v] = 0;
      }
    }
    this.wNew = exp2Fix(eNew + off);
    this.Z = Z + this.wNew;
    this.k = k;
    this.pending = true;
  }

  /**
   * Learns from the pending step's outcome, `choice` an id or ESCAPE. Each cell sums the masses
   * that used it, T over all and A over the chosen entry's; NEW's cells take `newT` of NEW's mass
   * into T and `newA` of it into A (the part the chosen entry owns). g = A / (the chosen entry's
   * mass) - T / Z in PB, the shared cell moves at rate eta and the path's delta at rho(pathN) * eta.
   */
  protected learnCells(
    choice: number,
    newT: number,
    newA: number,
    pathN: number,
    vstep: Float64Array,
    delta: Float64Array | null,
    rates: PriorConstants
  ): void {
    this.pending = false;
    const s = Math.max(0, bitlen(this.Z) - HB);
    const A = this.cellA;
    const T = this.cellT;
    A.fill(0);
    T.fill(0);
    const cA = VS_A + vsA(0);
    const add = (cell: number, w: number, mine: boolean): void => {
      T[cell] += w;
      if (mine) {
        A[cell] += w;
      }
    };
    const wt = shr(newT, s);
    const wa = shr(newA, s);
    for (const cell of [this.cNew, this.cNT, this.cND]) {
      T[cell] += wt;
      A[cell] += wa;
    }
    let chosen = wa;
    const j0 = this.n - this.k;
    for (let i = 0; i < this.k; i++) {
      const w = shr(this.wOcc[i], s);
      const mine = this.occV[(j0 + i) % this.cap] === choice;
      add(this.cL[i], w, mine);
      add(this.cR[i], w, mine);
      add(cA, w, mine);
      if (this.sequence) {
        add(this.cS[i], w, mine);
        if (this.cN[i] >= 0) {
          add(this.cN[i], w, mine);
        }
      }
      add(this.cRep, w, mine);
      add(this.cOT, w, mine);
      add(this.cOD, w, mine);
      if (mine) {
        chosen += w;
      }
    }
    for (let v = 0; v < this.count.length; v++) {
      if (this.wOld[v] > 0) {
        const w = shr(this.wOld[v], s);
        const mine = v === choice;
        add(VS_L, w, mine);
        add(VS_REC + REC_MORE, w, mine);
        add(cA, w, mine);
        add(this.cRep, w, mine);
        add(this.cOT, w, mine);
        add(this.cOD, w, mine);
        if (mine) {
          chosen += w;
        }
      }
    }
    const z = Math.max(1, shr(this.Z, s));
    const sa = Math.max(1, chosen);
    const eta = rates.rates.vstep;
    const cv = rates.clamps.vstep;
    const cd = rates.clamps.delta;
    const rr = delta ? deltaRate(rates, pathN) : 0;
    for (let i = 0; i < VSTEP_N; i++) {
      if (T[i] !== 0) {
        const g = rdiv(shl(A[i], PB), sa) - rdiv(shl(T[i], PB), z);
        if (g !== 0) {
          vstep[i] = clampi(vstep[i] + smul(eta, g, PB), -cv, cv);
          if (delta) {
            delta[i] = clampi(delta[i] + smul(rr, g, PB), -cd, cd);
          }
        }
      }
    }
  }

  /** Records an occurrence of `id` (new to the path when `isNew`) at message position `msgPos`. */
  protected recordId(id: number, isNew: boolean, msgPos: number, listIndex: number): void {
    this.pending = false;
    if (isNew) {
      this.nNew++;
    } else {
      this.reps++;
    }
    const c = ++this.count[id];
    if (c > this.top) {
      this.top = c;
    }
    const r = this.n % this.cap;
    this.occV[r] = id;
    this.occPos[r] = msgPos;
    this.occList[r] = listIndex;
    this.n++;
    const out = this.n - 1 - this.history;
    if (out >= 0) {
      this.older[this.occV[out % this.cap]]++;
    }
  }
}

/** One path's value step. Value ids are first-occurrence indices 0, 1, 2 ...; NEW is ESCAPE. */
export class ValueStep extends Occurrences {
  private readonly keys = new Map<string, number>();
  /** Values left out of the pending step's table; their mass is NEW's. */
  private dropped: Uint8Array = new Uint8Array(16);

  constructor(history: number, quantisation: number, sequence = false) {
    super(history, quantisation, sequence, 16);
  }

  /** The id of a past value, or ESCAPE when the path has not had it. */
  idOf(key: string): number {
    const id = this.keys.get(key);
    return id === undefined ? ESCAPE : id;
  }

  /**
   * The distribution over the path's past values and NEW for the value that starts at message
   * position `t` (`seq` the message population's symbols), or null before the path's first value.
   * When the values and NEW exceed half the quantisation, the values of lowest mass (ties: highest
   * id) are left out and their mass joins NEW, so such a value is coded as NEW; `learn` still takes
   * its id.
   */
  distribution(
    seq: Int32Array,
    t: number,
    listIndex: number,
    vstep: Float64Array,
    delta: Float64Array | null
  ): Distribution | null {
    this.pending = false;
    if (this.n === 0) {
      return null;
    }
    const d = this.distinct;
    this.votes(seq, t, listIndex, vstep, delta, d);
    const V = this.V;
    const dropped = this.dropped;
    dropped.fill(0, 0, d);
    let esc = this.wNew;
    const room = div(this.quantisation, 2) - 1;
    if (d > room) {
      const order: number[] = [];
      for (let v = 0; v < d; v++) {
        order.push(v);
      }
      order.sort((x, y) => (V[x] !== V[y] ? (V[x] < V[y] ? -1 : 1) : y - x));
      for (let i = 0; i < d - room; i++) {
        dropped[order[i]] = 1;
        esc += V[order[i]];
      }
    }
    const dist = this.dist;
    dist.begin(this.quantisation, true);
    for (let v = 0; v < d; v++) {
      if (dropped[v] === 0) {
        dist.add(v, V[v]);
      }
    }
    dist.finish(esc);
    return dist;
  }

  /** Learns from the pending step's outcome, `choice` a value id or ESCAPE for NEW. */
  learn(
    choice: number,
    pathN: number,
    vstep: Float64Array,
    delta: Float64Array | null,
    rates: PriorConstants
  ): void {
    if (!this.pending) {
      return;
    }
    this.learnCells(
      choice,
      this.wNew,
      choice === ESCAPE ? this.wNew : 0,
      pathN,
      vstep,
      delta,
      rates
    );
  }

  /** Records the value that was coded (at message position `msgPos`, list index or -1) and returns its id. */
  record(key: string, msgPos: number, listIndex: number): number {
    let id = this.keys.get(key);
    const isNew = id === undefined;
    if (id === undefined) {
      id = this.distinct++;
      this.keys.set(key, id);
      if (id >= this.count.length) {
        const c = 2 * this.count.length;
        this.grow(c);
        this.dropped = new Uint8Array(c);
      }
    }
    this.recordId(id, isNew, msgPos, listIndex);
    return id;
  }
}

/**
 * The value step restricted to a declared member set (spec §6.3): ids 0..count − 1, no NEW entry.
 * The declared weights are prior counts, held as occurrences older than the history window; the
 * members not yet coded share NEW's mass evenly (the remainder to the lowest of them). A member of
 * weight 0 owns no entry.
 */
export class MemberStep extends Occurrences {
  private readonly weights: Float64Array;
  /** The pending step's NEW share per unseen member, the remainder's owner, and how many share. */
  private share = 0;
  private rem = 0;
  private first = -1;
  private unseen = 0;

  constructor(
    readonly members: number,
    weights: readonly number[] | undefined,
    history: number,
    quantisation: number
  ) {
    super(history, quantisation, false, members);
    this.weights = Float64Array.from({ length: members }, (_, v) =>
      weights === undefined ? 1 : weights[v]
    );
    this.older.set(this.weights);
  }

  /** Whether member `v` owns an entry. */
  has(v: number): boolean {
    return this.weights[v] > 0;
  }

  /** The distribution over the members with weight for the value at message position `t`. */
  distribution(
    seq: Int32Array,
    t: number,
    listIndex: number,
    vstep: Float64Array,
    delta: Float64Array | null
  ): Distribution {
    const m = this.members;
    this.votes(seq, t, listIndex, vstep, delta, m);
    let unseen = 0;
    let first = -1;
    for (let v = 0; v < m; v++) {
      if (this.weights[v] > 0 && this.count[v] === 0) {
        if (first < 0) {
          first = v;
        }
        unseen++;
      }
    }
    this.unseen = unseen;
    this.first = first;
    if (unseen > 0) {
      this.share = div(this.wNew, unseen);
      this.rem = this.wNew - this.share * unseen;
    } else {
      this.Z -= this.wNew;
    }
    const dist = this.dist;
    dist.begin(this.quantisation, false);
    for (let v = 0; v < m; v++) {
      if (this.weights[v] > 0) {
        dist.add(v, this.V[v] + this.newOf(v));
      }
    }
    dist.finish(0);
    return dist;
  }

  /** The part of NEW's mass member `v` owns in the pending step. */
  private newOf(v: number): number {
    if (this.unseen === 0 || this.count[v] > 0) {
      return 0;
    }
    return v === this.first ? this.share + this.rem : this.share;
  }

  /** Learns from the pending step's outcome, member `choice`. */
  learn(
    choice: number,
    pathN: number,
    vstep: Float64Array,
    delta: Float64Array | null,
    rates: PriorConstants
  ): void {
    this.learnCells(
      choice,
      this.unseen > 0 ? this.wNew : 0,
      this.newOf(choice),
      pathN,
      vstep,
      delta,
      rates
    );
  }

  /** Records member `v`, coded at message position `msgPos` (list index or −1). */
  record(v: number, msgPos: number, listIndex: number): void {
    const isNew = this.count[v] === 0;
    if (isNew) {
      this.distinct++;
    }
    this.recordId(v, isNew, msgPos, listIndex);
  }
}
