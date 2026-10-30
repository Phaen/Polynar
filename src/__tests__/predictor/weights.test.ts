import { E_MIN, ONE, PB, RB, div } from '../../predictor/arith';
import { cellOf } from '../../predictor/features';
import { HF, NSRC, SRC, levels } from '../../predictor/types';
import type { LoadedPrior, PriorConstants } from '../../predictor/types';
import {
  APM_HI,
  APM_LO,
  VoteLog,
  apmShare,
  apmUpdate,
  blockOf,
  deltaRate,
  learn,
  newRunPrior,
  smul,
} from '../../predictor/weights';
import type { PathDeltas } from '../../predictor/weights';

const LOG2E = Math.LOG2E;
const bits = (v: number): number => Math.round(v * ONE);
const ETA = 2420432;
const ORDER = 2;

function constants(): PriorConstants {
  return {
    eta: ETA,
    rho0: bits(0.25),
    n0: 256,
    rates: {
      vfeat: [ETA, div(ETA, 9), div(ETA, 16), ETA, div(ETA, 9)],
      logn: div(ETA, 256),
      lev: ETA,
      apm: 1311,
      kernel: ETA,
      oscale: ETA,
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
      oscale: [bits(-10 * LOG2E), bits(5 * LOG2E)],
      vstep: bits(12 * LOG2E),
      number: bits(40 * LOG2E),
      hit: bits(10 * LOG2E),
      range: bits(10 * LOG2E),
    },
    ladder: [2, 1, 1],
  };
}

function prior(): LoadedPrior {
  const fill = (n: number, v: number): Float64Array => new Float64Array(n).fill(v);
  return {
    source: {} as LoadedPrior['source'],
    order: ORDER,
    constants: constants(),
    escape: bits(-3),
    kernel: fill(3, bits(-2)),
    hybrid: fill(NSRC * levels(ORDER) * HF, 0),
    apm: fill(3 * (ORDER + 1) * 24, 32768),
    pnov: fill(32, 0),
    vfeat: fill(5, 0),
    oscale: fill(6, 0),
    lev: fill(5, 0),
    logn: fill(8 * (ORDER + 1) + 1, 0),
    vstep: fill(76, 0),
    numberHit: fill(12, 0),
    numberRange: fill(2, 0),
    numberConf: fill(120, 32768),
    numberStart: fill(139, 0),
    builtinSymbols: [],
    builtinCounts0: [],
    builtinContexts1: [],
  };
}

/** Reference: a * b / 2^k rounded half away from zero, through BigInt. */
function refSmul(a: number, b: number, k: number): number {
  const p = BigInt(a) * BigInt(b);
  const m = p < 0n ? -p : p;
  const r = k === 0 ? m : (m + (1n << BigInt(k - 1))) >> BigInt(k);
  return Number(p < 0n ? -r : r);
}

/** Reference: round half away from zero of a / 2^k for an exact BigInt-able integer a. */
function refRound(p: bigint, k: number): number {
  const m = p < 0n ? -p : p;
  const r = (m + (1n << BigInt(k - 1))) >> BigInt(k);
  return Number(p < 0n ? -r : r);
}

