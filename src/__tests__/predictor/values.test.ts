import { ONE } from '../../predictor/arith';
import { Session } from '../../predictor/session';
import { ESCAPE } from '../../predictor/types';
import type { PriorConstants } from '../../predictor/types';
import {
  VSTEP_N,
  VS_A,
  VS_AG,
  VS_L,
  VS_NEW,
  VS_O0,
  VS_REC,
  VS_REP,
  VS_SH,
  MemberStep,
  ValueStep,
  vsA,
  vsDist,
  vsL,
  vsNew,
  vsRec,
  vsRep,
  vsTop,
} from '../../predictor/values';

const LOG2E = Math.LOG2E;
const bits = (v: number): number => Math.round(v * ONE);
const ETA = 2420432;

function constants(): PriorConstants {
  return {
    eta: ETA,
    rho0: bits(0.25),
    n0: 256,
    rates: {
      vfeat: [ETA, 0, 0, ETA, 0],
      logn: 0,
      lev: ETA,
      apm: 1311,
      kernel: ETA,
      pnov: ETA,
      vstep: ETA,
      number: ETA,
      step: 2 ** 23,
    },
    decays: { lev: 8, hit: 3 },
    clamps: {
      cell: 56 * ONE,
      delta: bits(8 * LOG2E),
      vfeat: bits(6 * LOG2E),
      lev: bits(5 * LOG2E),
      logn: bits(0.5 * LOG2E),
      vstep: bits(12 * LOG2E),
      number: bits(40 * LOG2E),
      hit: bits(10 * LOG2E),
      range: bits(10 * LOG2E),
    },
    ladder: [2, 1, 1],
  };
}

/** The prototype's starting value-step weights (natural log), in RB bits. */
function initialVstep(): Float64Array {
  const ln = [
    0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 0, -0.2, -0.4, -0.6, -0.8, -1, -1.2, -1.4, -1,
    -0.5, 0, 0.5, -3, -2.3, -1.4, -0.5, 0.5, 2.5, 0, 0.5, 1, 2, 3, 4,
  ];
  const v = new Float64Array(VSTEP_N);
  ln.forEach((x, i) => (v[i] = bits(x * LOG2E)));
  v[VS_SH + 2] = bits(-0.3);
  v[VS_SH + 9] = bits(0.2);
  return v;
}

