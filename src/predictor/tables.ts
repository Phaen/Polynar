/**
 * Count tables of the similarity predictor: the followers of each hashed context (`Entries`), a
 * learning population over one symbol sequence (`Population`, the prototype's `Pop`) and the
 * built-in population loaded from a prior (`Frozen`).
 *
 * A population's sequence starts with `seq[0] = END`; position `t` is the next symbol's. The
 * order-k entry of a position holds what followed the k symbols before it, keyed by a 48-bit hash
 * of those symbols. Recency is not kept in buckets here: every follower carries the position it
 * last followed at, and the consumer buckets `t − last` (features.ts `recBucket`).
 */

import { IndexMap, hashes } from './keymap';

export { hashes };
import { POW2, bitlen, shl, shr } from './arith';
import { END } from './types';
import type { LoadedPrior } from './types';

/** The longest agreement measured backwards from a position. */
const MAX_AGREEMENT = 64;
/** Offsets from this one on keep no same-offset ring. */
const RING_OFFSETS = 64;

/** Int32 words per follower: symbol, count, last position, value offset. */
export const STRIDE = 4;

/**
 * Int32 words per arena chunk, from the first one on, doubling up to the last; a region larger
 * than a quarter of the last gets an array of its own.
 */
const FIRST_CHUNK = POW2[10];
const CHUNK = POW2[16];
const LARGE = POW2[14];

/** What a released array of its own is replaced with. */
const EMPTY = new Int32Array(0);

/**
 * The follower and ring storage of one table's entries: regions of a power-of-two number of words
 * cut from shared chunks, so an entry costs its words and no typed array of its own. A region is
 * named by the id of its array in `chunks` and its base there, so it fits in two columns. A region
 * an entry outgrows goes back to the free list of its size; rings are never freed. `alloc` leaves
 * the region in `id` and `b`.
 */
export class Arena {
  /** The chunks and the arrays of their own, by id. */
  readonly chunks: Int32Array[] = [];
  id = 0;
  b = 0;
  /** The id and the words of the chunk regions are cut from, and the words cut from it. */
  private cur = -1;
  private room = 0;
  private used = 0;
  /** Free regions per size class (log2 of the words): their ids and bases. */
  private readonly freeId: number[][] = [];
  private readonly freeB: number[][] = [];

  /** A zeroed region of at least `words` words. */
  alloc(words: number): void {
    if (words > LARGE) {
      this.id = this.chunks.push(new Int32Array(words)) - 1;
      this.b = 0;
      return;
    }
    const c = sizeClass(words);
    const fi = this.freeId[c];
    if (fi !== undefined && fi.length > 0) {
      const id = fi.pop() as number;
      const b = this.freeB[c].pop() as number;
      this.chunks[id].fill(0, b, b + POW2[c]);
      this.id = id;
      this.b = b;
      return;
    }
    if (this.used + POW2[c] > this.room) {
      this.room = Math.min(CHUNK, Math.max(POW2[c], FIRST_CHUNK, 2 * this.room));
      this.cur = this.chunks.push(new Int32Array(this.room)) - 1;
      this.used = 0;
    }
    this.id = this.cur;
    this.b = this.used;
    this.used += POW2[c];
  }

  /** Returns the region of `words` words (a power of two) at `b` in chunk `id` for reuse. */
  free(id: number, b: number, words: number): void {
    if (words > LARGE) {
      this.chunks[id] = EMPTY;
      return;
    }
    const c = sizeClass(words);
    if (this.freeId[c] === undefined) {
      this.freeId[c] = [];
      this.freeB[c] = [];
    }
    this.freeId[c].push(id);
    this.freeB[c].push(b);
  }
}

/** The size class of a region of `words` ≥ 1 words: log2 of the next power of two. */
function sizeClass(words: number): number {
  return bitlen(words - 1);
}

/** Entries the columns of a table start with. */
const COLUMNS = 128;
/** Followers the region of the order-0 entry and of a hashed entry start with. */
const FIRST0 = 16;
const FIRST = 1;

