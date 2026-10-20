/**
 * Count tables of the similarity predictor: the followers of each hashed context (`Entry`), a
 * learning population over one symbol sequence (`Population`, the prototype's `Pop`) and the
 * built-in population loaded from a prior (`Frozen`).
 *
 * A population's sequence starts with `seq[0] = END`; position `t` is the next symbol's. The
 * order-k entry of a position holds what followed the k symbols before it, keyed by a 48-bit hash
 * of those symbols. Recency is not kept in buckets here: every follower carries the position it
 * last followed at, and the consumer buckets `t − last` (features.ts `recBucket`).
 */

import { KeyMap, hashes } from './keymap';

export { hashes };
import { shl, shr } from './arith';
import { END } from './types';
import type { LoadedPrior } from './types';

/** The longest agreement measured backwards from a position. */
const MAX_AGREEMENT = 64;
/** Offsets from this one on keep no same-offset ring. */
const RING_OFFSETS = 64;

/**
 * The followers of one context: per follower its symbol, count, the last position it followed at
 * and that position's value offset. Order-0 entries also index followers by symbol (`slot`), and
 * order-`order` entries remember the last positions that followed them (`ring`, newest at
 * `ri − 1`).
 */
export class Entry {
  syms: Int32Array;
  cnt: Int32Array;
  last: Int32Array;
  offs: Int32Array;
  /** Followers held. */
  n = 0;
  /** Sum of the counts. */
  total = 0;
  /** Largest count. */
  top = 0;
  /** The last position that followed this context. */
  pos = 0;
  /** Order 0 only: 1 + the follower index of each symbol, 0 when absent. */
  slot: Int32Array | null;
  ring: Int32Array | null = null;
  ri = 0;

  constructor(order0 = false) {
    const capacity = order0 ? 16 : 2;
    this.syms = new Int32Array(capacity);
    this.cnt = new Int32Array(capacity);
    this.last = new Int32Array(capacity);
    this.offs = new Int32Array(capacity);
    this.slot = order0 ? new Int32Array(256) : null;
  }

  /** The follower index of symbol `s`, −1 when absent. */
  indexOf(s: number): number {
    const slot = this.slot;
    if (slot !== null) {
      return s < slot.length ? slot[s] - 1 : -1;
    }
    const syms = this.syms;
    for (let j = 0; j < this.n; j++) {
      if (syms[j] === s) {
        return j;
      }
    }
    return -1;
  }

  has(s: number): boolean {
    return this.indexOf(s) >= 0;
  }

  /** The count of symbol `s`, 0 when absent. */
  count(s: number): number {
    const j = this.indexOf(s);
    return j < 0 ? 0 : this.cnt[j];
  }

  /** Counts one more `s` following at position `t` with value offset `off`; returns its count. */
  add(s: number, t: number, off = 0): number {
    let j = this.indexOf(s);
    if (j < 0) {
      j = this.append(s);
    }
    const c = ++this.cnt[j];
    this.last[j] = t;
    this.offs[j] = off;
    if (c > this.top) {
      this.top = c;
    }
    this.pos = t;
    this.total++;
    return c;
  }

  /** Adds `c` to the count of `s` with no position (frozen populations). */
  load(s: number, c: number): void {
    let j = this.indexOf(s);
    if (j < 0) {
      j = this.append(s);
    }
    const v = (this.cnt[j] += c);
    if (v > this.top) {
      this.top = v;
    }
    this.total += c;
  }

  /** Halves every count, rounding down but keeping at least 1. */
  halve(): void {
    const cnt = this.cnt;
    let total = 0;
    let top = 0;
    for (let j = 0; j < this.n; j++) {
      const c = Math.max(1, shr(cnt[j], 1));
      cnt[j] = c;
      total += c;
      if (c > top) {
        top = c;
      }
    }
    this.total = total;
    this.top = top;
  }

