import {
  Arena,
  Entries,
  Frozen,
  OffsetRing,
  Population,
  frozen,
  STRIDE,
  hashes,
} from '../../predictor/tables';
import { END } from '../../predictor/types';

/** The first `n` symbols, counts, last positions or offsets of the followers of entry `x`. */
function col(
  tab: Entries,
  x: number,
  field: 'syms' | 'cnt' | 'last' | 'offs',
  n: number
): number[] {
  const word = { syms: 0, cnt: 1, last: 2, offs: 3 }[field];
  const d = tab.data(x);
  return Array.from({ length: n }, (_, j) => d[tab.base[x] + j * STRIDE + word]);
}

/** A deterministic generator in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** The prototype's `Entry` (predictor.ts 67–85) without the slot table. */
class RefEntry {
  syms: number[] = [];
  cnt: number[] = [];
  last: number[] = [];
  offs: number[] = [];
  pos = 0;
  total = 0;
  ring: Int32Array | null = null;
  ri = 0;
  add(s: number, t: number, off = 0): void {
    const j = this.syms.indexOf(s);
    if (j >= 0) {
      this.cnt[j]++;
      this.last[j] = t;
      this.offs[j] = off;
    } else {
      this.syms.push(s);
      this.cnt.push(1);
      this.last.push(t);
      this.offs.push(off);
    }
    this.pos = t;
    this.total++;
  }
}

const RING = 8;

/**
 * The prototype's `Pop` (predictor.ts 150–219) without the recency queues and the offset count
 * table, with its same-offset ring limited to offsets below 64 (D3) and this module's hashes.
 * It counts the times a broken match's distance was already listed and the times the list
 * overflowed.
 */
class RefPop {
  seq = new Int32Array(1 << 14);
  offs = new Int32Array(1 << 14);
  t = 1;
  maps: Map<number, RefEntry>[] = [];
  e0 = new RefEntry();
  mPos = 0;
  mLen = 0;
  mru: number[] = [];
  offRing = new Map<number, number[]>();
  h: Float64Array;
  E: RefEntry[] = [];
  m = 0;
  n = 0;
  cand: number[] = [];
  candL: number[] = [];
  nc = 0;
  repeats = 0;
  overflows = 0;
  constructor(
    public K: number,
    public ringN: number,
    public offCap: number
  ) {
    for (let k = 1; k <= K; k++) this.maps[k] = new Map();
    this.h = new Float64Array(K + 2);
  }
  resolve(): void {
    const K = this.K;
    const s = this.seq;
    const t = this.t;
    this.n = hashes(s, t, K, this.h);
    this.E[0] = this.e0;
    let m = 0;
    if (this.e0.syms.length) {
      for (let k = 1; k <= this.n; k++) {
        const e = this.maps[k].get(this.h[k]);
        if (!e) break;
        this.E[k] = e;
        m = k;
      }
    } else m = -1;
    this.m = m;
    this.nc = 0;
    this.cand = [];
    this.candL = [];
    if (m !== K) {
      this.mLen = 0;
      return;
    }
    const e = this.E[K];
    const r = e.ring!;
    if (this.mLen < K) {
      this.mPos = e.pos;
      this.mLen = 0;
    }
    const add = (p: number, known: number) => {
      for (let i = 0; i < this.nc; i++) if (this.cand[i] === p) return;
      let j = known > 0 ? known + 1 : 1;
      if (known <= 0) while (j <= 64 && p - j >= 0 && s[t - j] === s[p - j]) j++;
      this.cand[this.nc] = p;
      this.candL[this.nc++] = j - 1;
    };
    const n = Math.min(e.ri, this.ringN);
    for (let i = 1; i <= n; i++) add(r[(e.ri - i) % RING], 0);
    if (this.mLen >= K) add(this.mPos, this.mLen);
    else {
      let j = 1;
      while (j <= 64 && this.mPos - j >= 0 && s[t - j] === s[this.mPos - j]) j++;
      this.mLen = j - 1;
    }
  }
  update(a: number, off: number): void {
    const t = this.t;
    this.seq[t] = a;
    this.offs[t] = off;
    if (off < 64) {
      let r = this.offRing.get(off);
      if (!r) this.offRing.set(off, (r = []));
      r.push(t);
      if (r.length > this.offCap) r.shift();
    }
    this.e0.add(a, t);
    for (let k = 1; k <= this.n; k++) {
      let e = k <= this.m ? this.E[k] : this.maps[k].get(this.h[k]);
      if (!e) this.maps[k].set(this.h[k], (e = new RefEntry()));
      e.add(a, t, off);
      if (k === this.K) {
        if (!e.ring) e.ring = new Int32Array(RING);
        e.ring[e.ri++ % RING] = t;
      }
    }
    if (this.mLen > 0 && this.seq[this.mPos] === a) {
      this.mPos++;
      if (this.mLen < 64) this.mLen++;
    } else {
      if (this.mLen >= this.K) {
        const d = t - this.mPos;
        const i = this.mru.indexOf(d);
        if (i >= 0) {
          this.mru.splice(i, 1);
          this.repeats++;
        }
        this.mru.unshift(d);
        if (this.mru.length > 4) {
          this.mru.pop();
          this.overflows++;
        }
      }
      this.mLen = 0;
    }
    this.t = t + 1;
  }
}