/**
 * The entries of one population, as columns indexed by entry: entry 0 is the order-0 entry, every
 * other one a hashed context of an order 1..`order`, found by `find` and made by `make`.
 *
 * An entry's followers sit in its arena region, chunk `chunks[chunk[x]]` from `base[x]`: per
 * follower its symbol, count, the last position it followed at and that position's value offset
 * (follower j at `base[x] + j · STRIDE`). The region holds the next power of two of `n[x]`
 * followers, at least FIRST (FIRST0 for entry 0), so it is not kept. The order-0 entry also
 * indexes its followers by symbol (`slot`). An entry with a ring remembers the last positions
 * that followed it in chunk `ring[x] − 1` from `rb[x]` (newest at `rb + (ri − 1) mod size`); `ri`
 * counts them up to twice the size and then steps back by the size, so it fits a byte (size ≤ 64)
 * and keeps both its residue and its minimum with the size.
 */
export class Entries {
  private readonly arena = new Arena();
  readonly chunks = this.arena.chunks;
  /** Entries held. */
  size = 0;
  chunk = new Int32Array(COLUMNS);
  base = new Uint16Array(COLUMNS);
  /** Followers held. */
  n = new Int32Array(COLUMNS);
  /** Sum of the counts. */
  total = new Float64Array(COLUMNS);
  /** The context hash of a hashed entry. */
  key = new Float64Array(COLUMNS);
  /** 1 + the ring's chunk id, 0 while the entry has no ring. */
  ring = new Int32Array(COLUMNS);
  rb = new Uint16Array(COLUMNS);
  ri = new Uint8Array(COLUMNS);
  /** Entry 0 only: 1 + the follower index of each symbol, 0 when absent. */
  slot = new Int32Array(256);
  /** The hashed entries of order k by context hash, k = 1..order. */
  private readonly maps: IndexMap[] = [];

  constructor(order: number) {
    for (let k = 1; k <= order; k++) {
      this.maps[k] = new IndexMap();
    }
    this.create(FIRST0);
  }

  /** The order-`k` entry of context hash `h`, −1 when absent. */
  find(k: number, h: number): number {
    return this.maps[k].get(this.key, h);
  }

  /** A new order-`k` entry of context hash `h`, which has none. */
  make(k: number, h: number): number {
    const x = this.create(FIRST);
    this.key[x] = h;
    this.maps[k].add(this.key, x);
    return x;
  }

  /** The array holding the followers of entry `x`, from `base[x]`. */
  data(x: number): Int32Array {
    return this.chunks[this.chunk[x]];
  }

  /** The follower index of symbol `s` in entry `x`, −1 when absent. */
  indexOf(x: number, s: number): number {
    if (x === 0) {
      const slot = this.slot;
      return s < slot.length ? slot[s] - 1 : -1;
    }
    const d = this.chunks[this.chunk[x]];
    const b = this.base[x];
    const n = this.n[x];
    for (let j = 0, o = b; j < n; j++, o += STRIDE) {
      if (d[o] === s) {
        return j;
      }
    }
    return -1;
  }

  has(x: number, s: number): boolean {
    return this.indexOf(x, s) >= 0;
  }

  /** The count of symbol `s` in entry `x`, 0 when absent. */
  count(x: number, s: number): number {
    const j = this.indexOf(x, s);
    return j < 0 ? 0 : this.chunks[this.chunk[x]][this.base[x] + j * STRIDE + 1];
  }

  /** Counts one more `s` following entry `x` at position `t` with value offset `off`; returns its count. */
  add(x: number, s: number, t: number, off = 0): number {
    let j = this.indexOf(x, s);
    if (j < 0) {
      j = this.append(x, s);
    }
    const d = this.chunks[this.chunk[x]];
    const o = this.base[x] + j * STRIDE;
    const c = ++d[o + 1];
    d[o + 2] = t;
    d[o + 3] = off;
    this.total[x]++;
    return c;
  }