function rnd(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/**
 * Floating re-implementation of the value step from the prototype's formulas (base 2, D4, D6, the
 * follower of the previous value's latest earlier occurrence voting with full features).
 */
class FloatStep {
  th: number[];
  dl: number[] | null;
  occ: { v: number; pos: number }[] = [];
  keys = new Map<string, number>();
  count: number[] = [];
  nNew = 0;
  reps = 0;
  top = 0;
  constructor(
    readonly history: number,
    vstep: Float64Array,
    delta: boolean
  ) {
    this.th = Array.from(vstep, (x) => x / ONE);
    this.dl = delta ? new Array<number>(VSTEP_N).fill(0) : null;
  }

  /** P(choice) before learning; then learns. */
  step(seq: Int32Array, t: number, key: string, pathN: number): number | null {
    const n = this.occ.length;
    if (n === 0) return null;
    const c = constants();
    const th = (i: number): number => this.th[i] + (this.dl ? this.dl[i] : 0);
    const rep = this.reps / n;
    const nf = this.nNew / n;
    const ts = this.top / n;
    const d = this.keys.size;
    const cRep = VS_REP + (rep === 0 ? 0 : rep < 0.25 ? 1 : rep < 0.75 ? 2 : 3);
    const cNew =
      VS_NEW +
      (nf < 1 / 16 ? 0 : nf < 1 / 8 ? 1 : nf < 1 / 4 ? 2 : nf < 1 / 2 ? 3 : nf < 3 / 4 ? 4 : 5);
    const st = ts >= 1 ? 0 : ts >= 0.75 ? 1 : ts >= 0.5 ? 2 : 3;
    const sd = d <= 1 ? 0 : d <= 3 ? 1 : d <= 8 ? 2 : 3;
    const oT = VS_SH + st;
    const oD = VS_SH + 4 + sd;
    const nT = VS_SH + 8 + st;
    const nD = VS_SH + 12 + sd;
    const base = th(cRep) + th(oT) + th(oD);
    const wNew = 2 ** (th(cNew) + th(nT) + th(nD));
    const parts: { v: number; w: number; cells: number[] }[] = [];
    const j0 = Math.max(0, n - this.history);
    const full: number[] = [];
    for (let j = j0; j < n; j++) full.push(j);
    let q = n - 2;
    while (q >= 0 && this.occ[q].v !== this.occ[n - 1].v) q--;
    const follower = q >= 0 && q + 1 < j0 ? q + 1 : -1;
    if (follower >= 0) full.push(follower);
    for (const j of full) {
      const o = this.occ[j];
      let L = 0;
      while (L < 64 && o.pos - 1 - L >= 1 && seq[t - 1 - L] === seq[o.pos - 1 - L]) L++;
      const ago = n - j;
      const rec =
        ago <= 1
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
      const cells = [VS_L + vsL(L), VS_REC + rec, VS_A];
      const e = cells.reduce((s, i) => s + th(i), base);
      parts.push({ v: o.v, w: 2 ** e / n, cells });
    }
    const older = new Array<number>(d).fill(0);
    for (let j = 0; j < j0; j++) if (j !== follower) older[this.occ[j].v]++;
    older.forEach((k, v) => {
      if (k > 0) {
        const e = th(VS_L) + th(VS_REC + 7) + th(VS_A) + base;
        parts.push({ v, w: (k * 2 ** e) / n, cells: [VS_L, VS_REC + 7, VS_A] });
      }
    });
    let Z = wNew;
    const V = new Array<number>(d).fill(0);
    for (const p of parts) {
      Z += p.w;
      V[p.v] += p.w;
    }
    const choice = this.keys.has(key) ? this.keys.get(key)! : -1;
    const P = choice >= 0 ? V[choice] / Z : wNew / Z;
    const g = new Array<number>(VSTEP_N).fill(0);
    const gn = (choice >= 0 ? 0 : 1) - wNew / Z;
    g[cNew] += gn;
    g[nT] += gn;
    g[nD] += gn;
    g[oT] -= gn;
    g[oD] -= gn;
    let rs = 0;
    for (const p of parts) {
      const q = (p.v === choice ? p.w / V[choice] : 0) - p.w / Z;
      for (const i of p.cells) g[i] += q;
      rs += q;
    }
    g[cRep] += rs;
    const eta = c.eta / ONE;
    const rho = ((c.rho0 / ONE) * c.n0) / (c.n0 + pathN);
    const cv = c.clamps.vstep / ONE;
    const cd = c.clamps.delta / ONE;
    for (let i = 0; i < VSTEP_N; i++) {
      if (g[i] === 0) continue;
      this.th[i] = Math.max(-cv, Math.min(cv, this.th[i] + eta * g[i]));
      if (this.dl) this.dl[i] = Math.max(-cd, Math.min(cd, this.dl[i] + rho * eta * g[i]));
    }
    return P;
  }

  record(key: string, pos: number): void {
    let v = this.keys.get(key);
    if (v === undefined) {
      v = this.keys.size;
      this.keys.set(key, v);
      this.count[v] = 0;
      this.nNew++;
    } else this.reps++;
    this.count[v]++;
    this.top = Math.max(this.top, this.count[v]);
    this.occ.push({ v, pos });
  }
}

function run(history: number, delta: boolean, seed: number, steps: number) {
  const r = rnd(seed);
  const vstep = initialVstep();
  const deltaArr = delta ? new Float64Array(VSTEP_N) : null;
  const vs = new ValueStep(history, 2 ** 24);
  const fl = new FloatStep(history, vstep, delta);
  const seq = new Int32Array(steps * 8 + 8);
  let t = 1;
  let worst = 0;
  let total = 0;
  const c = constants();
  for (let i = 0; i < steps; i++) {
    seq[t++] = 500 + (i % 4);
    if (r() < 0.3) seq[t++] = 600 + Math.floor(r() * 2);
    const v = Math.floor(r() * r() * 10);
    const key = `v${v}`;
    const pathN = 3 * i;
    const dist = vs.distribution(seq, t, vstep, deltaArr);
    const P = fl.step(seq, t, key, pathN);
    if (dist === null) {
      expect(P).toBeNull();
      expect(i).toBe(0);
    } else {
      const id = vs.idOf(key);
      const e = dist.indexOf(id === ESCAPE ? ESCAPE : id);
      expect(e).toBeGreaterThanOrEqual(0);
      if (id === ESCAPE) expect(e).toBe(dist.n - 1);
      expect(dist.n).toBe(vs.distinct + 1);
      expect(dist.hasEscape).toBe(true);
      const cost = -Math.log2(dist.freq(e) / dist.total);
      const ideal = -Math.log2(P!);
      worst = Math.max(worst, Math.abs(cost - ideal));
      total += cost;
      vs.learn(id, pathN, vstep, deltaArr, c);
    }
    expect(vs.record(key, t)).toBe(vs.idOf(key));
    fl.record(key, t);
    seq[t++] = 300 + v;
    seq[t++] = 400 + (v % 3);
    seq[t++] = 0;
  }
  return { worst, total, vstep, deltaArr, fl, vs };
}

describe('bucket functions', () => {
  it('match the prototype at their edges', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 8, 9, 12, 13, 24, 25, 48, 49, 64].map(vsL)).toEqual([
      0, 1, 2, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9,
    ]);
    expect([1, 2, 3, 4, 5, 8, 9, 16, 17, 64, 65, 256, 257].map(vsRec)).toEqual([
      0, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7,
    ]);
    expect([0, 1, 2, 3, 4].map((r) => vsRep(r, 8))).toEqual([0, 1, 2, 2, 2]);
    expect([5, 6, 8].map((r) => vsRep(r, 8))).toEqual([2, 3, 3]);
    expect([0, 1, 2, 3, 4, 5, 7, 8, 11, 12, 16].map((f) => vsNew(f, 16))).toEqual([
      0, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5,
    ]);
    expect([8, 7, 6, 5, 4, 3].map((t) => vsTop(t, 8))).toEqual([0, 1, 1, 2, 2, 3]);
    expect([0, 1, 2, 3, 4, 8, 9].map(vsDist)).toEqual([0, 0, 1, 1, 2, 2, 3]);
    expect([0, 1, 2 * ONE - 1, 2 * ONE, 4 * ONE, 8 * ONE, 16 * ONE].map(vsA)).toEqual([
      0, 1, 1, 2, 3, 4, 5,
    ]);
  });
});