function expectSameEntry(tab: Entries, x: number, r: RefEntry): void {
  const n = tab.n[x];
  expect(n).toBe(r.syms.length);
  expect(col(tab, x, 'syms', n)).toEqual(r.syms);
  expect(col(tab, x, 'cnt', n)).toEqual(r.cnt);
  expect(col(tab, x, 'last', n)).toEqual(r.last);
  expect(col(tab, x, 'offs', n)).toEqual(r.offs);
  expect(tab.total[x]).toBe(r.total);
  expect(tab.pos(x)).toBe(r.pos);
}

function expectSameState(p: Population, r: RefPop): void {
  expect(p.t).toBe(r.t);
  expect(p.m).toBe(r.m);
  expect(p.n).toBe(r.n);
  for (let k = 0; k <= p.m; k++) {
    expectSameEntry(p.tab, p.E[k], r.E[k]);
  }
  expect(p.nc).toBe(r.nc);
  expect(Array.from(p.cand.subarray(0, p.nc))).toEqual(r.cand);
  expect(Array.from(p.candL.subarray(0, p.nc))).toEqual(r.candL);
  expect(p.mPos).toBe(r.mPos);
  expect(p.mLen).toBe(r.mLen);
  expect(p.mru).toEqual(r.mru);
}

function ringContents(r: OffsetRing): number[] {
  const out: number[] = [];
  for (let i = 0; i < r.len; i++) out.push(r.at(i));
  return out;
}

/** Runs a population and the prototype side by side over `syms`, comparing after every resolve. */
function compare(
  syms: readonly number[],
  offs: readonly number[],
  order: number,
  candidates: number,
  offsets: number
): RefPop {
  const p = new Population({ order, candidates, offsets });
  const r = new RefPop(order, candidates, offsets);
  for (let i = 0; i < syms.length; i++) {
    p.resolve();
    r.resolve();
    expectSameState(p, r);
    p.update(syms[i], offs[i]);
    r.update(syms[i], offs[i]);
  }
  p.resolve();
  r.resolve();
  expectSameState(p, r);
  expect(Array.from(p.seq.subarray(0, p.t))).toEqual(Array.from(r.seq.subarray(0, r.t)));
  expect(Array.from(p.offs.subarray(0, p.t))).toEqual(Array.from(r.offs.subarray(0, r.t)));
  const keys = [...p.offRing.keys()].sort((a, b) => a - b);
  const refKeys = [...r.offRing.keys()].sort((a, b) => a - b);
  expect(keys).toEqual(refKeys);
  for (const [off, ring] of p.offRing) {
    expect(ringContents(ring)).toEqual(r.offRing.get(off));
  }
  return r;
}

