import { DEFAULTS, applyAdaptive, checkAdaptive, resolve } from '../../predictor/options';
import { Priors } from '../../predictor/prior';
import { text } from '../../predictor/shipped/text';
import type { AdaptiveOptions, Prior } from '../../predictor/types';

const who = 'p.string()';
const opts = (o: Record<string, unknown>): AdaptiveOptions => o as AdaptiveOptions;

describe('checkAdaptive', () => {
  it('accepts no options and valid options', () => {
    expect(checkAdaptive(undefined, who)).toEqual({});
    const o = {
      window: 4096,
      separate: true,
      order: 8,
      candidates: 0,
      offsets: 1024,
      history: 1,
      quantisation: 4096,
      prior: text,
    };
    const c = checkAdaptive(o, who);
    expect(c).toEqual(o);
    expect(c).not.toBe(o);
    expect(Object.isFrozen(c)).toBe(true);
    expect(checkAdaptive({ quantisation: 2 ** 24, history: 4096, order: 12 }, who)).toBeTruthy();
  });

  it('rejects a non-object', () => {
    expect(() => checkAdaptive(opts(null as never), who)).toThrow(TypeError);
    expect(() => checkAdaptive(opts([] as never), who)).toThrow(TypeError);
    expect(() => checkAdaptive(opts(3 as never), who)).toThrow('p.string(): adaptive options');
  });

  it('checks window and separate', () => {
    expect(() => checkAdaptive({ window: 1.5 }, who)).toThrow(TypeError);
    expect(checkAdaptive({ window: Infinity }, who).window).toBe(Infinity);
    expect(resolve({ window: Infinity }, Priors.text, who).window).toBe(Infinity);
    expect(() => checkAdaptive({ window: -Infinity }, who)).toThrow(TypeError);
    expect(() => checkAdaptive({ window: NaN }, who)).toThrow(TypeError);
    expect(() => checkAdaptive({ window: 0 }, who)).toThrow(RangeError);
    expect(checkAdaptive({ window: 1 }, who).window).toBe(1);
    expect(() => checkAdaptive(opts({ separate: 1 }), who)).toThrow(TypeError);
    expect(checkAdaptive({ separate: false }, who).separate).toBe(false);
  });

  it.each([
    ['order', 1, 12],
    ['candidates', 0, 64],
    ['offsets', 0, 1024],
    ['history', 1, 4096],
  ])('checks %s in %d..%d', (key, lo, hi) => {
    expect(checkAdaptive({ [key]: lo }, who)).toBeTruthy();
    expect(checkAdaptive({ [key]: hi }, who)).toBeTruthy();
    expect(() => checkAdaptive({ [key]: lo - 1 }, who)).toThrow(RangeError);
    expect(() => checkAdaptive({ [key]: hi + 1 }, who)).toThrow(RangeError);
    expect(() => checkAdaptive({ [key]: lo + 0.5 }, who)).toThrow(TypeError);
    expect(() => checkAdaptive(opts({ [key]: '8' }), who)).toThrow(TypeError);
  });

  it('checks quantisation', () => {
    expect(() => checkAdaptive({ quantisation: 2048 }, who)).toThrow(RangeError);
    expect(() => checkAdaptive({ quantisation: 2 ** 25 }, who)).toThrow(RangeError);
    expect(() => checkAdaptive({ quantisation: 5000 }, who)).toThrow(TypeError);
    expect(() => checkAdaptive({ quantisation: 65536.5 }, who)).toThrow(TypeError);
    expect(checkAdaptive({ quantisation: 2 ** 20 }, who).quantisation).toBe(2 ** 20);
  });

  it('loads the prior', () => {
    expect(() => checkAdaptive({ prior: { format: 2 } as unknown as Prior }, who)).toThrow(
      'invalid prior: format'
    );
  });
});

describe('resolve', () => {
  it('fills in the defaults', () => {
    const r = resolve(undefined, Priors.text, who);
    expect(r).toEqual({
      prior: Priors.text,
      window: Infinity,
      separate: false,
      ...DEFAULTS,
    });
  });

  it('keeps given values and loads a given prior once', () => {
    const r = resolve(
      {
        prior: text,
        window: 16,
        separate: true,
        order: 8,
        candidates: 4,
        offsets: 8,
        history: 32,
        quantisation: 4096,
      },
      null as never,
      who
    );
    expect(r.prior).toBe(Priors.text);
    expect([r.window, r.separate, r.order, r.candidates, r.offsets, r.history]).toEqual([
      16,
      true,
      8,
      4,
      8,
      32,
    ]);
    expect(r.quantisation).toBe(4096);
  });

  it("rejects an order other than the prior's", () => {
    expect(() => resolve({ order: 6 }, Priors.text, who)).toThrow(TypeError);
    expect(() => resolve({ order: 6 }, Priors.text, who)).toThrow(
      "adaptive order 6 differs from the prior's order 8"
    );
  });
});

describe('applyAdaptive', () => {
  it('leaves a node the sugar does not reach as it is', () => {
    const node = {};
    expect(applyAdaptive(node, {}, Priors.text.source)).toBe(node);
  });

  it('hands the options and a fresh memo to a node it reaches', () => {
    const seen: unknown[] = [];
    const out = {};
    const node = {
      _adapted(options: AdaptiveOptions, memo: Map<unknown, unknown>) {
        seen.push(options, memo.size);
        return out;
      },
    };
    expect(applyAdaptive(node, { window: 4 }, Priors.text.source)).toBe(out);
    expect(seen).toEqual([{ window: 4, prior: Priors.text.source }, 0]);
  });

  it('keeps a prior the options name', () => {
    const seen: unknown[] = [];
    const node = {
      _adapted(options: AdaptiveOptions) {
        seen.push(options.prior);
        return node;
      },
    };
    const prior = { ...Priors.text.source };
    applyAdaptive(node, { prior }, Priors.text.source);
    expect(seen).toEqual([prior]);
  });
});
