/**
 * PPM contexts above an adaptive prior: a learned context's counts, the
 * escape cells, and the model that codes each symbol through the contexts
 * of its history before the prior, with exclusion.
 */

import { Encoder, Decoder, costUnits } from '../../packer';
import { AdaptivePrior } from '../../nodes/adaptive';
import {
  CELL_LIMIT,
  CONTEXT_LIMIT,
  Context,
  ContextModel,
  MAX_ORDER,
  WARMUP,
  cellKey,
} from '../../nodes/contexts';
import { mulberry32 } from '../support';

const SIZE = 5;
const START = SIZE;
const WEIGHTS = [5, 3, 2, 1, 1];

/** A toy prior over five symbols: one row for order 0, a row per previous symbol (or none) for order 1. */
const priorOf = (order: 0 | 1): AdaptivePrior =>
  new AdaptivePrior(
    order === 0
      ? [WEIGHTS]
      : Array.from({ length: SIZE + 1 }, (_, i) => WEIGHTS.map((w, j) => w + (i === j ? 4 : 0))),
    SIZE,
    undefined,
    'w'
  );

const modelOf = (order: 0 | 1): ContextModel => new ContextModel(priorOf(order), SIZE, order, 'w');

/** Each symbol's history, newest first, and its row: the previous symbol under order 1. */
const steps = (symbols: readonly number[], order: 0 | 1) => {
  let history = [START, START, START];
  return symbols.map((sym) => {
    const step = { sym, history, row: order === 0 ? 0 : history[0] };
    history = [sym, history[0], history[1]];
    return step;
  });
};

/** A seeded sequence: a repeating phrase with noise, so contexts of every order recur and miss. */
const sequence = (seed: number, length: number, noise = 0.15): number[] => {
  const random = mulberry32(seed);
  const phrase = [0, 1, 2, 0, 3, 1, 0, 4];
  return Array.from({ length }, (_, i) =>
    random() < noise ? Math.floor(random() * SIZE) : phrase[i % phrase.length]
  );
};

const encode = (model: ContextModel, symbols: readonly number[], order: 0 | 1): Uint8Array => {
  const enc = new Encoder();
  for (const { sym, row, history } of steps(symbols, order)) {
    model.write(enc, sym, row, history);
  }
  return enc.output();
};

const decode = (
  model: ContextModel,
  bytes: Uint8Array,
  symbols: readonly number[],
  order: 0 | 1
): number[] => {
  const dec = new Decoder(bytes);
  const out = steps(symbols, order).map(({ row, history }) => model.read(dec, row, history));
  dec.finalize();
  return out;
};