describe('Arena', () => {
  it('cuts power-of-two regions from one chunk and reuses freed ones zeroed', () => {
    const a = new Arena();
    a.alloc(8);
    const id = a.id;
    const chunk = a.chunks[id];
    expect(a.b).toBe(0);
    chunk[3] = 5;
    a.alloc(5);
    expect(a.id).toBe(id);
    expect(a.b).toBe(8);
    a.free(id, 0, 8);
    a.alloc(7);
    expect(a.id).toBe(id);
    expect(a.b).toBe(0);
    expect(chunk[3]).toBe(0);
    a.alloc(8);
    expect(a.b).toBe(16);
  });

  it('starts a new chunk when one is full, doubling chunks from 1024 words to 65536', () => {
    const a = new Arena();
    a.alloc(4);
    const first = a.id;
    expect(a.chunks[first].length).toBe(1024);
    a.alloc(1024);
    expect(a.id).not.toBe(first);
    expect([a.b, a.chunks[a.id].length]).toEqual([0, 2048]);
    a.alloc(1024);
    expect(a.b).toBe(1024);
    a.alloc(16384);
    expect([a.b, a.chunks[a.id].length]).toEqual([0, 16384]);
    a.alloc(16384);
    expect([a.b, a.chunks[a.id].length]).toEqual([0, 32768]);
    a.alloc(16384);
    expect(a.b).toBe(16384);
    a.alloc(16384);
    expect([a.b, a.chunks[a.id].length]).toEqual([0, 65536]);
    a.alloc(16384);
    a.alloc(16384);
    a.alloc(16384);
    a.alloc(16384);
    expect([a.b, a.chunks[a.id].length]).toEqual([0, 65536]);
    expect(a.chunks.length).toBe(6);
  });

  it('gives a region above a quarter chunk its own array and drops it when freed', () => {
    const a = new Arena();
    a.alloc(20000);
    const own = a.id;
    expect(a.chunks[own].length).toBe(20000);
    expect(a.b).toBe(0);
    a.free(own, 0, 32768);
    expect(a.chunks[own].length).toBe(0);
    a.alloc(32768);
    expect(a.id).not.toBe(own);
    expect(a.chunks[a.id].length).toBe(32768);
  });
});