  /** A new follower `s` with count 0; returns its index. */
  private append(s: number): number {
    const j = this.n;
    if (j === this.syms.length) {
      this.syms = grow(this.syms, j * 2);
      this.cnt = grow(this.cnt, j * 2);
      this.last = grow(this.last, j * 2);
      this.offs = grow(this.offs, j * 2);
    }
    let slot = this.slot;
    if (slot !== null) {
      if (s >= slot.length) {
        slot = grow(slot, Math.max(s + 1, slot.length * 2));
        this.slot = slot;
      }
      slot[s] = j + 1;
    }
    this.syms[j] = s;
    this.cnt[j] = 0;
    this.n = j + 1;
    return j;
  }
}

function grow(a: Int32Array, size: number): Int32Array {
  const b = new Int32Array(size);
  b.set(a);
  return b;
}

/**
 * The exact-agreement counts of symbol `s` over the entries `E[0..m]`: `out[k]` is its count in
 * `E[k]` clamped to `out[k − 1]`, so a context whose hash collided with another never counts more
 * than the shorter context it extends and every `out[k] − out[k + 1]` is non-negative.
 */
export function exactCounts(
  E: readonly Entry[],
  m: number,
  s: number,
  out: Int32Array
): Int32Array {
  for (let k = 0; k <= m; k++) {
    const c = E[k].count(s);
    out[k] = k > 0 && c > out[k - 1] ? out[k - 1] : c;
  }
  return out;
}

/** The last positions at one value offset, oldest first through `at`. */
export class OffsetRing {
  readonly buf: Int32Array;
  len = 0;
  /** The slot the next position goes to. */
  next = 0;

  constructor(size: number) {
    this.buf = new Int32Array(size);
  }

  push(t: number): void {
    const size = this.buf.length;
    this.buf[this.next] = t;
    this.next = (this.next + 1) % size;
    if (this.len < size) {
      this.len++;
    }
  }

  /** The `i`-th oldest position held, for i in 0..len − 1. */
  at(i: number): number {
    const size = this.buf.length;
    return this.buf[(this.next + size - this.len + i) % size];
  }
}

/** What a population is built with; a `Resolved` options object fits. */
export interface PopulationOptions {
  readonly order: number;
  /** Ring positions per order-`order` entry that vote as long candidates; 0 keeps no rings. */
  readonly candidates: number;
  /** Same-offset ring length; 0 keeps no rings. */
  readonly offsets: number;
  /** Every count halves after each `window` symbols; Infinity for never. */
  readonly window?: number;
  /** Counts halve when one reaches 2^capBits (24; smaller values exist for tests). */
  readonly capBits?: number;
}

/**
 * A learning population: the message's, a path's, or a value's symbols. `resolve()` looks up the
 * entries of the current context and the long-match candidates; `update(a, off)` then appends
 * symbol `a` at value offset `off` and must follow a `resolve()` at the same position.
 */
export class Population {
  readonly order: number;
  readonly candidates: number;
  readonly offsets: number;
  readonly window: number;
  private readonly cap: number;
  seq: Int32Array = new Int32Array(64);
  offs: Int32Array = new Int32Array(64);
  /** The next position; `seq[0]` is END. */
  t = 1;
  readonly e0 = new Entry(true);
  /** Entries of order k by context hash, k = 1..order. */
  readonly maps: KeyMap<Entry>[] = [];
  /** Context hashes of the current position, from `resolve()`. */
  readonly h: Float64Array;
  /** The current context's entries `E[0..m]`. */
  readonly E: Entry[] = [];
  /** The deepest order with an entry, −1 while the population is empty. */
  m = 0;
  /** The orders hashed at the current position. */
  n = 0;
  /** The current long match: the position it predicts and its agreement length (≤ 64). */
  mPos = 0;
  mLen = 0;
  /** Distances of the last matches that broke after reaching `order`, newest first, at most 4. */
  readonly mru: number[] = [];
  /** Same-offset rings for offsets below 64. */
  readonly offRing = new Map<number, OffsetRing>();
  /** Long-match candidates of the current position and their agreement lengths. */
  readonly cand: Int32Array;
  readonly candL: Int32Array;
  nc = 0;
  /** Every hashed entry, for halving. */
  private readonly entries: Entry[] = [];