describe('ValueStep', () => {
  it('has no step before the first value and learns nothing without one', () => {
    const vs = new ValueStep(4, 65536);
    const vstep = initialVstep();
    expect(vs.distribution(new Int32Array(4), 1, vstep, null)).toBeNull();
    const before = Array.from(vstep);
    vs.learn(ESCAPE, 0, vstep, null, constants());
    expect(Array.from(vstep)).toEqual(before);
    expect(vs.idOf('a')).toBe(ESCAPE);
    expect(vs.record('a', 1)).toBe(0);
    expect(vs.record('b', 3)).toBe(1);
    expect(vs.record('a', 5)).toBe(0);
    expect([vs.n, vs.nNew, vs.reps, vs.top, vs.distinct]).toEqual([3, 2, 1, 2, 2]);
    // Recording clears a pending step.
    expect(vs.distribution(new Int32Array(8), 7, vstep, null)).not.toBeNull();
    vs.record('c', 7);
    vs.learn(0, 0, vstep, null, constants());
    expect(Array.from(vstep)).toEqual(before);
  });

  it('tracks a floating re-implementation within 2^-10 bits per step', () => {
    const a = run(64, true, 5, 200);
    expect(a.worst).toBeLessThan(2 ** -10);
    for (let i = 0; i < VSTEP_N; i++) {
      expect(Math.abs(a.vstep[i] / ONE - a.fl.th[i])).toBeLessThan(1e-3);
      expect(Math.abs(a.deltaArr![i] / ONE - a.fl.dl![i])).toBeLessThan(1e-3);
    }
  });

  it('tracks it with a short history (older occurrences)', () => {
    const b = run(8, false, 9, 200);
    expect(b.worst).toBeLessThan(2 ** -10);
    for (let i = 0; i < VSTEP_N; i++) {
      expect(Math.abs(b.vstep[i] / ONE - b.fl.th[i])).toBeLessThan(1e-3);
    }
    expect(b.vstep[VS_REC + 7]).not.toBe(initialVstep()[VS_REC + 7]);
  });

  it('learns only the cells the step used', () => {
    const vs = new ValueStep(64, 65536);
    const vstep = initialVstep();
    const delta = new Float64Array(VSTEP_N);
    const seq = new Int32Array([0, 5, 6, 0, 5, 6, 0, 5]);
    vs.record('x', 1);
    vs.record('y', 4);
    const d = vs.distribution(seq, 7, vstep, delta)!;
    expect(d.n).toBe(3);
    expect(d.idAt(0)).toBe(0);
    expect(d.idAt(2)).toBe(ESCAPE);
    const before = Array.from(vstep);
    vs.learn(ESCAPE, 10, vstep, delta, constants());
    const changed = before.map((v, i) => (vstep[i] !== v ? i : -1)).filter((i) => i >= 0);
    // n = 2, no repeat: rep 0, new rate 1 -> 5, top 1/2 -> 2, distinct 2 -> 1. 'x' at 1 has no
    // context before it (L = 0), 'y' at 4 agrees on 0 5 6 (L = 3).
    expect(changed.sort((p, q) => p - q)).toEqual(
      [
        VS_L + 0,
        VS_L + 3,
        VS_REC + 0,
        VS_REC + 1,
        VS_REP,
        VS_NEW + 5,
        VS_A,
        VS_SH + 2,
        VS_SH + 4 + 1,
        VS_SH + 8 + 2,
        VS_SH + 12 + 1,
      ].sort((p, q) => p - q)
    );
    expect(vstep[VS_NEW + 5]).toBeGreaterThan(before[VS_NEW + 5]);
    expect(vstep[VS_L + 3]).toBeLessThan(before[VS_L + 3]);
    expect(delta[VS_NEW + 5]).toBeGreaterThan(0);
    expect(vstep[VS_O0]).toBe(before[VS_O0]);
    expect(vstep[VS_AG]).toBe(before[VS_AG]);
    // A chosen past value pulls its cells up.
    vs.record('z', 7);
    const d2 = vs.distribution(seq, 7, vstep, null)!;
    expect(d2.n).toBe(4);
    const l3 = vstep[VS_L + 3];
    vs.learn(vs.idOf('y'), 11, vstep, null, constants());
    expect(vstep[VS_L + 3]).toBeGreaterThan(l3);
  });

  it('leaves the lowest-mass values out when the table would exceed half the quantisation', () => {
    const vs = new ValueStep(64, 4096);
    const vstep = initialVstep();
    const seq = new Int32Array(8);
    // 'k3' occurs twice, so among the equal older values it is never dropped.
    vs.record('k3', 1);
    for (let i = 0; i < 2100; i++) vs.record(`k${i}`, 1);
    expect(vs.distinct).toBe(2100);
    const d = vs.distribution(seq, 2, vstep, null)!;
    expect(d.n).toBe(2048);
    let sum = 0;
    for (let i = 0; i < d.n; i++) sum += d.freq(i);
    expect(sum).toBe(4096);
    // Values 0..2035 left the history window with equal mass, except 'k3' (id 0) with two
    // occurrences; the 53 dropped are the highest ids among them.
    for (let v = 1983; v <= 2035; v++) expect(d.indexOf(v)).toBe(-1);
    expect(d.indexOf(1982)).toBeGreaterThanOrEqual(0);
    expect(d.indexOf(0)).toBeGreaterThanOrEqual(0);
    expect(d.indexOf(2099)).toBeGreaterThanOrEqual(0);
    expect(d.idAt(d.n - 1)).toBe(ESCAPE);
    expect(d.freq(d.n - 1)).toBeGreaterThan(d.freq(d.indexOf(1982)));
    // The same past gives the same table.
    const ids = Array.from({ length: d.n }, (_, i) => d.idAt(i));
    const vs2 = new ValueStep(64, 4096);
    vs2.record('k3', 1);
    for (let i = 0; i < 2100; i++) vs2.record(`k${i}`, 1);
    const d2 = vs2.distribution(seq, 2, initialVstep(), null)!;
    expect(Array.from({ length: d2.n }, (_, i) => d2.idAt(i))).toEqual(ids);
    // A dropped value still learns as itself.
    const before = vstep[VS_REC + 7];
    vs.learn(2000, 0, vstep, null, constants());
    expect(vstep[VS_REC + 7]).toBeGreaterThan(before);
  });

  it('grows past 16 distinct values and bounds the block scale for very many', () => {
    const vs = new ValueStep(1, 2 ** 24);
    const vstep = initialVstep();
    const seq = new Int32Array(4);
    const N = 70000;
    for (let i = 0; i < N; i++) vs.record(`k${i}`, 1);
    expect(vs.distinct).toBe(N);
    expect(vs.idOf('k69999')).toBe(N - 1);
    const d = vs.distribution(seq, 2, vstep, null)!;
    expect(d.n).toBe(N + 1);
    let sum = 0;
    for (let i = 0; i < d.n; i++) sum += d.freq(i);
    expect(sum).toBe(2 ** 24);
    vs.learn(ESCAPE, 0, vstep, null, constants());
    expect(vstep[VS_NEW + 5]).toBeGreaterThan(initialVstep()[VS_NEW + 5]);
  });
});