  /** Adds `c` to the count of `s` in entry `x` with no position (frozen populations). */
  load(x: number, s: number, c: number): void {
    let j = this.indexOf(x, s);
    if (j < 0) {
      j = this.append(x, s);
    }
    this.chunks[this.chunk[x]][this.base[x] + j * STRIDE + 1] += c;
    this.total[x] += c;
  }

  /** The last position that followed entry `x`: the latest of its followers. */
  pos(x: number): number {
    const d = this.chunks[this.chunk[x]];
    const end = this.base[x] + this.n[x] * STRIDE;
    let p = 0;
    for (let o = this.base[x] + 2; o < end; o += STRIDE) {
      if (d[o] > p) {
        p = d[o];
      }
    }
    return p;
  }

  /** Halves every count of every entry, rounding down but keeping at least 1. */
  halve(): void {
    const { chunks, chunk, base, n } = this;
    for (let x = 0; x < this.size; x++) {
      const d = chunks[chunk[x]];
      const end = base[x] + n[x] * STRIDE;
      let total = 0;
      for (let o = base[x] + 1; o < end; o += STRIDE) {
        const c = Math.max(1, shr(d[o], 1));
        d[o] = c;
        total += c;
      }
      this.total[x] = total;
    }
  }

  /** Records position `t` in the ring of `size` positions of entry `x`, made on first use. */
  remember(x: number, t: number, size: number): void {
    if (this.ring[x] === 0) {
      this.arena.alloc(size);
      this.ring[x] = this.arena.id + 1;
      this.rb[x] = this.arena.b;
    }
    const i = this.ri[x];
    this.chunks[this.ring[x] - 1][this.rb[x] + (i % size)] = t;
    this.ri[x] = i + 1 < 2 * size ? i + 1 : i + 1 - size;
  }

  /** A new entry with a zeroed region of `followers` followers; returns its index. */
  private create(followers: number): number {
    const x = this.size;
    if (x === this.chunk.length) {
      this.grow(x + shr(x, 1));
    }
    this.arena.alloc(followers * STRIDE);
    this.chunk[x] = this.arena.id;
    this.base[x] = this.arena.b;
    this.size = x + 1;
    return x;
  }

  /** A new follower `s` of entry `x` with count 0; returns its index. */
  private append(x: number, s: number): number {
    const j = this.n[x];
    // A full region holds a power of two of at least its first size.
    if (j >= (x === 0 ? FIRST0 : FIRST) && POW2[bitlen(j) - 1] === j) {
      this.move(x, 2 * j * STRIDE);
    }
    if (x === 0) {
      if (s >= this.slot.length) {
        this.slot = grow(this.slot, Math.max(s + 1, this.slot.length * 2));
      }
      this.slot[s] = j + 1;
    }
    this.chunks[this.chunk[x]][this.base[x] + j * STRIDE] = s;
    this.n[x] = j + 1;
    return j;
  }

  /** Moves the followers of entry `x` to a region of `words` words, twice their own. */
  private move(x: number, words: number): void {
    const arena = this.arena;
    const id = this.chunk[x];
    const b = this.base[x];
    const held = this.n[x] * STRIDE;
    arena.alloc(words);
    this.chunks[arena.id].set(this.chunks[id].subarray(b, b + held), arena.b);
    arena.free(id, b, held);
    this.chunk[x] = arena.id;
    this.base[x] = arena.b;
  }

  /** Grows every column to `size` entries. */
  private grow(size: number): void {
    this.chunk = grow(this.chunk, size);
    this.base = grow(this.base, size);
    this.n = grow(this.n, size);
    this.total = grow(this.total, size);
    this.key = grow(this.key, size);
    this.ring = grow(this.ring, size);
    this.rb = grow(this.rb, size);
    this.ri = grow(this.ri, size);
  }
}

function grow<A extends Int32Array | Uint16Array | Uint8Array | Float64Array>(
  a: A,
  size: number
): A {
  const b = new (a.constructor as new (size: number) => A)(size);
  b.set(a);
  return b;
}