describe('Entries', () => {
  it('counts followers in a hashed entry and grows past its capacity', () => {
    const tab = new Entries(1);
    const x = tab.make(1, 42);
    expect(tab.size).toBe(2);
    expect(tab.find(1, 42)).toBe(x);
    expect(tab.find(1, 43)).toBe(-1);
    expect(tab.indexOf(x, 7)).toBe(-1);
    expect(tab.add(x, 7, 3, 2)).toBe(1);
    expect(tab.add(x, 9, 4)).toBe(1);
    expect(tab.add(x, 11, 5, 1)).toBe(1);
    expect(tab.add(x, 7, 6, 5)).toBe(2);
    expect(tab.add(x, 13, 8)).toBe(1);
    expect(tab.n[x]).toBe(4);
    expect(tab.total[x]).toBe(5);
    expect(tab.pos(x)).toBe(8);
    expect(tab.indexOf(x, 11)).toBe(2);
    expect(tab.indexOf(x, 12)).toBe(-1);
    expect(tab.has(x, 13)).toBe(true);
    expect(tab.has(x, 12)).toBe(false);
    expect(tab.count(x, 7)).toBe(2);
    expect(tab.count(x, 12)).toBe(0);
    expect(col(tab, x, 'last', 1)[0]).toBe(6);
    expect(col(tab, x, 'offs', 1)[0]).toBe(5);
    expect(col(tab, x, 'offs', 2)[1]).toBe(0);
  });

  it('grows its columns past 128 entries and finds every entry', () => {
    const tab = new Entries(2);
    const xs: number[] = [];
    for (let i = 0; i < 300; i++) {
      const x = tab.make(1 + (i % 2), 1000 + i);
      xs.push(x);
      tab.add(x, 300 + i, i + 1);
    }
    expect(tab.size).toBe(301);
    expect(tab.n.length).toBeGreaterThanOrEqual(301);
    xs.forEach((x, i) => {
      expect(tab.find(1 + (i % 2), 1000 + i)).toBe(x);
      expect(tab.find(2 - (i % 2), 1000 + i)).toBe(-1);
      expect(tab.count(x, 300 + i)).toBe(1);
      expect(tab.pos(x)).toBe(i + 1);
    });
  });

  it('indexes order-0 followers by symbol and grows the slot table', () => {
    const tab = new Entries(0);
    tab.add(0, 3, 1);
    tab.add(0, 1000, 2);
    tab.add(0, 3, 3);
    expect(tab.slot.length).toBeGreaterThan(1000);
    expect(tab.indexOf(0, 3)).toBe(0);
    expect(tab.indexOf(0, 1000)).toBe(1);
    expect(tab.indexOf(0, 4)).toBe(-1);
    expect(tab.indexOf(0, 5000)).toBe(-1);
    expect(tab.has(0, 1000)).toBe(true);
    expect(tab.count(0, 3)).toBe(2);
    expect(tab.total[0]).toBe(3);
  });

  it('moves the order-0 followers to larger regions past 16', () => {
    const tab = new Entries(0);
    for (let s = 0; s < 40; s++) tab.add(0, s, s + 1, s % 3);
    expect(tab.n[0]).toBe(40);
    expect(col(tab, 0, 'syms', 40)).toEqual(Array.from({ length: 40 }, (_, s) => s));
    expect(col(tab, 0, 'offs', 3)).toEqual([0, 1, 2]);
    expect(tab.count(0, 39)).toBe(1);
    expect(tab.pos(0)).toBe(40);
  });

  it('moves hashed followers into an array of its own and frees it on the next move', () => {
    const tab = new Entries(1);
    const x = tab.make(1, 5);
    const y = tab.make(1, 6);
    tab.add(y, 1, 1);
    for (let s = 0; s < 4097; s++) tab.add(x, s, s + 1);
    const own = tab.chunk[x];
    expect(tab.chunks[own].length).toBe(32768);
    expect(tab.base[x]).toBe(0);
    for (let s = 4097; s < 8193; s++) tab.add(x, s, s + 1);
    expect(tab.chunks[own].length).toBe(0);
    expect(tab.chunk[x]).not.toBe(own);
    expect(tab.n[x]).toBe(8193);
    expect(col(tab, x, 'syms', 8193)).toEqual(Array.from({ length: 8193 }, (_, s) => s));
    expect(tab.count(x, 8192)).toBe(1);
    expect(tab.count(y, 1)).toBe(1);
  });

  it('loads counts without positions', () => {
    const tab = new Entries(1);
    const x = tab.make(1, 9);
    tab.load(x, 5, 4);
    tab.load(x, 6, 2);
    tab.load(x, 5, 3);
    expect(tab.count(x, 5)).toBe(7);
    expect(tab.count(x, 6)).toBe(2);
    expect(tab.total[x]).toBe(9);
    expect(tab.pos(x)).toBe(0);
    expect(col(tab, x, 'last', 1)[0]).toBe(0);
  });

  it('halves every count of every entry, keeping at least 1', () => {
    const tab = new Entries(1);
    const x = tab.make(1, 9);
    tab.load(x, 1, 9);
    tab.load(x, 2, 1);
    tab.load(x, 3, 4);
    tab.load(0, 8, 6);
    tab.halve();
    expect(col(tab, x, 'cnt', 3)).toEqual([4, 1, 2]);
    expect(tab.total[x]).toBe(7);
    expect(tab.count(0, 8)).toBe(3);
    expect(tab.total[0]).toBe(3);
  });

  it('keeps ring positions through the byte counter stepping back', () => {
    const tab = new Entries(1);
    const x = tab.make(1, 9);
    const y = tab.make(1, 10);
    expect(tab.ring[x]).toBe(0);
    for (let t = 1; t <= 7; t++) tab.remember(x, t, 4);
    expect(tab.ri[x]).toBe(7);
    tab.remember(x, 8, 4);
    expect(tab.ri[x]).toBe(4);
    for (let t = 9; t <= 100; t++) tab.remember(x, t, 4);
    const r = tab.chunks[tab.ring[x] - 1];
    const newest = (i: number): number => r[tab.rb[x] + ((tab.ri[x] - i) % 4)];
    expect([1, 2, 3, 4].map(newest)).toEqual([100, 99, 98, 97]);
    expect(tab.ri[x]).toBeLessThan(8);
    expect(tab.ri[x] % 4).toBe(100 % 4);
    tab.remember(y, 3, 4);
    expect(tab.ring[y]).not.toBe(0);
    expect(tab.ri[y]).toBe(1);
  });
});