describe('MemberStep', () => {
  const seq = new Int32Array(4);
  const freqs = (d: { n: number; idAt(i: number): number; freq(i: number): number }) => {
    const out = new Map<number, number>();
    for (let i = 0; i < d.n; i++) out.set(d.idAt(i), d.freq(i));
    return out;
  };

  it('takes the declared weights as prior counts', () => {
    const ms = new MemberStep(3, [1, 6, 1], 64, 65536);
    const f = freqs(ms.distribution(seq, 1, initialVstep(), null));
    expect(f.get(1)).toBeGreaterThan(f.get(0)!);
    // Unseen members share NEW's mass evenly, the remainder to the lowest.
    expect(f.get(0)! - f.get(2)!).toBeGreaterThanOrEqual(0);
    expect(f.get(0)! - f.get(2)!).toBeLessThanOrEqual(1);
  });

  it('gives a member of weight 0 no entry', () => {
    const ms = new MemberStep(3, [1, 0, 1], 64, 65536);
    expect(ms.has(1)).toBe(false);
    expect(ms.has(2)).toBe(true);
    const d = ms.distribution(seq, 1, initialVstep(), null);
    expect(d.n).toBe(2);
    expect(d.indexOf(1)).toBe(-1);
  });

  it('learns toward the coded member, then once every member is seen keeps NEW out', () => {
    const ms = new MemberStep(2, undefined, 64, 65536);
    const vstep = initialVstep();
    let t = 1;
    const step = (v: number): Map<number, number> => {
      const f = freqs(ms.distribution(seq, t, vstep, null));
      ms.learn(v, ms.n, vstep, null, constants());
      ms.record(v, t++);
      return f;
    };
    step(0);
    for (let i = 0; i < 10; i++) step(0);
    const f = step(1);
    expect(f.get(0)).toBeGreaterThan(f.get(1)!);
    // Both seen: the table is the members' occurrences alone.
    const g = step(1);
    expect(g.get(0)! + g.get(1)!).toBe(65536);
    expect(ms.distinct).toBe(2);
  });
});

