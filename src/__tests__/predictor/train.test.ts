import { p } from '../../nodes';
import { Encoder } from '../../packer';
import { loadedPriors, loadPrior } from '../../predictor/prior';
import { session } from '../../predictor/session';
import { MAX_CONTEXTS, quantise, train, trainLogged } from '../../predictor/train';
import type { Prior } from '../../predictor/types';
import { newRunPrior } from '../../predictor/weights';

const SAMPLES = [
  'hello world, hello there',
  'hello again world',
  'world says hello',
  'hello hello world',
];

const bytes = (prior: Prior | undefined, samples: readonly string[]): number =>
  samples.reduce(
    (a, s) =>
      a +
      p
        .string()
        .compress(prior === undefined ? {} : { prior })
        .encode(s).length,
    0
  );

describe('train', () => {
  it('gives the same prior for the same inputs and seed', () => {
    const a = train(p.string().compress(), SAMPLES, { holdOut: 0, seed: 7 });
    const b = train(p.string().compress(), SAMPLES, { holdOut: 0, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = train(p.string().compress(), SAMPLES, { holdOut: 0, seed: -3 });
    expect(() => loadPrior(c)).not.toThrow();
  });

  it('makes a prior that codes its own samples smaller than the shipped one', () => {
    const prior = train(p.string().compress(), SAMPLES, { holdOut: 0 });
    expect(() => loadPrior(prior)).not.toThrow();
    expect(bytes(prior, SAMPLES)).toBeLessThan(bytes(undefined, SAMPLES));
  });

  it('keeps the constants of `from` without a held-out part and copies numberStart', () => {
    const from = loadedPriors.json.source;
    const prior = train(p.string().compress(), SAMPLES, { holdOut: 0, from, epochs: 1 });
    expect(prior.constants).toEqual(from.constants);
    expect(prior.tables.numberStart).toEqual(from.tables.numberStart);
    expect(prior.trainedOn).toBeUndefined();
  });

  it('counts the built-in from the samples: END after every value, structure ids as -1 - s', () => {
    const text = train(p.string().compress(), ['ab', 'b'], { holdOut: 0, epochs: 1 });
    expect(text.builtin).toEqual({
      symbols: [97, 98],
      counts0: [2, 1, 2],
      contexts1: [
        [-1, 97, 1],
        [-1, 98, 1],
        [97, 98, 1],
        [98, -1, 2],
      ],
    });
    const json = train(p.any().compress(), [{ a: [1, 'x'] }], { holdOut: 0, epochs: 1 });
    expect(json.builtin.symbols).toEqual(expect.arrayContaining([97, 120, -2, -4]));
    expect(() => loadPrior(json)).not.toThrow();
  });

  it('keeps the most frequent order-1 triples up to the cap, sorted by (prev, next)', () => {
    // Every pair of 51 symbols: 2,601 triples, of which the cap keeps 2,500.
    const cs = Array.from({ length: 51 }, (_, i) => String.fromCodePoint(0x4e00 + i));
    const all = cs.map((a) => cs.map((b) => a + b).join('')).join('');
    const prior = train(p.string().compress(), [`${all}ab`, 'ab', 'ab'], { holdOut: 0, epochs: 1 });
    const c = prior.builtin.contexts1;
    expect(c).toHaveLength(MAX_CONTEXTS);
    expect(c).toContainEqual([97, 98, 3]);
    expect(c).toContainEqual([98, -1, 3]);
    const sorted = [...c].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    expect(c).toEqual(sorted);
    // Among equal counts the first in (prev, next) order stay.
    expect(c).toContainEqual([0x4e00, 0x4e00, 2]);
    expect(c).not.toContainEqual([-1, 0x4e00, 1]);
    expect(() => loadPrior(prior)).not.toThrow();
  });

  it('closes a message without a value end with END', () => {
    const fixed = train(p.string().length(2).compress(), ['ab'], { holdOut: 0, epochs: 1 });
    expect(fixed.builtin.contexts1).toEqual([
      [-1, 97, 1],
      [97, 98, 1],
      [98, -1, 1],
    ]);
  });

  it('starts binaries from the text prior with an empty built-in', () => {
    const prior = train(p.binary().compress(), [Uint8Array.of(1, 2, 3, 1, 2, 3)], {
      holdOut: 0,
      epochs: 1,
    });
    expect(prior.builtin).toEqual({ symbols: [], counts0: [1], contexts1: [] });
    expect(prior.tables.numberStart).toEqual(loadedPriors.text.source.tables.numberStart);
    expect(() => loadPrior(prior)).not.toThrow();
  });

  it('picks η, ρ0 and N0 on the held-out samples from the grid', () => {
    const lines: string[] = [];
    const prior = trainLogged(p.string().compress(), SAMPLES, { epochs: 1 }, (l) => lines.push(l));
    expect(lines.filter((l) => l.startsWith('grid'))).toHaveLength(36);
    expect([726132, 2420441, 7261322]).toContain(prior.constants.eta);
    expect([4194304, 8388608, 16777216, 33554432]).toContain(prior.constants.rho0);
    expect([256, 1024, 4096]).toContain(prior.constants.n0);
    expect(prior.constants.rates.lev).toBe(prior.constants.eta);
    expect(prior.constants.rates.number).toBe(loadedPriors.text.source.constants.rates.number);
    expect(() => loadPrior(prior)).not.toThrow();
  });

  it('narrows the grid to the axes given', () => {
    const lines: string[] = [];
    const prior = trainLogged(
      p.string().compress(),
      SAMPLES,
      { epochs: 1, grid: { eta: [1000000, 2000000], n0: [512] } },
      (l) => lines.push(l)
    );
    expect(lines.filter((l) => l.startsWith('grid'))).toHaveLength(8);
    expect([1000000, 2000000]).toContain(prior.constants.eta);
    expect(prior.constants.n0).toBe(512);
    expect(lines).toContain(
      `constants: eta=${prior.constants.eta} rho0=${prior.constants.rho0} n0=512`
    );
  });

  it('refuses a node without .compress()', () => {
    expect(() => train(p.string(), SAMPLES)).toThrow(TypeError);
    expect(() => train(p.array(p.int()), [[1]])).toThrow('no .compress()');
  });

  it('refuses invalid options', () => {
    const t =
      (o: object, samples: readonly string[] = SAMPLES): (() => Prior) =>
      () =>
        train(p.string().compress(), samples, o);
    expect(t({ holdOut: NaN })).toThrow(TypeError);
    expect(t({ holdOut: '0.5' })).toThrow(TypeError);
    expect(t({ holdOut: -0.1 })).toThrow(RangeError);
    expect(t({ holdOut: 1 })).toThrow(RangeError);
    expect(t({ epochs: 1.5 })).toThrow(TypeError);
    expect(t({ epochs: 0 })).toThrow(RangeError);
    expect(t({ seed: 0.5 })).toThrow(TypeError);
    expect(t({}, [])).toThrow(RangeError);
    expect(t({}, ['one'])).toThrow('at least two samples');
    expect(t({ holdOut: 0, from: { format: 2 } })).toThrow('invalid prior');
    expect(t({ grid: { eta: [] } })).toThrow(RangeError);
    expect(t({ grid: { rho0: [1.5] } })).toThrow(TypeError);
    expect(t({ grid: { n0: [0] } })).toThrow('grid.n0 must hold values of at least 1');
  });
});

describe('quantise', () => {
  it('spans the range in Int8 steps and rounds to the nearest step', () => {
    expect(quantise([5, 5])).toEqual({ scale: 1, offset: 133, data: [-128, -128] });
    const q = quantise([0, 1000, 510]);
    expect(q.scale).toBe(4);
    expect(q.data).toEqual([-128, 122, 0]);
    expect(q.data.map((d) => d * q.scale + q.offset)).toEqual([0, 1000, 512]);
  });
});

describe('a session that carries a run prior', () => {
  it('learns into it, under its prior, for every node of the message', () => {
    const run = newRunPrior(loadedPriors.json);
    const before = run.hybrid.slice();
    const enc = new Encoder();
    const s = session(enc, { carry: run });
    p.string().compress()._write(enc, 'carried text');
    expect(s.space(loadedPriors.json).run).toBe(run);
    expect(s.space(loadedPriors.text)).toBe(s.space(loadedPriors.json));
    expect(run.hybrid).not.toEqual(before);
  });
});