  constructor(o: PopulationOptions) {
    this.order = o.order;
    this.candidates = o.candidates;
    this.offsets = o.offsets;
    this.window = o.window ?? Infinity;
    this.cap = shl(1, o.capBits ?? 24);
    for (let k = 1; k <= o.order; k++) {
      this.maps[k] = new KeyMap<Entry>();
    }
    this.h = new Float64Array(o.order + 2);
    this.cand = new Int32Array(o.candidates + 1);
    this.candL = new Int32Array(o.candidates + 1);
  }

  /** The agreement length (≤ 64) of the symbols before position `p` with those before `t`. */
  agreement(p: number): number {
    const s = this.seq;
    const t = this.t;
    let L = 0;
    while (L < MAX_AGREEMENT && p - 1 - L >= 0 && s[t - 1 - L] === s[p - 1 - L]) {
      L++;
    }
    return L;
  }

  /**
   * Looks up the current context: `E[0..m]`, and when the deepest order is `order`, the
   * candidates: the entry's ring positions newest first, then the current match, each with its
   * agreement length.
   */
  resolve(): void {
    const K = this.order;
    this.n = hashes(this.seq, this.t, K, this.h);
    this.E[0] = this.e0;
    let m = -1;
    if (this.e0.n > 0) {
      m = 0;
      for (let k = 1; k <= this.n; k++) {
        const e = this.maps[k].get(this.h[k]);
        if (e === undefined) {
          break;
        }
        this.E[k] = e;
        m = k;
      }
    }
    this.m = m;
    this.nc = 0;
    if (m !== K) {
      this.mLen = 0;
      return;
    }
    const e = this.E[K];
    if (this.mLen < K) {
      this.mPos = e.pos;
      this.mLen = 0;
    }
    const r = e.ring;
    if (r !== null) {
      const n = Math.min(e.ri, r.length);
      for (let i = 1; i <= n; i++) {
        this.addCandidate(r[(e.ri - i) % r.length], 0);
      }
    }
    if (this.mLen >= K) {
      this.addCandidate(this.mPos, this.mLen);
    } else {
      this.mLen = this.agreement(this.mPos);
    }
  }

  private addCandidate(p: number, known: number): void {
    for (let i = 0; i < this.nc; i++) {
      if (this.cand[i] === p) {
        return;
      }
    }
    this.cand[this.nc] = p;
    this.candL[this.nc++] = known > 0 ? known : this.agreement(p);
  }

  /** Appends symbol `a` at value offset `off`. */
  update(a: number, off = 0): void {
    const t = this.t;
    const K = this.order;
    if (t >= this.seq.length) {
      this.seq = grow(this.seq, this.seq.length * 2);
      this.offs = grow(this.offs, this.offs.length * 2);
    }
    this.seq[t] = a;
    this.offs[t] = off;
    if (off < RING_OFFSETS && this.offsets > 0) {
      let r = this.offRing.get(off);
      if (r === undefined) {
        r = new OffsetRing(this.offsets);
        this.offRing.set(off, r);
      }
      r.push(t);
    }
    // Every count in a hashed entry grows only along with the same symbol's order-0 count and
    // halves with it, so none reaches the cap before the order-0 count of its symbol.
    const capped = this.e0.add(a, t) >= this.cap;
    for (let k = 1; k <= this.n; k++) {
      let e = k <= this.m ? this.E[k] : this.maps[k].get(this.h[k]);
      if (e === undefined) {
        e = new Entry();
        this.maps[k].set(this.h[k], e);
        this.entries.push(e);
      }
      e.add(a, t, off);
      if (k === K && this.candidates > 0) {
        if (e.ring === null) {
          e.ring = new Int32Array(this.candidates);
        }
        e.ring[e.ri++ % this.candidates] = t;
      }
    }
    if (this.mLen > 0 && this.seq[this.mPos] === a) {
      this.mPos++;
      if (this.mLen < MAX_AGREEMENT) {
        this.mLen++;
      }
    } else {
      if (this.mLen >= K) {
        const d = t - this.mPos;
        const i = this.mru.indexOf(d);
        if (i >= 0) {
          this.mru.splice(i, 1);
        }
        this.mru.unshift(d);
        if (this.mru.length > 4) {
          this.mru.pop();
        }
      }
      this.mLen = 0;
    }
    this.t = t + 1;
    if (capped || t % this.window === 0) {
      this.halve();
    }
  }