describe('record agreement', () => {
  const seq = new Int32Array(64);

  /** The odds of value 0 over value 1 in `b`'s next step, with the session's records or without. */
  const odds = (b: ValueStep, records?: Session): number => {
    const d = b.distribution(seq, 20, initialVstep(), null, records) as NonNullable<
      ReturnType<ValueStep['distribution']>
    >;
    return d.freq(d.indexOf(0)) / d.freq(d.indexOf(1));
  };

  /** Records `a` then `b` (where given) in one record each. */
  const fill = (s: Session, a: ValueStep, b: ValueStep, rows: [string, string?][]): void => {
    rows.forEach(([x, y], i) => {
      s.enterRecord();
      a.record(x, 2 * i + 1, s);
      if (y !== undefined) b.record(y, 2 * i + 2, s);
      s.leaveRecord();
    });
  };

  it('raises an occurrence whose record held a rare pair the current record holds', () => {
    const s = new Session();
    const a = new ValueStep(64, 65536);
    const b = new ValueStep(64, 65536);
    fill(s, a, b, [['rare', 'x'], ['often', 'y'], ['often'], ['often'], ['often']]);
    s.enterRecord();
    a.record('rare', 11, s);
    expect(odds(b, s)).toBeGreaterThan(odds(b));
    s.leaveRecord();
  });

  it('adds nothing for a pair every record holds, or outside every record', () => {
    const s = new Session();
    const a = new ValueStep(64, 65536);
    const b = new ValueStep(64, 65536);
    fill(s, a, b, [
      ['same', 'x'],
      ['same', 'y'],
    ]);
    expect(odds(b, s)).toBe(odds(b));
    s.enterRecord();
    a.record('same', 5, s);
    expect(odds(b, s)).toBe(odds(b));
    s.leaveRecord();
  });

  it('counts a nested record apart, the innermost open', () => {
    const s = new Session();
    const a = new ValueStep(64, 65536);
    expect(s.current).toBe(-1);
    expect(s.pair(a, 0)).toEqual([-1, 0]);
    s.enterRecord();
    s.enterRecord();
    expect(s.current).toBe(1);
    a.record('x', 1, s);
    expect(s.pair(a, 0)).toEqual([1, 1]);
    s.leaveRecord();
    expect(s.current).toBe(0);
    expect(s.pair(a, 0)).toEqual([0, 0]);
    s.leaveRecord();
  });
});