describe('Context', () => {
  it('refuses a size that is not a positive integer', () => {
    expect(() => new Context(1.5)).toThrow(
      new TypeError('Context size must be an integer, got 1.5')
    );
    expect(() => new Context(0)).toThrow(new RangeError('Context size 0 is below the minimum 1'));
  });

  it('holds nothing until it sees a symbol', () => {
    const context = new Context(4);
    expect(context.size).toBe(4);
    expect(context.total).toBe(0);
    expect([0, 1, 2, 3].map((pos) => [context.cum(pos), context.freq(pos)])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(context.has(0)).toBe(false);
  });

  it('enters a new symbol at 1 and adds 2 for a seen one', () => {
    const context = new Context(4);
    context.update(2);
    expect([context.syms, context.counts, context.total]).toEqual([[2], [1], 1]);
    context.update(2);
    expect([context.syms, context.counts, context.total]).toEqual([[2], [3], 3]);
    context.update(0);
    context.update(3);
    context.update(0);
    expect(context.syms).toEqual([0, 2, 3]);
    expect(context.counts).toEqual([3, 3, 1]);
    expect(context.total).toBe(7);
    expect([0, 1, 2, 3].map((pos) => [context.cum(pos), context.freq(pos)])).toEqual([
      [0, 3],
      [3, 0],
      [3, 3],
      [6, 1],
    ]);
    expect([0, 1, 2, 3, 4, -1].map((sym) => context.has(sym))).toEqual([
      true,
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  it('halves every count, rounding up, once the sum passes the limit', () => {
    expect(CONTEXT_LIMIT).toBe(1024);
    const context = new Context(4);
    context.update(1);
    context.update(3);
    // 1 + 2·511 = 1023 for symbol 3, and 1 for symbol 1: the sum is 1024.
    for (let i = 0; i < 511; i++) {
      context.update(3);
    }
    expect([context.counts, context.total]).toEqual([[1, 1023], 1024]);
    context.update(0);
    // 1025 passes the limit: 1, 1 and 1023 halve to 1, 1 and 512.
    expect([context.syms, context.counts, context.total]).toEqual([[0, 1, 3], [1, 1, 512], 514]);
    expect(context.cum(3)).toBe(2);
  });

  it('refuses a member or symbol outside its range', () => {
    const context = new Context(4);
    for (const pos of [-1, 4]) {
      expect(() => context.cum(pos)).toThrow(
        new RangeError(`Context member ${pos} is outside [0, 4)`)
      );
      expect(() => context.freq(pos)).toThrow(
        new RangeError(`Context member ${pos} is outside [0, 4)`)
      );
    }
    expect(() => context.cum(0.5)).toThrow(new TypeError('Context member 0.5 is not an integer'));
    expect(() => context.update(4)).toThrow(new RangeError('Context symbol 4 is outside [0, 4)'));
    expect(() => context.update(NaN)).toThrow(
      new TypeError('Context symbol NaN is not an integer')
    );
  });
});

describe('cellKey', () => {
  it('keys on the order index, the symbols left by powers of two, and their mean count', () => {
    expect([1, 2, 3, 4, 5, 8, 9, 16, 17, 32, 33, 1000].map((n) => cellKey(0, n, n))).toEqual([
      0, 10, 20, 20, 30, 30, 40, 40, 50, 50, 60, 60,
    ]);
    // Means just below and at 1.5, 3, 6 and 12, over two symbols.
    expect([2, 3, 5, 6, 11, 12, 23, 24, 1000].map((sum) => cellKey(0, 2, sum))).toEqual([
      10, 11, 11, 12, 12, 13, 13, 14, 14,
    ]);
    expect(cellKey(1, 1, 1)).toBe(100);
    expect(cellKey(2, 40, 480)).toBe(264);
  });
});

describe('ContextModel', () => {
  it('keys on up to three previous symbols', () => {
    expect(MAX_ORDER).toBe(3);
  });

  it('refuses a size its prior does not span', () => {
    expect(() => new ContextModel(priorOf(0), 4, 0, 'w')).toThrow(
      new TypeError('w contexts span 4 symbols, but their prior 5')
    );
    expect(modelOf(0).size).toBe(SIZE);
  });

  it.each([
    [0, 1],
    [0, 2],
    [1, 3],
    [1, 4],
  ] as const)('round-trips a seeded sequence under order %i (seed %i)', (order, seed) => {
    const symbols = sequence(seed, 3000);
    const bytes = encode(modelOf(order), symbols, order);
    expect(decode(modelOf(order), bytes, symbols, order)).toEqual(symbols);
    // The contexts learn the phrase the prior alone cannot.
    const prior = priorOf(order);
    const enc = new Encoder();
    for (const { sym, row } of steps(symbols, order)) {
      prior.write(enc, sym, row);
    }
    expect(bytes.length).toBeLessThan(enc.output().length * 0.75);
  });

  it('round-trips a sequence without structure', () => {
    const random = mulberry32(9);
    const symbols = Array.from({ length: 1500 }, () => Math.floor(random() * SIZE));
    for (const order of [0, 1] as const) {
      const bytes = encode(modelOf(order), symbols, order);
      expect(decode(modelOf(order), bytes, symbols, order)).toEqual(symbols);
    }
  });

  it('writes a symbol in brand-new contexts as the prior alone does', () => {
    for (const order of [0, 1] as const) {
      for (let sym = 0; sym < SIZE; sym++) {
        const prior = priorOf(order);
        const enc = new Encoder();
        prior.write(enc, sym, order === 0 ? 0 : START);
        const bytes = encode(modelOf(order), [sym], order);
        expect(bytes).toEqual(enc.output());
        expect(decode(modelOf(order), bytes, [sym], order)).toEqual([sym]);
      }
    }
  });

  /**
   * A model and its prior on a fresh Encoder past the warm-up that has
   * learned `symbols`, with the step after them. The warm-up learns symbol 4
   * after three 4s, a history the steps below never take.
   */
  const trained = (order: 0 | 1, symbols: readonly number[], next: number) => {
    const prior = priorOf(order);
    const model = new ContextModel(prior, SIZE, order, 'w');
    const enc = new Encoder();
    for (let i = 0; i < WARMUP; i++) {
      model.learn(enc, 4, 0, [4, 4, 4]);
    }
    const all = steps([...symbols, next], order);
    for (const { sym, row, history } of all.slice(0, -1)) {
      model.learn(enc, sym, row, history);
    }
    return { model, prior, enc, step: all[all.length - 1] };
  };

  it.each([
    ['a hit in the longest context', [0, 1, 2, 0, 1, 2, 0, 1], 2],
    ['an escape from the longest context into a shorter one', [0, 1, 2, 3, 1, 2, 0, 1], 2],
    ['escapes down to the prior with symbols excluded', [0, 1, 2, 0, 1, 3, 0, 1], 4],
    ['escapes from contexts that hold nothing', [0, 1, 2], 4],
  ])('prices %s as its write codes, the prior at its estimate', (_name, symbols, next) => {
    for (const order of [0, 1] as const) {
      const { model, prior, enc, step } = trained(order, symbols, next);
      const priced = model.price(enc, step.sym, step.row, step.history);
      let coded = 0;
      const compose = enc.composeWeighted.bind(enc);
      const spy = jest.spyOn(enc, 'composeWeighted').mockImplementation((cum, freq, total) => {
        coded += costUnits(freq, total);
        compose(cum, freq, total);
      });
      const estimated = jest
        .spyOn(prior, 'write')
        .mockImplementation((side, pos, row, excluded) => {
          const [, freq, total] = prior.estimate(side, pos, row, excluded);
          coded += costUnits(freq, total);
        });
      model.write(enc, step.sym, step.row, step.history);
      spy.mockRestore();
      estimated.mockRestore();
      expect(priced).toBe(coded);
      // Pricing learns nothing: the same price again.
      const fresh = trained(order, symbols, next);
      const again = fresh.model.price(fresh.enc, step.sym, step.row, step.history);
      fresh.model.price(fresh.enc, step.sym, step.row, step.history);
      const twice = fresh.model.price(fresh.enc, step.sym, step.row, step.history);
      expect(again).toBe(twice);
    }
  });

  it('gives an escaped symbol the states its higher contexts have ruled out', () => {
    // 4 after 3 0 1: the order-3 context is new and holds nothing, so it is
    // skipped; after 0 1 the order-2 context has seen 2 and 3 once each, two
    // symbols at a mean count of 1, so its fresh cell 10 at index 1 escapes
    // at 2 of 6 and rules them out; after 1 the order-1 context has seen
    // only 2 and 3 too, so nothing is left in it and it is skipped. The
    // prior's estimate is its rung of prior 3 with the warm-up's 64 4s and
    // the eight symbols learned at 12 each: 4 holds 1·3 + 64·12 of the 867
    // that 0, 1 and 4 hold, 2 and 3 ruled out.
    const { model, enc, step } = trained(0, [0, 1, 2, 0, 1, 3, 0, 1], 4);
    const priced = model.price(enc, step.sym, step.row, step.history);
    expect(priced).toBe(costUnits(2, 6) + costUnits(771, 867));
    const spy = jest.spyOn(enc, 'composeWeighted');
    model.write(enc, step.sym, step.row, step.history);
    // Only the order-2 escape and the prior, still static on its first
    // written value, write anything: 4 holds 1 of the 9 states 2 and 3 leave.
    expect(spy.mock.calls).toEqual([
      [4, 2, 6],
      [8, 1, 9],
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    const symbols = [0, 1, 2, 0, 1, 3, 0, 1, 4];
    const bytes = encode(modelOf(0), symbols, 0);
    expect(decode(modelOf(0), bytes, symbols, 0)).toEqual(symbols);
  });

  it('learns each cell from the decisions coded in it, halving past the limit', () => {
    expect(CELL_LIMIT).toBe(4096);
    // Zeros after zeros past the warm-up: each a hit in the order-3
    // context, one symbol at a mean count of at least 12, cell 4. The cell
    // starts at 4 hits and 2 escapes and gains 2 hits per symbol; the
    // symbol then holds every state of its context, a factor of one that
    // may round.
    const zeros = (n: number): { model: ContextModel; enc: Encoder } => {
      const model = modelOf(0);
      const enc = new Encoder();
      for (const { sym, row, history } of steps(new Array<number>(n).fill(0), 0)) {
        model.write(enc, sym, row, history);
      }
      return { model, enc };
    };
    const hit = (hits: number, total: number): void => {
      const { model, enc } = zeros(WARMUP + hits);
      const priced = model.price(enc, 0, 0, [0, 0, 0]);
      expect(priced).toBe(costUnits(hits === 0 ? 4 : total - 2, total));
    };
    hit(0, 6);
    hit(3, 12);
    // 2046 hits bring the cell to 4096 and 2, past the limit: 2048 and 1,
    // and one more hit to 2050 and 1, where unhalved counts would be 4098
    // and 2.
    const { model, enc } = zeros(WARMUP + 2047);
    const priced = model.price(enc, 0, 0, [0, 0, 0]);
    expect(priced).toBe(costUnits(2050, 2051));
  });

  it('tells whether the last symbol coded was a hit in the highest-order context', () => {
    for (const order of [0, 1] as const) {
      const model = modelOf(order);
      const enc = new Encoder();
      const run = steps([...new Array<number>(WARMUP + 1).fill(0), 1, 0, 0], order);
      expect(model.hitTop(enc)).toBe(false);
      run.slice(0, WARMUP).forEach(({ sym, row, history }) => {
        model.write(enc, sym, row, history);
        expect(model.hitTop(enc)).toBe(false);
      });
      const code = (i: number): boolean => {
        model.write(enc, run[i].sym, run[i].row, run[i].history);
        return model.hitTop(enc);
      };
      // A zero after zeros hits the top; 1 is new everywhere and goes to
      // the prior; the zero after it hits only the order-1 context.
      expect([code(WARMUP), code(WARMUP + 1), code(WARMUP + 2)]).toEqual([true, false, false]);
      const last = run[WARMUP + 3];
      const dec = new Decoder(enc.output());
      const reader = modelOf(order);
      run.slice(0, WARMUP + 1).forEach(({ row, history }) => reader.read(dec, row, history));
      expect(reader.hitTop(dec)).toBe(true);
      reader.learn(dec, last.sym, last.row, last.history);
      expect(reader.hitTop(dec)).toBe(false);
    }
  });

  it('rules out a symbol named as excluded from every table', () => {
    const symbols = sequence(12, 1500);
    const except = symbols.map((sym, i) => (i % 3 === 0 ? (sym + 1 + (i % 4)) % SIZE : undefined));
    for (const order of [0, 1] as const) {
      const run = steps(symbols, order);
      const writer = modelOf(order);
      const plain = modelOf(order);
      const enc = new Encoder();
      const unexcluded = new Encoder();
      run.forEach(({ sym, row, history }, i) => {
        writer.write(enc, sym, row, history, except[i]);
        plain.write(unexcluded, sym, row, history);
      });
      const bytes = enc.output();
      expect(bytes.length).toBeLessThan(unexcluded.output().length);
      const reader = modelOf(order);
      const dec = new Decoder(bytes);
      expect(run.map(({ row, history }, i) => reader.read(dec, row, history, except[i]))).toEqual(
        symbols
      );
      dec.finalize();
    }
  });

  it('prices a symbol under an exclusion as it writes it, skipping a context left empty', () => {
    // 2 after 3 0 1, 3 ruled out: the order-3 context is new and skipped;
    // the order-2 one keeps only 2 of its 2 and 3.
    const { model, enc, step } = trained(0, [0, 1, 2, 0, 1, 3, 0, 1], 2);
    const priced = model.price(enc, step.sym, step.row, step.history, 3);
    let coded = 0;
    const compose = enc.composeWeighted.bind(enc);
    const spy = jest.spyOn(enc, 'composeWeighted').mockImplementation((cum, freq, total) => {
      coded += costUnits(freq, total);
      compose(cum, freq, total);
    });
    model.write(enc, step.sym, step.row, step.history, 3);
    // One symbol of count 1 left at index 1: cell 100, a hit at 4 of 6,
    // then the symbol, which holds every state left.
    expect(spy.mock.calls).toEqual([
      [0, 4, 6],
      [0, 1, 1],
    ]);
    spy.mockRestore();
    expect(priced).toBe(coded);
    expect(model.hitTop(enc)).toBe(false);
  });

  it('decodes values learned between written ones on both sides', () => {
    const symbols = sequence(5, 1200);
    const random = mulberry32(6);
    const learned = symbols.map(() => random() < 0.4);
    for (const order of [0, 1] as const) {
      const run = steps(symbols, order);
      const writer = modelOf(order);
      const enc = new Encoder();
      run.forEach(({ sym, row, history }, i) => {
        if (learned[i]) {
          writer.learn(enc, sym, row, history);
        } else {
          writer.write(enc, sym, row, history);
        }
      });
      const reader = modelOf(order);
      const dec = new Decoder(enc.output());
      const out = run.map(({ sym, row, history }, i) => {
        if (learned[i]) {
          reader.learn(dec, sym, row, history);
          return sym;
        }
        return reader.read(dec, row, history);
      });
      dec.finalize();
      expect(out).toEqual(symbols);
    }
  });

  it('refuses a symbol, row or history outside the model', () => {
    const model = modelOf(1);
    const enc = new Encoder();
    const dec = new Decoder(new Encoder().output());
    const history = [START, START, START];
    expect(() => model.write(enc, 5, 0, history)).toThrow(
      new RangeError('w symbol 5 is outside [0, 5)')
    );
    expect(() => model.learn(enc, -1, 0, history)).toThrow(
      new RangeError('w symbol -1 is outside [0, 5)')
    );
    expect(() => model.price(enc, 0.5, 0, history)).toThrow(
      new TypeError('w symbol 0.5 is not an integer')
    );
    expect(() => model.write(enc, 0, 0, history, 5)).toThrow(
      new RangeError('w excluded symbol 5 is outside [0, 5)')
    );
    expect(() => model.read(dec, 0, history, -1)).toThrow(
      new RangeError('w excluded symbol -1 is outside [0, 5)')
    );
    for (const row of [6, -1, 0.5]) {
      const message = new RangeError(`Row ${row} is outside [0, 6)`);
      expect(() => model.write(enc, 0, row, history)).toThrow(message);
      expect(() => model.read(dec, row, history)).toThrow(message);
    }
    for (const bad of [[START, START], [START, START, START, START], []]) {
      const message = new TypeError(`w history must hold 3 symbols, got ${bad.length}`);
      expect(() => model.write(enc, 0, 0, bad)).toThrow(message);
      expect(() => model.read(dec, 0, bad)).toThrow(message);
    }
    expect(() => model.read(dec, 0, [6, 0, 0])).toThrow(
      new RangeError('w history symbol 6 is outside [0, 5]')
    );
    expect(() => model.write(enc, 0, 0, [0, -1, 0])).toThrow(
      new RangeError('w history symbol -1 is outside [0, 5]')
    );
    expect(() => model.write(enc, 0, 0, [0, 0, 1.5])).toThrow(
      new TypeError('w history symbol 1.5 is not an integer')
    );
  });
});

describe('ContextModel warm-up', () => {
  /** Symbols whose order-3 contexts recur well before the warm-up ends. */
  const symbols = sequence(11, WARMUP + 40, 0);

  it('codes the first WARMUP symbols as the prior alone, and contexts price the next', () => {
    for (const order of [0, 1] as const) {
      const run = steps(symbols, order);
      const model = modelOf(order);
      const prior = priorOf(order);
      const withModel = new Encoder();
      const withPrior = new Encoder();
      run.slice(0, WARMUP).forEach(({ sym, row, history }) => {
        model.write(withModel, sym, row, history);
        prior.write(withPrior, sym, row);
      });
      expect(withModel.output()).toEqual(withPrior.output());
      // The next symbol's contexts have seen it: priced through them, not
      // at the prior's estimate.
      const { sym, row, history } = run[WARMUP];
      const priced = model.price(withModel, sym, row, history);
      const [, freq, total] = prior.estimate(withPrior, sym, row);
      expect(priced).not.toBe(costUnits(freq, total));
      run.slice(WARMUP).forEach((step) => {
        model.write(withModel, step.sym, step.row, step.history);
        prior.write(withPrior, step.sym, step.row);
      });
      expect(withModel.output()).not.toEqual(withPrior.output());
    }
  });

  it('counts learned symbols toward the warm-up, and prices only the prior below it', () => {
    const run = steps(symbols, 0);
    const prior = priorOf(0);
    const model = new ContextModel(prior, SIZE, 0, 'w');
    const enc = new Encoder();
    run
      .slice(0, WARMUP - 1)
      .forEach(({ sym, row, history }) => model.learn(enc, sym, row, history));
    const priceOf = (step: (typeof run)[number]): number =>
      model.price(enc, step.sym, step.row, step.history);
    // One symbol short: the prior's estimate alone, though the contexts
    // have seen the symbol.
    const below = priceOf(run[WARMUP - 1]);
    const estimate = (step: (typeof run)[number]): number => {
      const [, freq, total] = prior.estimate(enc, step.sym, step.row);
      return costUnits(freq, total);
    };
    expect(below).toBe(estimate(run[WARMUP - 1]));
    const last = run[WARMUP - 1];
    model.learn(enc, last.sym, last.row, last.history);
    expect(priceOf(run[WARMUP])).not.toBe(estimate(run[WARMUP]));
  });
});