  /** Halves every count of the population (window boundaries and the count cap). */
  halve(): void {
    this.e0.halve();
    for (const e of this.entries) {
      e.halve();
    }
  }
}

/** The built-in population: order 0 and 1 from a prior's counts, with no positions. */
export class Frozen {
  readonly K = 1;
  readonly e0 = new Entry(true);
  /** `maps[1]`: order-1 entries by the hash of the previous symbol. */
  readonly maps: KeyMap<Entry>[] = [];
  total = 0;
  /** The entries of the last `lookup`. */
  readonly E: Entry[] = [];
  m = 0;

  constructor() {
    this.maps[1] = new KeyMap<Entry>();
  }

  /** Fills `E[0..m]` from another population's context hashes `h[1..n]`; returns m. */
  lookup(h: Float64Array, n: number): number {
    this.E[0] = this.e0;
    let m = 0;
    for (let k = 1; k <= this.K && k <= n; k++) {
      const e = this.maps[k].get(h[k]);
      if (e === undefined) {
        break;
      }
      this.E[k] = e;
      m = k;
    }
    this.m = m;
    return m;
  }
}

/** What `frozen()` needs of the session's id table (alphabet.ts `Ids`). */
export interface IdLookup {
  idOf(cp: number): number;
}

/** The last built-in population of each prior and the ids it was built under. */
const FROZEN_CACHE = new WeakMap<object, { ids: Int32Array; f: Frozen }>();

/**
 * The built-in population of a prior with the session's symbol ids; −1 in the prior is END. The
 * ids are taken in the same order on every call, so their assignment does not depend on the
 * cache. A population built under the same ids is shared: nothing writes to it but `lookup`,
 * whose `E` and `m` are read within the same step.
 */
export function frozen(
  prior: Pick<LoadedPrior, 'builtinSymbols' | 'builtinCounts0' | 'builtinContexts1'>,
  ids: IdLookup
): Frozen {
  const id = (cp: number): number => (cp < 0 ? END : ids.idOf(cp));
  const symbols = prior.builtinSymbols;
  const contexts = prior.builtinContexts1;
  const got = new Int32Array(symbols.length + 2 * contexts.length);
  let w = 0;
  for (const cp of symbols) got[w++] = id(cp);
  for (const [prev, next] of contexts) {
    got[w++] = id(prev);
    got[w++] = id(next);
  }
  const hit = FROZEN_CACHE.get(prior);
  if (hit !== undefined && sameIds(hit.ids, got)) {
    return hit.f;
  }
  const f = new Frozen();
  f.e0.load(END, prior.builtinCounts0[0]);
  for (let i = 0; i < symbols.length; i++) f.e0.load(got[i], prior.builtinCounts0[i + 1]);
  const seq = new Int32Array(1);
  const h = new Float64Array(2);
  const map = f.maps[1];
  w = symbols.length;
  for (const [, , c] of contexts) {
    seq[0] = got[w++];
    hashes(seq, 1, 1, h);
    let e = map.get(h[1]);
    if (e === undefined) {
      e = new Entry();
      map.set(h[1], e);
    }
    e.load(got[w++], c);
  }
  f.total = f.e0.total;
  FROZEN_CACHE.set(prior, { ids: got, f });
  return f;
}

/** Equal id lists; both come from one prior, so their lengths agree. */
function sameIds(a: Int32Array, b: Int32Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
