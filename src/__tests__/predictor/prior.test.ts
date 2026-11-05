import { ONE, PB, POW2, TABLES_DIGEST } from '../../predictor/arith';
import {
  P16_MAX,
  P16_MIN,
  loadedPriors,
  loadPrior,
  logitToP16,
  priorOf,
  Priors,
} from '../../predictor/prior';
import { json } from '../../predictor/shipped/json';
import { text } from '../../predictor/shipped/text';
import { MAX_CONTEXTS } from '../../predictor/train';
import { APM_B, HF, NSRC, levels } from '../../predictor/types';
import type { Prior, PriorTable } from '../../predictor/types';

const zeros = (n: number, scale = 1, offset = 0): PriorTable => ({
  scale,
  offset,
  data: new Array(n).fill(0),
});

/** A valid order-1 prior with two built-in symbols. */
function small(order = 1): any {
  return {
    format: 1,
    order,
    arith: { RB: 24, SB: 36, HB: 30, PB: 16, tables: TABLES_DIGEST },
    constants: JSON.parse(JSON.stringify(text.constants)),
    tables: {
      escape: zeros(1, 1, -5),
      kernel: zeros(3),
      hybrid: zeros(NSRC * levels(order) * HF),
      apm: zeros(3 * (order + 1) * APM_B),
      pnov: zeros(32),
      vfeat: zeros(5),
      lev: zeros(5),
      logn: zeros(NSRC * (order + 1) + 1),
      vstep: zeros(76),
      numberShared: { hit: zeros(12), range: zeros(2), conf: zeros(5 * APM_B) },
      numberStart: zeros(139),
    },
    builtin: {
      symbols: [97, 98],
      counts0: [1, 2, 3],
      contexts1: [
        [-1, 97, 1],
        [97, -1, 1],
        [97, 98, 2],
        [98, 98, 1],
      ],
    },
  };
}

/** loadPrior on `small()` after `edit` throws a TypeError naming `field`. */
function rejects(edit: (p: any) => void, field: string): void {
  const p = small();
  edit(p);
  expect(() => loadPrior(p)).toThrow(TypeError);
  expect(() => loadPrior(p)).toThrow(`invalid prior: ${field}`);
}

describe('Priors', () => {
  it('are the shipped JSON priors, loaded as the nodes load them', () => {
    expect(Priors.text).toBe(text);
    expect(Priors.json).toBe(json);
    expect(priorOf(Priors.text)).toBe(loadedPriors.text);
    expect(priorOf(Priors.json)).toBe(loadedPriors.json);
  });
});