function rnd(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** a * 2^16 / b rounded to nearest, ties upward. */
const rq = (a: number, b: number): number => Math.floor((2 * a * 65536 + b) / (2 * b));

const X = (rec = 0, frozen = 0, depth = 0, off = 0, det = 0): number[] =>
  [1, rec, frozen, depth, off, det].map((v) => v * ONE);

/** The feature cell of a vector made by X. */
const C = (x: number[]): number => cellOf(x[1] / ONE, x[2] > 0, x[3] / ONE, x[4] / ONE, x[5] / ONE);

describe('newRunPrior', () => {
  it('copies every learned table', () => {
    const p = prior();
    const r = newRunPrior(p);
    expect(r.loaded).toBe(p);
    expect(r.escape).toBe(p.escape);
    for (const k of [
      'kernel',
      'hybrid',
      'apm',
      'pnov',
      'vfeat',
      'oscale',
      'lev',
      'logn',
      'vstep',
    ] as const) {
      expect(Array.from(r[k])).toEqual(Array.from(p[k]));
      r[k][0] += 1;
      expect(r[k][0]).not.toBe(p[k][0]);
    }
  });
});

describe('smul', () => {
  it('rounds a * b / 2^k to nearest, odd in each argument', () => {
    const r = rnd(7);
    for (let i = 0; i < 20000; i++) {
      const k = 1 + Math.floor(r() * 45);
      const a = Math.floor(r() * 2 ** 40) * (r() < 0.5 ? -1 : 1);
      const b = Math.floor(r() * 2 ** 25) * (r() < 0.5 ? -1 : 1);
      if (Math.abs(refSmul(a, b, k)) >= 2 ** 52) continue;
      expect(smul(a, b, k)).toBe(refSmul(a, b, k));
      expect(smul(b, a, k)).toBe(refSmul(a, b, k));
    }
    expect(smul(3, 1, 1)).toBe(2);
    expect(smul(-3, 1, 1)).toBe(-2);
    expect(smul(0, 5, 3)).toBe(0);
    expect(smul(5, 0, 3)).toBe(0);
    expect(Object.is(smul(-1, 1, 4), 0)).toBe(true);
    expect(smul(-7, 9, 0)).toBe(-63);
  });

  it('splits the smaller factor when both reach 2^26 and k <= 26', () => {
    const r = rnd(11);
    for (let i = 0; i < 5000; i++) {
      const k = 1 + Math.floor(r() * 26);
      const a = (2 ** 26 + Math.floor(r() * 2 ** 26)) * (r() < 0.5 ? -1 : 1);
      const b = 2 ** 26 + Math.floor(r() * 2 ** 4);
      if (Math.abs(refSmul(a, b, k)) >= 2 ** 52) continue;
      expect(smul(a, b, k)).toBe(refSmul(a, b, k));
    }
    expect(smul(5 * ONE, 40 * ONE, RB)).toBe(200 * ONE);
    expect(() => smul(2 ** 27, 2 ** 27, 27)).toThrow(RangeError);
  });
});

describe('blockOf', () => {
  it('numbers blocks by source and level', () => {
    expect(blockOf(0, 0, ORDER)).toBe(0);
    expect(blockOf(SRC.msg, 3, ORDER)).toBe(levels(ORDER) + 3);
  });
});

describe('VoteLog', () => {
  it('grows, keeps votes, and resets', () => {
    const log = new VoteLog(2);
    for (let i = 0; i < 40; i++) {
      expect(
        log.push(i, C(X(1)), 100 + i, i, -i, -2 * i, 65536, 1, 2, -1, 3, ONE, i % 2 === 0, -1)
      ).toBe(i);
    }
    expect(log.n).toBe(40);
    expect(log.block[39]).toBe(39);
    expect(log.cell[39]).toBe(C(X(1)));
    expect(log.sym[0]).toBe(100);
    expect(log.count[5]).toBe(5);
    expect(log.eLearn[5]).toBe(-5);
    expect(log.eCode[5]).toBe(-10);
    expect(log.tau[0]).toBe(1);
    expect(log.tau[1]).toBe(0);
    expect(log.lognIndex[3]).toBe(3);
    log.af = 5;
    log.novel = true;
    log.kernelZ = 9;
    log.vx[0] = 1;
    log.reset(1000);
    expect(log.n).toBe(0);
    expect(log.af).toBe(-1);
    expect(log.novel).toBe(false);
    expect(log.kernelZ).toBe(0);
    expect(log.vx[0]).toBe(0);
    expect(log.block.length).toBeGreaterThanOrEqual(1000);
    const big = log.block;
    log.reset(10);
    expect(log.block).toBe(big);
    expect(new VoteLog(0).block.length).toBe(0);
  });
});

/** The update learn makes to a hybrid parameter from the votes of one block (exact reference). */
function refBlock(
  votes: { m: number; hit: boolean; share?: number; x: number[] }[],
  Sa: number,
  Z: number,
  rate: number
): number[] {
  const s = Math.max(0, Math.max(Z, Sa).toString(2).length - 30);
  const z = Math.max(1, Math.floor(Z / 2 ** s));
  const sa = Math.max(1, Math.floor(Sa / 2 ** s));
  const G = new Array<bigint>(HF).fill(0n);
  for (const v of votes) {
    const ms = Math.floor(v.m / 2 ** s);
    const mA = Number((BigInt(v.m) * BigInt(v.share ?? 65536)) >> BigInt(16 + s));
    const q = (v.hit ? rq(mA, sa) : 0) - rq(ms, z);
    for (let f = 0; f < HF; f++) G[f] += BigInt(q) * BigInt(v.x[f]);
  }
  return G.map((g) => refRound(BigInt(rate) * g, PB + RB));
}

describe('learn', () => {
  it('updates a block from two votes as computed by hand, with the path delta', () => {
    const run = newRunPrior(prior());
    const log = new VoteLog();
    const b = blockOf(SRC.msg, 1, ORDER);
    const x1 = X(2, 0, 1, 1, 0);
    const x2 = X(0, 0, 0, 0, 3);
    log.push(b, C(x1), 7, 3, 0, 0, 65536, SRC.msg, 1, -1, -1, 0, false, -1);
    log.push(b, C(x2), 8, 1, 0, 0, 65536, SRC.msg, 1, -1, -1, 0, false, -1);
    log.massLearn[0] = 3000;
    log.massLearn[1] = 1000;
    log.massEsc = 500;
    const Sa = 3000;
    const Z = 4500;
    const deltas: PathDeltas = new Map();
    learn(run, log, Sa, Z, 7, deltas, 0);
    const votes = [
      { m: 3000, hit: true, x: x1 },
      { m: 1000, hit: false, x: x2 },
    ];
    const want = refBlock(votes, Sa, Z, ETA);
    for (let f = 0; f < HF; f++) expect(run.hybrid[b * HF + f]).toBe(want[f]);
    const rr = refSmul(Math.floor((bits(0.25) * 256) / 256), ETA, RB);
    expect(deltaRate(run.loaded.constants, 0)).toBe(rr);
    const wantD = refBlock(votes, Sa, Z, rr);
    expect(Array.from(deltas.get(b)!)).toEqual(wantD);
    // theta gained, the rec slope and theta are positive, the det slope negative.
    expect(want[0]).toBeGreaterThan(0);
    expect(want[5]).toBeLessThan(0);
    // The escape lost: it is not novel and took 500/4500 of Z.
    const gEsc = -rq(500, 4500);
    expect(run.escape).toBe(bits(-3) + refSmul(ETA, gEsc, PB));
    // Scratch is clean for the next step.
    expect(log.G.every((v) => v === 0)).toBe(true);
    expect(log.mark.every((v) => v === 0)).toBe(true);
  });

  it('follows the delta rate schedule and leaves the built-in without deltas', () => {
    const c = constants();
    const r0 = deltaRate(c, 0);
    const r1 = deltaRate(c, 256);
    const r2 = deltaRate(c, 768);
    expect(r0).toBe(refSmul(bits(0.25), ETA, RB));
    expect(Math.abs(r1 - r0 / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(r2 - r0 / 4)).toBeLessThanOrEqual(1);
    const run = newRunPrior(prior());
    const log = new VoteLog();
    const bb = blockOf(SRC.builtin, 0, ORDER);
    const bn = blockOf(SRC.node, 0, ORDER);
    log.push(bb, C(X()), 1, 1, 0, 0, 65536, SRC.builtin, 0, -1, -1, 0, false, -1);
    log.push(bn, C(X()), 2, 1, 0, 0, 65536, SRC.node, 0, -1, -1, 0, false, -1);
    log.massLearn[0] = 100;
    log.massLearn[1] = 100;
    const deltas: PathDeltas = new Map();
    learn(run, log, 100, 200, 1, deltas, 768);
    expect(deltas.has(bb)).toBe(false);
    const d = deltas.get(bn)!;
    expect(d[0]).toBe(refSmul(r2, -32768 * ONE, PB + RB));
    expect(run.hybrid[bb * HF]).toBe(refSmul(ETA, 32768 * ONE, PB + RB));
    // A second step reuses the existing delta block.
    log.massLearn[0] = 100;
    learn(run, log, 100, 200, 1, deltas, 769);
    expect(deltas.get(bn)).toBe(d);
    // Without deltas only the shared parameters move.
    learn(run, log, 100, 200, 1, null, 0);
    expect(deltas.size).toBe(1);
  });

  it('credits folded votes through af and the fold share, and skips massless votes', () => {
    const run = newRunPrior(prior());
    const log = new VoteLog();
    const bf = blockOf(SRC.msgF, 0, ORDER);
    const bm = blockOf(SRC.msg, 0, ORDER);
    const x = X(1);
    log.push(bf, C(x), 35, 4, 0, 0, 16384, SRC.msgF, 0, -1, -1, 0, false, -1);
    log.push(bm, C(x), 35, 4, 0, 0, 65536, SRC.msg, 0, -1, -1, 0, false, -1);
    log.push(bm, C(x), 48, 4, 0, 0, 65536, SRC.msg, 0, -1, -1, 0, false, -1);
    log.massLearn[0] = 4000;
    log.massLearn[1] = 0;
    log.massLearn[2] = 1000;
    log.af = 35;
    const Sa = 1000 + 1000;
    const Z = 5000;
    learn(run, log, Sa, Z, 48, null, 0);
    const wf = refBlock([{ m: 4000, hit: true, share: 16384, x }], Sa, Z, ETA);
    const wm = refBlock([{ m: 1000, hit: true, x }], Sa, Z, ETA);
    for (let f = 0; f < HF; f++) {
      expect(run.hybrid[bf * HF + f]).toBe(wf[f]);
      expect(run.hybrid[bm * HF + f]).toBe(wm[f]);
    }
    // Without af the folded vote is compared with a itself.
    const run2 = newRunPrior(prior());
    log.reset();
    log.push(bf, C(x), 48, 4, 0, 0, 65536, SRC.nodeF, 0, -1, -1, 0, false, -1);
    log.massLearn[0] = 1000;
    learn(run2, log, 1000, 1000, 48, null, 0);
    // A vote holding all of Sa and Z has gradient 0.
    expect(Array.from(run2.hybrid).every((v) => v === 0)).toBe(true);
  });

  it('brings accumulators above 2^HB down by a shared shift', () => {
    const run = newRunPrior(prior());
    const log = new VoteLog();
    const b = blockOf(SRC.msg, 2, ORDER);
    const x = X(0, 1, 2, 0, 1);
    log.push(b, C(x), 9, 1, 0, 0, 65536, SRC.msg, 2, -1, -1, 0, false, -1);
    log.push(b, C(x), 10, 1, 0, 0, 65536, SRC.msg, 2, -1, -1, 0, false, -1);
    const m1 = 2 ** 36 - 12345;
    const m2 = 2 ** 35 + 777;
    log.massLearn[0] = m1;
    log.massLearn[1] = m2;
    log.massEsc = 2 ** 20;
    log.novel = true;
    const Z = m1 + m2 + 2 ** 20;
    // Sa above Z exercises the shift taken from Sa.
    const Sa = Z + 2 ** 41;
    learn(run, log, Sa, Z, 9, null, 0);
    const want = refBlock(
      [
        { m: m1, hit: true, x },
        { m: m2, hit: false, x },
      ],
      Sa,
      Z,
      ETA
    );
    for (let f = 0; f < HF; f++) expect(run.hybrid[b * HF + f]).toBe(want[f]);
  });

  it('clamps hybrid parameters and deltas', () => {
    const run = newRunPrior(prior());
    const c = constants();
    const fast: PriorConstants = { ...c, eta: 2 ** 25, rho0: 2 ** 24 };
    const log = new VoteLog();
    const b = blockOf(SRC.node, 0, ORDER);
    const deltas: PathDeltas = new Map();
    for (let step = 0; step < 200; step++) {
      log.reset();
      log.push(b, C(X(4)), 1, 1, 0, 0, 65536, SRC.node, 0, -1, -1, 0, false, -1);
      log.push(b + 1, C(X(4)), 2, 1, 0, 0, 65536, SRC.node, 1, -1, -1, 0, false, -1);
      log.massLearn[0] = 1;
      log.massLearn[1] = 1000;
      learn(run, log, 1, 1001, 1, deltas, 0, fast);
    }
    expect(run.hybrid[b * HF + 1]).toBe(c.clamps.cell);
    expect(deltas.get(b)![1]).toBe(c.clamps.delta);
    for (let step = 0; step < 200; step++) {
      log.reset();
      log.push(b, C(X(4)), 1, 1, 0, 0, 65536, SRC.node, 0, -1, -1, 0, false, -1);
      log.push(b + 1, C(X(4)), 2, 1, 0, 0, 65536, SRC.node, 1, -1, -1, 0, false, -1);
      log.massLearn[0] = 1000;
      log.massLearn[1] = 1;
      learn(run, log, 1, 1001, 2, deltas, 0, fast);
    }
    expect(run.hybrid[b * HF + 1]).toBe(-c.clamps.cell);
    expect(deltas.get(b)![1]).toBe(-c.clamps.delta);
  });

  it('learns the escape and pnov from novelty, with clamps', () => {
    const run = newRunPrior(prior());
    const log = new VoteLog();
    log.push(0, C(X()), 1, 1, 0, 0, 65536, SRC.node, 0, -1, -1, 0, false, -1);
    log.massLearn[0] = 1000;
    log.massEsc = 1000;
    log.novel = true;
    log.pnovIndex = 5;
    learn(run, log, 1000, 2000, 2, null, 0);
    const g = 65536 - 32768;
    expect(run.escape).toBe(bits(-3) + refSmul(ETA, g, PB));
    expect(run.pnov[5]).toBe(refSmul(ETA, g, PB));
    expect(run.pnov[4]).toBe(0);
    const fast: PriorConstants = {
      ...constants(),
      eta: 2 ** 25,
      rates: { ...constants().rates, pnov: 2 ** 25 },
    };
    for (let i = 0; i < 100; i++) learn(run, log, 1000, 2000, 2, null, 0, fast);
    expect(run.escape).toBe(56 * ONE);
    expect(run.pnov[5]).toBe(56 * ONE);
    // Without a pnov cell only the escape moves.
    log.pnovIndex = -1;
    log.novel = false;
    learn(run, log, 1000, 2000, 1, null, 0);
    expect(run.escape).toBeLessThan(56 * ONE);
    expect(run.pnov[5]).toBe(56 * ONE);
  });

  it('learns the value-feature slopes from the tau votes', () => {
    const run = newRunPrior(prior());
    const log = new VoteLog();
    log.push(0, C(X()), 1, 1, 0, 0, 65536, SRC.node, 3, -1, -1, 0, true, -1);
    log.push(0, C(X()), 2, 1, 0, 0, 65536, SRC.node, 3, -1, -1, 0, true, -1);
    log.push(0, C(X()), 3, 1, 0, 0, 65536, SRC.msg, 3, -1, -1, 0, false, -1);
    log.massLearn[0] = 3000;
    log.massLearn[1] = 1000;
    log.massLearn[2] = 4000;
    log.vx.set([1, 2, 0, 1, 3]);
    learn(run, log, 3000, 8000, 1, null, 0);
    const g = rq(3000, 3000) - rq(4000, 8000);
    const r = constants().rates.vfeat;
    expect(run.vfeat[0]).toBe(refSmul(r[0], g, PB));
    expect(run.vfeat[1]).toBe(refSmul(r[1] * 2, g, PB));
    expect(run.vfeat[2]).toBe(0);
    expect(run.vfeat[4]).toBe(refSmul(r[4] * 3, g, PB));
    const fast: PriorConstants = {
      ...constants(),
      rates: { ...constants().rates, vfeat: [2 ** 30, 0, 0, 0, 0] },
    };
    learn(run, log, 3000, 8000, 1, null, 0, fast);
    expect(run.vfeat[0]).toBe(constants().clamps.vfeat);
    // A zero gradient leaves the slopes alone.
    const before = Array.from(run.vfeat);
    log.reset();
    log.push(0, C(X()), 1, 1, 0, 0, 65536, SRC.node, 3, -1, -1, 0, true, -1);
    log.massLearn[0] = 1000;
    log.vx.set([1, 1, 1, 1, 1]);
    learn(run, log, 1000, 1000, 1, null, 0);
    expect(Array.from(run.vfeat)).toEqual(before);
  });

  it('learns level-evidence cells and log-n slopes', () => {
    const run = newRunPrior(prior());
    const log = new VoteLog();
    log.push(0, C(X()), 1, 1, 0, 0, 65536, SRC.node, 1, 2, 4, 3 * ONE, false, -1);
    log.push(0, C(X()), 2, 1, 0, 0, 65536, SRC.node, 1, 2, 4, 5 * ONE, false, -1);
    log.massLearn[0] = 2000;
    log.massLearn[1] = 2000;
    learn(run, log, 2000, 8000, 1, null, 0);
    const gLev = 65536 - rq(4000, 8000);
    expect(run.lev[2]).toBe(refSmul(ETA, gLev, PB));
    expect(run.lev[0]).toBe(0);
    const lnA = 2000 * 3;
    const lnT = 2000 * 3 + 2000 * 5;
    const gLn = rq(lnA, 2000) - rq(lnT, 8000);
    expect(run.logn[4]).toBe(refSmul(div(ETA, 256), gLn, PB));
    for (let i = 0; i < 2000; i++) learn(run, log, 2000, 8000, 1, null, 0);
    expect(run.lev[2]).toBe(constants().clamps.lev);
    expect(run.logn[4]).toBe(constants().clamps.logn);
    expect(log.levA.every((v) => v === 0) && log.lnT.every((v) => v === 0)).toBe(true);
  });

  it('learns kernel links and outside multipliers from the kernel side', () => {
    const run = newRunPrior(prior());
    const log = new VoteLog();
    log.kernelPa = 1000;
    log.kernelZ = 4000;
    log.kernelA.set([500, 0, 0]);
    log.kernelT.set([600, 400, 0]);
    log.oscaleA.set([0, 300, 0, 0, 0, 0]);
    log.oscaleT.set([0, 900, 0, 0, 0, 2000]);
    learn(run, log, 1, 4000, 1, null, 0);
    const g0 = rq(500, 1000) - rq(600, 4000);
    expect(run.kernel[0]).toBe(Math.min(0, bits(-2) + refSmul(ETA, g0, PB)));
    expect(run.kernel[1]).toBe(bits(-2) + refSmul(ETA, -rq(400, 4000), PB));
    expect(run.kernel[2]).toBe(bits(-2));
    const go = rq(300, 1000) - rq(900, 4000);
    expect(run.oscale[1]).toBe(refSmul(ETA, go, PB));
    expect(run.oscale[5]).toBe(refSmul(ETA, -32768, PB));
    expect(run.oscale[0]).toBe(0);
    // Clamps: the links stay <= 0 and >= E_MIN, the multipliers inside [lo, hi].
    const fast: PriorConstants = {
      ...constants(),
      rates: { ...constants().rates, kernel: 2 ** 34, oscale: 2 ** 34 },
    };
    learn(run, log, 1, 4000, 1, null, 0, fast);
    expect(run.kernel[0]).toBe(0);
    expect(run.kernel[1]).toBe(E_MIN);
    expect(run.oscale[1]).toBe(constants().clamps.oscale[1]);
    expect(run.oscale[5]).toBe(constants().clamps.oscale[0]);
    // Large kernel masses share one shift; Pa above Z' takes the shift from Pa.
    const run2 = newRunPrior(prior());
    log.kernelPa = 2 ** 45;
    log.kernelZ = 2 ** 44;
    log.kernelA.set([2 ** 44, 0, 0]);
    log.kernelT.set([2 ** 44, 0, 0]);
    log.oscaleA.fill(0);
    log.oscaleT.fill(0);
    learn(run2, log, 1, 1, 1, null, 0);
    expect(run2.kernel[0]).toBe(bits(-2) + refSmul(ETA, 32768 - 65536, PB));
  });
});

describe('confidence maps', () => {
  it('interpolates and moves both cells toward the outcome', () => {
    const run = newRunPrior(prior());
    run.apm[10] = 20000;
    run.apm[11] = 40000;
    const fr = ONE / 4;
    expect(apmShare(run, 10, fr)).toBe(25000);
    expect(apmShare(run, 10, 0)).toBe(20000);
    expect(apmShare(run, 10, ONE)).toBe(40000);
    apmUpdate(run, 10, fr, 65536);
    const e = 65536 - 25000;
    expect(run.apm[10]).toBe(20000 + refSmul(1311 * (ONE - fr), e, PB + RB));
    expect(run.apm[11]).toBe(40000 + refSmul(1311 * fr, e, PB + RB));
    for (let i = 0; i < 2000; i++) apmUpdate(run, 10, fr, 65536);
    expect(run.apm[10]).toBe(APM_HI);
    for (let i = 0; i < 4000; i++) apmUpdate(run, 10, fr, 0);
    expect(run.apm[10]).toBe(APM_LO);
    expect(APM_LO).toBe(4);
    expect(APM_HI).toBe(65532);
  });
});