describe('hashes', () => {
  /** The prototype's 30-bit hashes (predictor.ts 98–106, CTX_NL off). */
  function protoHashes(seq: Int32Array, t: number, n: number): number[] {
    const out: number[] = [];
    let h = 0;
    for (let k = 1; k <= n && k <= t; k++) {
      h = Math.imul(h ^ (seq[t - k] + 0x9e37), 0x85ebca6b);
      h ^= h >>> 13;
      h = Math.imul(h, 0xc2b2ae35);
      out[k] = (h ^ (h >>> 16)) & 0x3fffffff;
    }
    return out;
  }

  it('keys the last k symbols with 48 bits that extend the prototype hash', () => {
    const seq = Int32Array.from([0, 300, 301, 302, 300, 301]);
    const out = new Float64Array(5);
    expect(hashes(seq, 6, 3, out)).toBe(3);
    const proto = protoHashes(seq, 6, 3);
    for (let k = 1; k <= 3; k++) {
      expect(Number.isSafeInteger(out[k])).toBe(true);
      expect(out[k]).toBeGreaterThanOrEqual(0);
      expect(out[k]).toBeLessThan(2 ** 48);
      expect(Math.floor(out[k] / 65536) % 2 ** 30).toBe(proto[k]);
    }
    expect(hashes(seq, 2, 3, out)).toBe(2);
    expect(hashes(seq, 0, 3, out)).toBe(0);
  });

  it('depends on the last k symbols only', () => {
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    hashes(Int32Array.from([0, 5, 6, 7, 8]), 5, 2, a);
    hashes(Int32Array.from([0, 9, 7, 8]), 4, 2, b);
    expect(a[1]).toBe(b[1]);
    expect(a[2]).toBe(b[2]);
    hashes(Int32Array.from([0, 9, 6, 8]), 4, 2, b);
    expect(a[1]).toBe(b[1]);
    expect(a[2]).not.toBe(b[2]);
    expect(a[1]).not.toBe(a[2]);
  });
});

describe('OffsetRing', () => {
  it('keeps the last positions, oldest first', () => {
    const r = new OffsetRing(3);
    r.push(4);
    r.push(9);
    expect(ringContents(r)).toEqual([4, 9]);
    r.push(11);
    r.push(15);
    expect(r.len).toBe(3);
    expect(ringContents(r)).toEqual([9, 11, 15]);
  });
});