describe('logitToP16', () => {
  it('maps 0 to one half and saturates at the clamps', () => {
    expect(logitToP16(0)).toBe(32768);
    expect(logitToP16(-40 * ONE)).toBe(P16_MIN);
    expect(logitToP16(40 * ONE)).toBe(P16_MAX);
    expect(logitToP16(-16 * ONE)).toBe(P16_MIN);
    expect(logitToP16(16 * ONE)).toBe(P16_MAX);
  });

  it('follows 1 / (1 + 2^-x) within the table precision and is monotone', () => {
    let last = 0;
    for (let x = -14 * ONE; x <= 14 * ONE; x += ONE / 8) {
      const p = logitToP16(x);
      const ideal = POW2[PB] / (1 + Math.pow(2, -x / ONE));
      expect(Math.abs(p - Math.min(Math.max(ideal, P16_MIN), P16_MAX))).toBeLessThanOrEqual(
        2 + ideal * Math.pow(2, -11)
      );
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });
});

describe('the shipped text prior', () => {
  it('loads with the tables the spec names', () => {
    const p = loadedPriors.text;
    expect(p).toBe(loadedPriors.text);
    expect(p.source).toBe(text);
    expect(p.order).toBe(8);
    expect(p.hybrid.length).toBe(624);
    expect(p.apm.length).toBe(648);
    expect(p.logn.length).toBe(73);
    expect(p.vstep.length).toBe(76);
    expect(p.numberConf.length).toBe(120);
    expect(p.numberStart.length).toBe(139);
    expect(p.builtinCounts0.length).toBe(p.builtinSymbols.length + 1);
    for (const v of p.kernel) expect(v).toBeLessThan(0);
    for (const v of p.apm) {
      expect(v).toBeGreaterThanOrEqual(P16_MIN);
      expect(v).toBeLessThanOrEqual(P16_MAX);
    }
    // Trained by train(): the built-in within the cap, alice.txt held out.
    expect(p.builtinContexts1.length).toBeLessThanOrEqual(MAX_CONTEXTS);
    expect(text.trainedOn).toContain('alice.txt stays a held-out gate set');
    // ν = ln 0.3 in bits, within the Int8 step.
    const nu = p.numberStart[137] / ONE;
    expect(Math.abs(nu - Math.log2(0.3))).toBeLessThan(0.05);
  });
});

describe('the shipped JSON prior', () => {
  it('was trained by train() on the corpus, its built-in within the cap', () => {
    const p = loadedPriors.json;
    expect(p.source).toBe(json);
    expect(p.builtinContexts1.length).toBeLessThanOrEqual(MAX_CONTEXTS);
    expect(p.builtinSymbols.some((s) => s < 0)).toBe(true);
    expect(json.trainedOn).toContain('research corpus');
  });
});

describe('loadPrior', () => {
  it('expands data · scale + offset', () => {
    const p = small();
    p.tables.pnov = { scale: 3, offset: 100, data: new Array(32).fill(0).map((_, i) => i - 16) };
    p.trainedOn = 'test';
    const l = loadPrior(p);
    expect(l.escape).toBe(-5);
    expect(l.pnov[0]).toBe(-16 * 3 + 100);
    expect(l.pnov[31]).toBe(15 * 3 + 100);
    expect(l.apm[0]).toBe(32768);
    expect(l.numberConf[0]).toBe(32768);
    expect(l.builtinSymbols).toEqual([97, 98]);
    expect(l.constants).toBe(p.constants);
  });

  it('caches by object in priorOf', () => {
    const p = small();
    expect(priorOf(p)).toBe(priorOf(p));
    expect(priorOf(p)).not.toBe(loadPrior(p));
  });

  it('rejects malformed tops', () => {
    expect(() => loadPrior(null as unknown as Prior)).toThrow('invalid prior: prior');
    expect(() => loadPrior([] as unknown as Prior)).toThrow('invalid prior: prior');
    expect(() => loadPrior(5 as unknown as Prior)).toThrow('invalid prior: prior');
    rejects((p) => (p.format = 2), 'format');
    rejects((p) => (p.order = 0), 'order');
    rejects((p) => (p.order = 13), 'order');
    rejects((p) => (p.order = 1.5), 'order');
    rejects((p) => (p.arith = null), 'arith');
    rejects((p) => (p.arith.RB = 20), 'arith');
    rejects((p) => (p.arith.SB = 20), 'arith');
    rejects((p) => (p.arith.HB = 20), 'arith');
    rejects((p) => (p.arith.PB = 20), 'arith');
    rejects((p) => (p.arith.tables = 'other'), 'arith.tables');
    rejects((p) => (p.trainedOn = 5), 'trainedOn');
  });

  it('rejects malformed constants', () => {
    rejects((p) => (p.constants = undefined), 'constants');
    rejects((p) => (p.constants.eta = 0.5), 'constants.eta');
    rejects((p) => (p.constants.rates = 1), 'constants.rates');
    rejects((p) => (p.constants.rates.vfeat = [1, 2]), 'constants.rates.vfeat');
    rejects((p) => (p.constants.rates.vfeat = 'abcde'), 'constants.rates.vfeat');
    rejects((p) => (p.constants.rates.vfeat = [1, 2, 3, 4, 0.5]), 'constants.rates.vfeat');
    rejects((p) => (p.constants.n0 = 0), 'constants.n0');
    rejects((p) => (p.constants.ladder = [2, 0, 1]), 'constants.ladder');
  });

  it('rejects malformed tables', () => {
    rejects((p) => (p.tables = 'x'), 'tables');
    rejects((p) => (p.tables.numberShared = undefined), 'tables.numberShared');
    rejects((p) => (p.tables.escape = undefined), 'tables.escape');
    rejects((p) => (p.tables.kernel.scale = -1), 'tables.kernel.scale');
    rejects((p) => (p.tables.kernel.scale = 0.5), 'tables.kernel.scale');
    rejects((p) => (p.tables.kernel.offset = 0.5), 'tables.kernel.offset');
    rejects((p) => (p.tables.kernel.data = [0, 0]), 'tables.kernel.data');
    rejects((p) => (p.tables.kernel.data = 'abc'), 'tables.kernel.data');
    rejects((p) => (p.tables.kernel.data = [0, 128, 0]), 'tables.kernel.data');
    rejects((p) => (p.tables.kernel.data = [0, -129, 0]), 'tables.kernel.data');
    rejects((p) => (p.tables.kernel.data = [0, 0.5, 0]), 'tables.kernel.data');
    rejects((p) => {
      p.tables.kernel.scale = POW2[50];
      p.tables.kernel.offset = POW2[52];
      p.tables.kernel.data = [127, 0, 0];
    }, 'tables.kernel.data');
    rejects((p) => (p.tables.hybrid = zeros(10)), 'tables.hybrid.data');
    rejects((p) => (p.tables.apm = zeros(10)), 'tables.apm.data');
    rejects((p) => (p.tables.logn = zeros(10)), 'tables.logn.data');
    rejects((p) => (p.tables.numberShared.conf = zeros(10)), 'tables.numberShared.conf.data');
  });

  it('takes structure ids s as -1 - s in the built-in', () => {
    const p = small();
    p.builtin.symbols = [97, -2, -36];
    p.builtin.counts0 = [1, 2, 3, 4];
    p.builtin.contexts1 = [
      [-36, 97, 1],
      [-2, -36, 2],
      [-1, -2, 1],
    ];
    expect(loadPrior(p).builtinSymbols).toEqual([97, -2, -36]);
  });

  it('rejects malformed built-ins', () => {
    rejects((p) => (p.builtin = null), 'builtin');
    rejects((p) => (p.builtin.symbols = 'ab'), 'builtin.symbols');
    rejects((p) => (p.builtin.symbols = [97, -1]), 'builtin.symbols');
    rejects((p) => (p.builtin.symbols = [97, -37]), 'builtin.symbols');
    rejects((p) => (p.builtin.symbols = [97, 0x110000]), 'builtin.symbols');
    rejects((p) => (p.builtin.symbols = [97, 1.5]), 'builtin.symbols');
    rejects((p) => (p.builtin.symbols = [97, 97]), 'builtin.symbols');
    rejects((p) => (p.builtin.counts0 = [1, 2]), 'builtin.counts0');
    rejects((p) => (p.builtin.counts0 = 3), 'builtin.counts0');
    rejects((p) => (p.builtin.counts0 = [1, 0, 3]), 'builtin.counts0');
    rejects((p) => (p.builtin.counts0 = [1, 0.5, 3]), 'builtin.counts0');
    rejects((p) => (p.builtin.contexts1 = {}), 'builtin.contexts1');
    rejects((p) => (p.builtin.contexts1 = [[-1, 97]]), 'builtin.contexts1');
    rejects((p) => (p.builtin.contexts1 = [5]), 'builtin.contexts1');
    rejects((p) => (p.builtin.contexts1 = [[99, 97, 1]]), 'builtin.contexts1');
    rejects((p) => (p.builtin.contexts1 = [[97, 99, 1]]), 'builtin.contexts1');
    rejects((p) => (p.builtin.contexts1 = [[97, 98, 0]]), 'builtin.contexts1');
    rejects((p) => (p.builtin.contexts1 = [[97, 98, 0.5]]), 'builtin.contexts1');
    rejects(
      (p) =>
        (p.builtin.contexts1 = [
          [97, 98, 1],
          [-1, 97, 1],
        ]),
      'builtin.contexts1'
    );
    rejects(
      (p) =>
        (p.builtin.contexts1 = [
          [97, 98, 1],
          [97, 97, 1],
        ]),
      'builtin.contexts1'
    );
    rejects(
      (p) =>
        (p.builtin.contexts1 = [
          [97, 98, 1],
          [97, 98, 1],
        ]),
      'builtin.contexts1'
    );
  });

  it('sizes the tables by the order', () => {
    const l = loadPrior(small(3));
    expect(l.hybrid.length).toBe(NSRC * 8 * HF);
    expect(l.apm.length).toBe(3 * 4 * APM_B);
    expect(l.logn.length).toBe(NSRC * 4 + 1);
  });
});
