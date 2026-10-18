import {
  Entry,
  Frozen,
  OffsetRing,
  Population,
  exactCounts,
  frozen,
  hashes,
} from '../../predictor/tables';
import { END } from '../../predictor/types';

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
  top = 0;
  ring: Int32Array | null = null;
  ri = 0;
  add(s: number, t: number, off = 0): void {
    const j = this.syms.indexOf(s);
    if (j >= 0) {
      const c = ++this.cnt[j];
      this.last[j] = t;
      this.offs[j] = off;
      if (c > this.top) this.top = c;
    } else {
      if (this.top < 1) this.top = 1;
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

function expectSameEntry(e: Entry, r: RefEntry): void {
  expect(e.n).toBe(r.syms.length);
  expect(Array.from(e.syms.subarray(0, e.n))).toEqual(r.syms);
  expect(Array.from(e.cnt.subarray(0, e.n))).toEqual(r.cnt);
  expect(Array.from(e.last.subarray(0, e.n))).toEqual(r.last);
  expect(Array.from(e.offs.subarray(0, e.n))).toEqual(r.offs);
  expect(e.total).toBe(r.total);
  expect(e.top).toBe(r.top);
  expect(e.pos).toBe(r.pos);
}

function expectSameState(p: Population, r: RefPop): void {
  expect(p.t).toBe(r.t);
  expect(p.m).toBe(r.m);
  expect(p.n).toBe(r.n);
  for (let k = 0; k <= p.m; k++) {
    expectSameEntry(p.E[k], r.E[k]);
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

describe('Entry', () => {
  it('counts followers in a linear entry and grows past its capacity', () => {
    const e = new Entry();
    expect(e.slot).toBeNull();
    expect(e.indexOf(7)).toBe(-1);
    expect(e.add(7, 3, 2)).toBe(1);
    expect(e.add(9, 4)).toBe(1);
    expect(e.add(11, 5, 1)).toBe(1);
    expect(e.add(7, 6, 5)).toBe(2);
    expect(e.add(13, 8)).toBe(1);
    expect(e.n).toBe(4);
    expect(e.total).toBe(5);
    expect(e.top).toBe(2);
    expect(e.pos).toBe(8);
    expect(e.indexOf(11)).toBe(2);
    expect(e.indexOf(12)).toBe(-1);
    expect(e.has(13)).toBe(true);
    expect(e.has(12)).toBe(false);
    expect(e.count(7)).toBe(2);
    expect(e.count(12)).toBe(0);
    expect(e.last[0]).toBe(6);
    expect(e.offs[0]).toBe(5);
    expect(e.offs[1]).toBe(0);
  });

  it('indexes order-0 followers by symbol and grows the slot table', () => {
    const e = new Entry(true);
    expect(e.slot).not.toBeNull();
    e.add(3, 1);
    e.add(1000, 2);
    e.add(3, 3);
    expect(e.slot!.length).toBeGreaterThan(1000);
    expect(e.indexOf(3)).toBe(0);
    expect(e.indexOf(1000)).toBe(1);
    expect(e.indexOf(4)).toBe(-1);
    expect(e.indexOf(5000)).toBe(-1);
    expect(e.has(1000)).toBe(true);
    expect(e.count(3)).toBe(2);
    expect(e.total).toBe(3);
    expect(e.top).toBe(2);
  });

  it('loads counts without positions', () => {
    const e = new Entry();
    e.load(5, 4);
    e.load(6, 2);
    e.load(5, 3);
    expect(e.count(5)).toBe(7);
    expect(e.count(6)).toBe(2);
    expect(e.total).toBe(9);
    expect(e.top).toBe(7);
    expect(e.pos).toBe(0);
    expect(e.last[0]).toBe(0);
  });

  it('halves every count, keeping at least 1', () => {
    const e = new Entry();
    e.load(1, 9);
    e.load(2, 1);
    e.load(3, 4);
    e.halve();
    expect(Array.from(e.cnt.subarray(0, e.n))).toEqual([4, 1, 2]);
    expect(e.total).toBe(7);
    expect(e.top).toBe(4);
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

describe('exactCounts', () => {
  it('clamps each level to the one below it', () => {
    const e0 = new Entry(true);
    const e1 = new Entry();
    const e2 = new Entry();
    e0.load(4, 3);
    e0.load(5, 6);
    e1.load(4, 1);
    e1.load(5, 6);
    e2.load(4, 5);
    e2.load(5, 2);
    const out = new Int32Array(3);
    expect(Array.from(exactCounts([e0, e1, e2], 2, 4, out))).toEqual([3, 1, 1]);
    expect(Array.from(exactCounts([e0, e1, e2], 2, 5, out))).toEqual([6, 6, 2]);
    expect(Array.from(exactCounts([e0, e2, e1], 2, 5, out))).toEqual([6, 2, 2]);
    expect(Array.from(exactCounts([e0, e1, e2], 2, 9, out))).toEqual([0, 0, 0]);
    out.fill(7);
    exactCounts([e0, e1, e2], 1, 4, out);
    expect(Array.from(out)).toEqual([3, 1, 7]);
  });

  it('gives non-negative exact-level counts on populations', () => {
    const next = rng(7);
    const p = new Population({ order: 3, candidates: 4, offsets: 8 });
    const out = new Int32Array(4);
    for (let i = 0; i < 400; i++) {
      p.resolve();
      for (let s = 292; s < 295; s++) {
        exactCounts(p.E, p.m, s, out);
        for (let k = 0; k < p.m; k++) {
          expect(out[k] - out[k + 1]).toBeGreaterThanOrEqual(0);
        }
      }
      p.update(292 + Math.floor(next() * 3), i % 5);
    }
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
    const [e0, e1, e2] = p.E;
    expect(e0).toBe(p.e0);
    expect([A, B, C, D].map((s) => e0.count(s))).toEqual([7, 7, 5, 1]);
    expect(e0.total).toBe(20);
    expect(e0.top).toBe(7);
    for (const e of [e1, e2]) {
      expect(e.n).toBe(2);
      expect(Array.from(e.syms.subarray(0, 2))).toEqual([C, D]);
      expect(Array.from(e.cnt.subarray(0, 2))).toEqual([5, 1]);
      expect(Array.from(e.last.subarray(0, 2))).toEqual([18, 9]);
      expect(Array.from(e.offs.subarray(0, 2))).toEqual([17, 8]);
      expect(e.total).toBe(6);
      expect(e.top).toBe(5);
      expect(e.pos).toBe(18);
    }
    expect(e1.ring).toBeNull();
    expect(e2.ri).toBe(6);
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
    expect(p.E[2].ring).toBeNull();
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
    expect(p.e0.count(a)).toBe(3);
    p.resolve();
    const afterA = p.E[1];
    p.update(a);
    expect(p.e0.count(a)).toBe(2);
    expect(p.e0.count(b)).toBe(1);
    expect(p.e0.total).toBe(3);
    expect(p.e0.top).toBe(2);
    expect(afterA.count(b)).toBe(1);
    expect(afterA.count(a)).toBe(1);
    expect(afterA.total).toBe(2);
    expect(afterA.top).toBe(1);
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
      counts.push(p.e0.count(300));
    }
    expect(counts).toEqual([1, 2, 1, 2, 3, 2, 3]);
    p.halve();
    expect(p.e0.count(300)).toBe(1);
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
    expect(Array.from(f.e0.syms.subarray(0, 3))).toEqual([END, 292, 293]);
    expect(Array.from(f.e0.cnt.subarray(0, 3))).toEqual([3, 5, 2]);
    expect(f.e0.total).toBe(10);
    expect(f.e0.top).toBe(5);
    expect(f.total).toBe(10);

    const h = new Float64Array(3);
    hashes(Int32Array.from([END, 292]), 2, 1, h);
    expect(f.lookup(h, 1)).toBe(1);
    expect(f.m).toBe(1);
    expect(f.E[0]).toBe(f.e0);
    const e = f.E[1];
    expect(e.count(293)).toBe(4);
    expect(e.count(END)).toBe(1);
    expect(e.total).toBe(5);
    expect(e.top).toBe(4);
    expect(e.last[0]).toBe(0);

    hashes(Int32Array.from([END]), 1, 1, h);
    expect(f.lookup(h, 1)).toBe(1);
    expect(f.E[1].count(292)).toBe(2);

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
    expect(f.E[1].count(292)).toBe(1);
  });
});