describe('Population', () => {
  // a b c a b c a b d a b c a b c a b c a b
  const A = 292;
  const B = 293;
  const C = 294;
  const D = 295;
  const text = [A, B, C, A, B, C, A, B, D, A, B, C, A, B, C, A, B, C, A, B];

  it('reproduces a hand-built order-2 example', () => {
    const p = new Population({ order: 2, candidates: 8, offsets: 64 });
    expect(p.window).toBe(Infinity);
    p.resolve();
    expect(p.m).toBe(-1);
    expect(p.n).toBe(1);
    text.forEach((s, i) => {
      if (i > 0) p.resolve();
      p.update(s, i);
    });
    p.resolve();
    expect(p.t).toBe(21);
    expect(p.n).toBe(2);
    expect(p.m).toBe(2);
    const tab = p.tab;
    const [x0, x1, x2] = p.E;
    expect(x0).toBe(0);
    expect([A, B, C, D].map((s) => tab.count(0, s))).toEqual([7, 7, 5, 1]);
    expect(tab.total[0]).toBe(20);
    for (const x of [x1, x2]) {
      expect(tab.n[x]).toBe(2);
      expect(col(tab, x, 'syms', 2)).toEqual([C, D]);
      expect(col(tab, x, 'cnt', 2)).toEqual([5, 1]);
      expect(col(tab, x, 'last', 2)).toEqual([18, 9]);
      expect(col(tab, x, 'offs', 2)).toEqual([17, 8]);
      expect(tab.total[x]).toBe(6);
      expect(tab.pos(x)).toBe(18);
    }
    expect(tab.ring[x1]).toBe(0);
    expect(tab.ri[x2]).toBe(6);
    expect(p.nc).toBe(6);
    expect(Array.from(p.cand.subarray(0, 6))).toEqual([18, 15, 12, 9, 6, 3]);
    expect(Array.from(p.candL.subarray(0, 6))).toEqual([8, 5, 2, 8, 5, 2]);
    expect(p.mPos).toBe(18);
    expect(p.mLen).toBe(8);
    expect(p.mru).toEqual([6, 3]);
    expect(p.agreement(18)).toBe(8);
    expect(p.agreement(3)).toBe(2);
  });

  it('matches the prototype on the hand-built example', () => {
    const offs = text.map((_, i) => i);
    compare(text, offs, 2, 8, 64);
  });

  it('matches the prototype on random sequences', () => {
    let repeats = 0;
    let overflows = 0;
    for (const [seed, order, candidates, alphabet] of [
      [1, 2, 8, 2],
      [2, 3, 3, 3],
      [3, 1, 5, 4],
      [4, 4, 8, 2],
    ]) {
      const next = rng(seed);
      const syms: number[] = [];
      const offs: number[] = [];
      let off = 0;
      for (let i = 0; i < 1500; i++) {
        syms.push(292 + Math.floor(next() * alphabet));
        offs.push(off);
        off = next() < 0.05 ? 0 : off + 1;
      }
      const r = compare(syms, offs, order, candidates, 6);
      repeats += r.repeats;
      overflows += r.overflows;
    }
    expect(repeats).toBeGreaterThan(0);
    expect(overflows).toBeGreaterThan(0);
  });

  it('caps the long match at 64 on a repeated phrase', () => {
    const phrase = [300, 301, 302, 303, 304, 305, 306, 307];
    const syms: number[] = [];
    for (let i = 0; i < 20; i++) syms.push(...phrase);
    const offs = syms.map(() => 0);
    compare(syms, offs, 2, 4, 64);
    const p = new Population({ order: 2, candidates: 4, offsets: 64 });
    for (const s of syms) {
      p.resolve();
      p.update(s);
    }
    p.resolve();
    expect(p.mLen).toBe(64);
    expect(p.mPos).toBe(p.t - 8);
    expect(Array.from(p.candL.subarray(0, p.nc))).toEqual([64, 64, 64, 64]);
    expect(Array.from(p.cand.subarray(0, p.nc))).toEqual([153, 145, 137, 129]);
  });

  it('keeps no rings without candidates and still follows the match', () => {
    const p = new Population({ order: 2, candidates: 0, offsets: 64 });
    text.forEach((s, i) => {
      p.resolve();
      p.update(s, i);
    });
    p.resolve();
    expect(p.m).toBe(2);
    expect(p.tab.ring[p.E[2]]).toBe(0);
    expect(p.nc).toBe(1);
    expect(p.cand[0]).toBe(18);
    expect(p.candL[0]).toBe(8);
    expect(p.mru).toEqual([6, 3]);
  });

  it('rings offsets below 64 only, each capped at `offsets`', () => {
    const p = new Population({ order: 1, candidates: 1, offsets: 3 });
    for (const off of [0, 1, 0, 0, 64, 0, 70]) {
      p.resolve();
      p.update(300, off);
    }
    expect([...p.offRing.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(ringContents(p.offRing.get(0)!)).toEqual([3, 4, 6]);
    expect(ringContents(p.offRing.get(1)!)).toEqual([2]);
    const q = new Population({ order: 1, candidates: 1, offsets: 0 });
    q.resolve();
    q.update(300, 0);
    expect(q.offRing.size).toBe(0);
  });

  it('halves every count when one reaches the cap', () => {
    const a = 300;
    const b = 301;
    const p = new Population({ order: 1, candidates: 2, offsets: 8, capBits: 2 });
    for (const s of [a, b, a, a]) {
      p.resolve();
      p.update(s);
    }
    const tab = p.tab;
    expect(tab.count(0, a)).toBe(3);
    p.resolve();
    const afterA = p.E[1];
    p.update(a);
    expect(tab.count(0, a)).toBe(2);
    expect(tab.count(0, b)).toBe(1);
    expect(tab.total[0]).toBe(3);
    expect(tab.count(afterA, b)).toBe(1);
    expect(tab.count(afterA, a)).toBe(1);
    expect(tab.total[afterA]).toBe(2);
    p.resolve();
    expect(p.m).toBe(1);
    expect(p.E[1]).toBe(afterA);
  });

  it('halves after every `window` symbols', () => {
    const p = new Population({ order: 1, candidates: 2, offsets: 8, window: 3 });
    const counts: number[] = [];
    for (let i = 0; i < 7; i++) {
      p.resolve();
      p.update(300);
      counts.push(p.tab.count(0, 300));
    }
    expect(counts).toEqual([1, 2, 1, 2, 3, 2, 3]);
    p.tab.halve();
    expect(p.tab.count(0, 300)).toBe(1);
  });
});

describe('frozen', () => {
  const ids = new Map<number, number>([
    [97, 292],
    [98, 293],
    [99, 294],
  ]);
  const fake = { idOf: (cp: number): number => ids.get(cp)! };
  const prior = {
    builtinSymbols: [97, 98],
    builtinCounts0: [3, 5, 2],
    builtinContexts1: [
      [-1, 97, 2],
      [97, -1, 1],
      [97, 98, 4],
      [98, 97, 1],
    ] as const,
  };

  it('builds orders 0 and 1 with the session ids', () => {
    const f = frozen(prior, fake);
    expect(f).toBeInstanceOf(Frozen);
    expect(f.K).toBe(1);
    expect(col(f.tab, 0, 'syms', 3)).toEqual([END, 292, 293]);
    expect(col(f.tab, 0, 'cnt', 3)).toEqual([3, 5, 2]);
    expect(f.tab.total[0]).toBe(10);
    expect(f.total).toBe(10);

    const h = new Float64Array(3);
    hashes(Int32Array.from([END, 292]), 2, 1, h);
    expect(f.lookup(h, 1)).toBe(1);
    expect(f.m).toBe(1);
    expect(f.E[0]).toBe(0);
    const e = f.E[1];
    expect(f.tab.count(e, 293)).toBe(4);
    expect(f.tab.count(e, END)).toBe(1);
    expect(f.tab.total[e]).toBe(5);
    expect(col(f.tab, e, 'last', 1)[0]).toBe(0);

    hashes(Int32Array.from([END]), 1, 1, h);
    expect(f.lookup(h, 1)).toBe(1);
    expect(f.tab.count(f.E[1], 292)).toBe(2);

    expect(f.lookup(h, 0)).toBe(0);
    hashes(Int32Array.from([END, 294]), 2, 1, h);
    expect(f.lookup(h, 1)).toBe(0);
  });

  it('looks up with a population’s hashes', () => {
    const f = frozen(prior, fake);
    const p = new Population({ order: 3, candidates: 2, offsets: 8 });
    for (const s of [292, 293]) {
      p.resolve();
      p.update(s);
    }
    p.resolve();
    expect(f.lookup(p.h, p.n)).toBe(1);
    expect(f.tab.count(f.E[1], 292)).toBe(1);
  });

  it('takes -1 - s as structure id s', () => {
    const f = frozen(
      { builtinSymbols: [97, -2], builtinCounts0: [1, 2, 3], builtinContexts1: [[-2, 97, 3]] },
      fake
    );
    expect(col(f.tab, 0, 'syms', 3)).toEqual([END, 292, 1]);
    const h = new Float64Array(3);
    hashes(Int32Array.from([END, 1]), 2, 1, h);
    expect(f.lookup(h, 1)).toBe(1);
    expect(f.tab.count(f.E[1], 292)).toBe(3);
  });

  it('shares the population of a prior while the ids agree, and rebuilds when they differ', () => {
    const f = frozen(prior, fake);
    expect(frozen(prior, fake)).toBe(f);
    const other = { idOf: (cp: number): number => ids.get(cp)! + 10 };
    const g = frozen(prior, other);
    expect(g).not.toBe(f);
    expect(col(g.tab, 0, 'syms', 3)).toEqual([END, 302, 303]);
    expect(frozen(prior, other)).toBe(g);
  });

  it('takes a table seeded from the prior at its word, and checks any other', () => {
    const own = { ...prior };
    let asked = 0;
    const seeded = {
      idOf: (cp: number): number => {
        asked++;
        return ids.get(cp)!;
      },
      seededFrom: own,
    };
    const f = frozen(own, seeded);
    expect(asked).toBe(8);
    expect(frozen(own, seeded)).toBe(f);
    expect(asked).toBe(8);
    expect(frozen(own, { ...seeded, seededFrom: prior })).toBe(f);
    expect(asked).toBe(16);
    expect(frozen(own, fake)).toBe(f);

    const other = { idOf: (cp: number): number => ids.get(cp)! + 10 };
    const g = frozen(own, other);
    expect(g).not.toBe(f);
    const h = frozen(own, seeded);
    expect(h).not.toBe(g);
    expect(col(h.tab, 0, 'syms', 3)).toEqual([END, 292, 293]);
    expect(frozen(own, seeded)).toBe(h);

    const fresh = { ...prior };
    expect(frozen(fresh, other)).not.toBe(g);
    expect(frozen(fresh, { ...other, seededFrom: fresh })).toBe(frozen(fresh, other));
  });
});