/**
 * The exact-agreement counts of symbol `s` over the entries `E[0..m]` of `tab`: `out[k]` is its
 * count in `E[k]` clamped to `out[k − 1]`, so a context whose hash collided with another never
 * counts more than the shorter context it extends and every `out[k] − out[k + 1]` is non-negative.
 */
export function exactCounts(
  tab: Entries,
  E: Int32Array,
  m: number,
  s: number,
  out: Int32Array
): Int32Array {
  for (let k = 0; k <= m; k++) {
    const c = tab.count(E[k], s);
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
  /** The entries, of orders 0..order. */
  readonly tab: Entries;
  /** Context hashes of the current position, from `resolve()`. */
  readonly h: Float64Array;
  /** The current context's entries `E[0..m]`; `E[0]` is 0. */
  readonly E: Int32Array;
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

  constructor(o: PopulationOptions) {
    this.order = o.order;
    this.candidates = o.candidates;
    this.offsets = o.offsets;
    this.window = o.window ?? Infinity;
    this.cap = shl(1, o.capBits ?? 24);
    this.tab = new Entries(o.order);
    this.h = new Float64Array(o.order + 2);
    this.E = new Int32Array(o.order + 1);
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
    const tab = this.tab;
    this.n = hashes(this.seq, this.t, K, this.h);
    let m = -1;
    if (tab.n[0] > 0) {
      m = 0;
      for (let k = 1; k <= this.n; k++) {
        const x = tab.find(k, this.h[k]);
        if (x < 0) {
          break;
        }
        this.E[k] = x;
        m = k;
      }
    }
    this.m = m;
    this.nc = 0;
    if (m !== K) {
      this.mLen = 0;
      return;
    }
    const x = this.E[K];
    if (this.mLen < K) {
      this.mPos = tab.pos(x);
      this.mLen = 0;
    }
    if (tab.ring[x] !== 0) {
      const r = tab.chunks[tab.ring[x] - 1];
      const rb = tab.rb[x];
      const ri = tab.ri[x];
      const n = Math.min(ri, this.candidates);
      for (let i = 1; i <= n; i++) {
        this.addCandidate(r[rb + ((ri - i) % this.candidates)], 0);
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
    const tab = this.tab;
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
    const capped = tab.add(0, a, t) >= this.cap;
    for (let k = 1; k <= this.n; k++) {
      let x = k <= this.m ? this.E[k] : tab.find(k, this.h[k]);
      if (x < 0) {
        x = tab.make(k, this.h[k]);
      }
      tab.add(x, a, t, off);
      if (k === K && this.candidates > 0) {
        tab.remember(x, t, this.candidates);
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
      this.tab.halve();
    }
  }
}

/** The built-in population: order 0 and 1 from a prior's counts, with no positions. */
export class Frozen {
  readonly K = 1;
  readonly tab = new Entries(1);
  total = 0;
  /** The entries of the last `lookup`; `E[0]` is 0. */
  readonly E = new Int32Array(2);
  m = 0;

  /** Fills `E[0..m]` from another population's context hashes `h[1..n]`; returns m. */
  lookup(h: Float64Array, n: number): number {
    let m = 0;
    for (let k = 1; k <= this.K && k <= n; k++) {
      const x = this.tab.find(k, h[k]);
      if (x < 0) {
        break;
      }
      this.E[k] = x;
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
  const tab = f.tab;
  tab.load(0, END, prior.builtinCounts0[0]);
  for (let i = 0; i < symbols.length; i++) tab.load(0, got[i], prior.builtinCounts0[i + 1]);
  const seq = new Int32Array(1);
  const h = new Float64Array(2);
  w = symbols.length;
  for (const [, , c] of contexts) {
    seq[0] = got[w++];
    hashes(seq, 1, 1, h);
    let x = tab.find(1, h[1]);
    if (x < 0) {
      x = tab.make(1, h[1]);
    }
    tab.load(x, got[w++], c);
  }
  f.total = tab.total[0];
  FROZEN_CACHE.set(prior, { ids: got, f });
  return f;
}

/** Equal id lists; both come from one prior, so their lengths agree. */
function sameIds(a: Int32Array, b: Int32Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