describe('the follower of the previous value', () => {
  const seq = new Int32Array(64);

  /** A value step and its float twin over `keys`; the cost in bits of coding `next` after them. */
  function after(history: number, keys: string[], next: string): { vs: ValueStep; cost: number } {
    const vs = new ValueStep(history, 2 ** 24);
    const fl = new FloatStep(history, initialVstep(), false);
    const vstep = initialVstep();
    keys.forEach((k, i) => {
      vs.record(k, 2 * i + 1);
      fl.record(k, 2 * i + 1);
    });
    const t = 2 * keys.length + 1;
    const d = vs.distribution(seq, t, vstep, null)!;
    const id = vs.idOf(next);
    const cost = -Math.log2(d.freq(d.indexOf(id)) / d.total);
    expect(Math.abs(cost + Math.log2(fl.step(seq, t, next, 0)!))).toBeLessThan(2 ** -10);
    return { vs, cost };
  }

  it('is absent on a path with no value or one value', () => {
    const vs = new ValueStep(1, 65536);
    expect(vs.follower()).toBe(-1);
    vs.record('a', 1);
    expect(vs.follower()).toBe(-1);
    expect(after(1, ['a'], 'a').vs.follower()).toBe(-1);
  });

  it('is absent when the previous value has no earlier occurrence', () => {
    expect(after(1, ['a', 'b', 'c'], 'b').vs.follower()).toBe(-1);
    expect(after(1, ['a', 'b', 'a', 'c'], 'b').vs.follower()).toBe(-1);
  });

  it('adds nothing when it lies inside the window, where it already votes', () => {
    const { vs, cost } = after(8, ['a', 'b', 'a'], 'b');
    expect(vs.follower()).toBe(-1);
    // The same past with every occurrence in a wider window prices it the same.
    expect(after(64, ['a', 'b', 'a'], 'b').cost).toBe(cost);
  });

  it('votes with full features when it lies before the window', () => {
    const { vs } = after(1, ['a', 'b', 'c', 'a'], 'b');
    expect(vs.follower()).toBe(1);
    // Its value keeps no older mass of its own when that was its one occurrence.
    after(1, ['a', 'b', 'c', 'a'], 'c');
    // A value with a second older occurrence keeps the other one there.
    expect(after(1, ['b', 'a', 'b', 'c', 'a'], 'b').vs.follower()).toBe(2);
  });

  it('makes the value that followed last time cheaper', () => {
    const followed = after(1, ['a', 'b', 'c', 'a'], 'b').cost;
    const not = after(1, ['a', 'c', 'b', 'a'], 'b').cost;
    expect(followed).toBeLessThan(not);
  });

  it('applies to declared members as to values', () => {
    const ms = new MemberStep(3, undefined, 1, 65536);
    [0, 1, 2, 0].forEach((v, i) => ms.record(v, 2 * i + 1));
    expect(ms.follower()).toBe(1);
    const vstep = initialVstep();
    const d = ms.distribution(seq, 9, vstep, null);
    expect(d.freq(d.indexOf(1))).toBeGreaterThan(d.freq(d.indexOf(2)));
  });
});
