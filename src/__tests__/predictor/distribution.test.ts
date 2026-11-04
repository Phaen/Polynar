import { Distribution } from '../../predictor/distribution';
import { ESCAPE } from '../../predictor/types';

/** A deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(
  total: number,
  entries: [number, number][],
  escape?: number,
  d = new Distribution()
): Distribution {
  d.begin(total, escape !== undefined);
  for (const [id, mass] of entries) d.add(id, mass);
  d.finish(escape ?? 0);
  return d;
}

function invariants(d: Distribution): void {
  let sum = 0;
  for (let i = 0; i < d.n; i++) {
    expect(d.freq(i)).toBeGreaterThanOrEqual(1);
    expect(d.cum(i)).toBe(sum);
    sum += d.freq(i);
  }
  expect(sum).toBe(d.total);
  const last = d.hasEscape ? d.n - 1 : d.n;
  for (let i = 1; i < last; i++) expect(d.idAt(i)).toBeGreaterThan(d.idAt(i - 1));
  if (d.hasEscape) expect(d.idAt(d.n - 1)).toBe(ESCAPE);
}

describe('Distribution', () => {
  it('quantises as spec §5.5: floor of 1, remainder to the largest', () => {
    const d = build(16, [
      [5, 3],
      [2, 1],
      [9, 0],
    ]);
    expect(d.n).toBe(3);
    expect(d.hasEscape).toBe(false);
    expect([d.idAt(0), d.idAt(1), d.idAt(2)]).toEqual([2, 5, 9]);
    // room 13: f = 1 + floor(P · 12 / 4) = 4, 10, 1; the remainder 1 goes to id 5.
    expect([d.freq(0), d.freq(1), d.freq(2)]).toEqual([4, 11, 1]);
    expect([d.cum(0), d.cum(1), d.cum(2)]).toEqual([0, 4, 15]);
    invariants(d);
  });

  it('breaks ties toward the lowest entry and puts ESCAPE last', () => {
    const d = build(
      16,
      [
        [7, 2],
        [3, 2],
      ],
      2
    );
    expect(d.n).toBe(3);
    expect(d.hasEscape).toBe(true);
    expect([d.idAt(0), d.idAt(1), d.idAt(2)]).toEqual([3, 7, ESCAPE]);
    // room 13: f = 1 + floor(2 · 12 / 6) = 5 each; the remainder 1 goes to entry 0.
    expect([d.freq(0), d.freq(1), d.freq(2)]).toEqual([6, 5, 5]);
    invariants(d);
  });

  it('gives every entry 1 and entry 0 the rest under a zero mass', () => {
    const d = build(
      4096,
      [
        [4, 0],
        [1, 0],
      ],
      0
    );
    expect([d.freq(0), d.freq(1), d.freq(2)]).toEqual([4094, 1, 1]);
    const e = build(4096, [], 0);
    expect([e.n, e.freq(0), e.idAt(0)]).toEqual([1, 4096, ESCAPE]);
  });

  it('scales large masses down before the products', () => {
    const big = 2 ** 51;
    const d = build(65536, [
      [1, big],
      [2, big / 2],
      [3, 1],
    ]);
    invariants(d);
    expect(d.freq(2)).toBe(1);
    expect(Math.abs(d.freq(0) - 2 * d.freq(1))).toBeLessThanOrEqual(2);
  });

  it('throws when 2n exceeds the total or the table is empty', () => {
    const d = new Distribution();
    expect(() => build(4, [[1, 1]], 1, d)).not.toThrow();
    expect(() =>
      build(
        4,
        [
          [1, 1],
          [2, 1],
        ],
        1,
        d
      )
    ).toThrow(RangeError);
    expect(() => build(16, [], undefined, d)).toThrow(RangeError);
  });

  it('inverts indexOf/idAt and locate/cum on random tables, growing as needed', () => {
    const r = rng(7);
    const d = new Distribution();
    for (let round = 0; round < 60; round++) {
      const total = 2 ** (12 + Math.floor(r() * 13));
      const n = 1 + Math.floor(r() * Math.min(600, total / 2 - 1));
      const ids = new Set<number>();
      while (ids.size < n) ids.add(Math.floor(r() * 0x110000));
      const escape = r() < 0.5 ? Math.floor(r() * 2 ** 40) : undefined;
      const entries: [number, number][] = [...ids].map((id) => [
        id,
        Math.floor(r() * 2 ** Math.floor(r() * 52)),
      ]);
      build(total, entries, escape, d);
      invariants(d);
      expect(d.n).toBe(n + (escape === undefined ? 0 : 1));
      for (const id of ids) expect(d.idAt(d.indexOf(id))).toBe(id);
      expect(d.indexOf(-5 as number)).toBe(-1);
      expect(d.indexOf(0x110000)).toBe(-1);
      expect(d.indexOf(ESCAPE)).toBe(escape === undefined ? -1 : d.n - 1);
      for (let k = 0; k < 50; k++) {
        const res = Math.floor(r() * total);
        const i = d.locate(res);
        expect(d.cum(i)).toBeLessThanOrEqual(res);
        expect(res).toBeLessThan(d.cum(i) + d.freq(i));
      }
      expect(d.locate(0)).toBe(0);
      expect(d.locate(total - 1)).toBe(d.n - 1);
    }
  });

  it('follows the masses within the quantisation step', () => {
    const r = rng(3);
    const masses = Array.from({ length: 40 }, () => Math.floor(r() * 2 ** 30));
    const d = build(
      65536,
      masses.map((m, i): [number, number] => [i, m])
    );
    const z = masses.reduce((a, b) => a + b, 0);
    for (let i = 0; i < 40; i++) {
      const ideal = 1 + (masses[i] * (65536 - 41)) / z;
      expect(Math.abs(d.freq(i) - ideal)).toBeLessThanOrEqual(41);
    }
  });

  describe('rescaleTop', () => {
    it('gives the top entry its share and keeps every other entry at least 1', () => {
      const d = build(
        4096,
        [
          [1, 100],
          [2, 50],
          [3, 25],
        ],
        10
      );
      d.rescaleTop(0, 49152);
      invariants(d);
      expect(Math.abs(d.freq(0) - 3072)).toBeLessThanOrEqual(d.n);
      expect(d.freq(1)).toBeGreaterThan(d.freq(2));
    });

    it('clamps the share to [1, total − (n − 1)]', () => {
      const d = build(4096, [
        [1, 100],
        [2, 50],
      ]);
      d.rescaleTop(0, 65536);
      expect([d.freq(0), d.freq(1)]).toEqual([4095, 1]);
      invariants(d);
      // Every other entry sits at its floor: the remainder stays with the top.
      d.rescaleTop(0, 0);
      expect([d.freq(0), d.freq(1)]).toEqual([4095, 1]);
      const e = build(4096, [
        [1, 100],
        [2, 50],
      ]);
      e.rescaleTop(1, 0);
      expect(e.freq(1)).toBe(1);
      invariants(e);
    });

    it('keeps the sum on random tables', () => {
      const r = rng(11);
      const d = new Distribution();
      for (let round = 0; round < 50; round++) {
        const total = 2 ** (12 + Math.floor(r() * 13));
        const n = 1 + Math.floor(r() * 100);
        const entries: [number, number][] = Array.from({ length: n }, (_, i) => [
          3 * i,
          Math.floor(r() * 2 ** 36),
        ]);
        build(total, entries, r() < 0.5 ? Math.floor(r() * 2 ** 36) : undefined, d);
        const top = Math.floor(r() * d.n);
        d.rescaleTop(top, Math.floor(r() * 65537));
        invariants(d);
      }
    });
  });
  it('orders entries by id on every path: insertion, the id sweep and the key sort', () => {
    const r = rng(41);
    const d = new Distribution();
    const spans = [0, 0, 0];
    for (let step = 0; step < 600; step++) {
      const m = Math.floor(r() * 160);
      const dense = r() < 0.5;
      const lo = Math.floor(r() * 400);
      const range = dense
        ? Math.max(1, Math.floor(m * (1 + 3 * r())))
        : m * 4 + 1 + Math.floor(r() * 5000);
      const pick = new Set<number>();
      while (pick.size < Math.min(m, range)) pick.add(lo + Math.floor(r() * range));
      const entries: [number, number][] = [...pick].map((id) => [id, Math.floor(r() * 2 ** 26)]);
      const escape = r() < 0.5 ? Math.floor(r() * 2 ** 26) : undefined;
      const n = entries.length + (escape === undefined ? 0 : 1);
      if (n === 0) continue;
      const span = entries.length === 0 ? 0 : Math.max(...pick) - Math.min(...pick) + 1;
      spans[entries.length <= 16 ? 0 : span <= 4 * entries.length ? 1 : 2]++;
      const total = 2 ** 16;
      build(total, entries, escape, d);
      // The plain rule on entries sorted by id, masses already below 2^27.
      const sorted = [...entries].sort((x, y) => x[0] - y[0]);
      const P = sorted.map((e) => e[1]);
      if (escape !== undefined) P.push(escape);
      const z = P.reduce((a, b) => a + b, 0);
      let best = 0;
      for (let i = 0; i < n; i++) if (P[i] > P[best]) best = i;
      const f = P.map((p) => (z === 0 ? 1 : 1 + Math.floor((p * (total - n - 1)) / z)));
      f[best] += total - f.reduce((a, b) => a + b, 0);
      expect(d.n).toBe(n);
      for (let i = 0; i < sorted.length; i++) expect(d.idAt(i)).toBe(sorted[i][0]);
      for (let i = 0; i < n; i++) expect(d.freq(i)).toBe(f[i]);
      invariants(d);
    }
    expect(Math.min(...spans)).toBeGreaterThan(50);
  });
});
