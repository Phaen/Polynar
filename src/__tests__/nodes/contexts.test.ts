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
  inherited,
} from '../../nodes/contexts';
import { mulberry32 } from '../support';

const SIZE = 5;
const START = SIZE;
const WEIGHTS = [5, 3, 2, 1, 1];

/** A toy prior over five symbols: one row under 0, a row per previous symbol (or none) under 1. */
const priorOf = (order: 0 | 1): AdaptivePrior =>
  new AdaptivePrior(
    order === 0
      ? [WEIGHTS]
      : Array.from({ length: SIZE + 1 }, (_, i) => WEIGHTS.map((w, j) => w + (i === j ? 4 : 0))),
    SIZE,
    undefined,
    'w'
  );

const modelOf = (order: 0 | 1): ContextModel => new ContextModel(priorOf(order), SIZE, 'w');

/** Each symbol's history, newest first, and its row: the previous symbol under a row per symbol. */
const steps = (symbols: readonly number[], order: 0 | 1) => {
  let history = [START, START, START, START];
  return symbols.map((sym) => {
    const step = { sym, history, row: order === 0 ? 0 : history[0] };
    history = [sym, ...history.slice(0, -1)];
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

  it('enters a new symbol at the count it is given, and recurs by the gain given, 2 by default', () => {
    const context = new Context(4);
    context.update(1, 5);
    context.update(1, 5);
    context.update(3, 9, 1);
    context.update(3, 9, 1);
    expect([context.syms, context.counts, context.total]).toEqual([[1, 3], [7, 10], 17]);
  });

  it('takes back an entry at its count, a recurrence and a halving', () => {
    const enc = new Encoder();
    const context = new Context(4, enc.journal);
    context.update(1);
    const mark = enc.mark();
    context.update(2, 7);
    context.update(1, 7);
    context.update(1, 7, 1);
    for (let i = 0; i < 130; i++) {
      context.update(2);
    }
    expect(context.total).toBeLessThan(CONTEXT_LIMIT);
    enc.rollback(mark);
    expect([context.syms, context.counts, context.total]).toEqual([[1], [1], 1]);
  });

  it('halves every count, rounding up, once the sum passes the limit', () => {
    expect(CONTEXT_LIMIT).toBe(256);
    const context = new Context(4);
    context.update(1);
    context.update(3);
    // 1 + 2·127 = 255 for symbol 3, and 1 for symbol 1: the sum is 256.
    for (let i = 0; i < 127; i++) {
      context.update(3);
    }
    expect([context.counts, context.total]).toEqual([[1, 255], 256]);
    context.update(0);
    // 257 passes the limit: 1, 1 and 255 halve to 1, 1 and 128.
    expect([context.syms, context.counts, context.total]).toEqual([[0, 1, 3], [1, 1, 128], 130]);
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
    expect([1, 2, 3, 4, 5, 8, 9, 16, 17, 32, 33, 1000].map((n) => cellKey(0, n, n, false))).toEqual(
      [0, 10, 20, 20, 30, 30, 40, 40, 50, 50, 60, 60]
    );
    // Means just below and at 1.5, 3, 6 and 12, over two symbols.
    expect([2, 3, 5, 6, 11, 12, 23, 24, 1000].map((sum) => cellKey(0, 2, sum, false))).toEqual([
      10, 11, 11, 12, 12, 13, 13, 14, 14,
    ]);
    expect(cellKey(1, 1, 1, false)).toBe(100);
    expect(cellKey(3, 40, 480, false)).toBe(364);
  });

  it('keys apart the cells after a hit in the highest-order context', () => {
    expect(cellKey(0, 1, 1, true)).toBe(1000);
    expect(cellKey(3, 40, 480, true)).toBe(1364);
  });
});

describe('inherited', () => {
  it('enters a symbol at 1 + ⌊8p⌋, p its probability in the context that coded it', () => {
    // p = (width / sum)·(hit / (hit + escape)).
    expect(inherited(1, 8, 1, 1)).toBe(1);
    expect(inherited(1, 4, 1, 1)).toBe(2);
    expect(inherited(3, 4, 2, 1)).toBe(5);
    expect(inherited(5, 5, 4, 0)).toBe(9);
    // Just below an eighth: 0.1249…
    expect(inherited(1249, 10000, 1, 0)).toBe(1);
  });
});

describe('ContextModel', () => {
  it('keys on up to four previous symbols', () => {
    expect(MAX_ORDER).toBe(4);
  });

  it('refuses a size its prior does not span', () => {
    expect(() => new ContextModel(priorOf(0), 4, 'w')).toThrow(
      new TypeError('w contexts span 4 symbols, but their prior 5')
    );
    expect(modelOf(0).size).toBe(SIZE);
  });

  it.each([
    ['one prior row', 0, 1],
    ['one prior row', 0, 2],
    ['a prior row per previous symbol', 1, 3],
    ['a prior row per previous symbol', 1, 4],
  ] as const)('round-trips a seeded sequence with %s (seed %i)', (_name, order, seed) => {
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
    const model = new ContextModel(prior, SIZE, 'w');
    const enc = new Encoder();
    for (let i = 0; i < WARMUP; i++) {
      model.learn(enc, 4, 0, [4, 4, 4, 4]);
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
      [0, 2, 6],
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
    // Zeros after zeros past the warm-up: each a hit in the order-4
    // context, one symbol at a mean count of at least 12. The first comes
    // after no top hit, cell 4; every later one after a top hit, cell 1004.
    // A cell starts at 4 hits and 2 escapes and gains 2 hits per symbol;
    // the symbol then holds every state of its context, a factor of one
    // that may round.
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
      const priced = model.price(enc, 0, 0, [0, 0, 0, 0]);
      expect(priced).toBe(costUnits(hits === 0 ? 4 : total - 2, total));
    };
    hit(0, 6);
    hit(1, 6);
    hit(3, 10);
    // 2046 hits after the first bring cell 1004 to 4096 and 2, past the
    // limit: 2048 and 1, and one more hit to 2050 and 1, where unhalved
    // counts would be 4098 and 2.
    const { model, enc } = zeros(WARMUP + 2048);
    const priced = model.price(enc, 0, 0, [0, 0, 0, 0]);
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
      [2, 4, 6],
      [0, 1, 1],
    ]);
    spy.mockRestore();
    expect(priced).toBe(coded);
    expect(model.hitTop(enc)).toBe(false);
  });

  it('enters a symbol into the contexts above the one that coded it at what that one gave it', () => {
    // 2 after 1 0 1 0: the order-4 and order-3 contexts are new, the
    // order-2 one has seen 2 after 1 0 and codes it.
    const { model, enc, step } = trained(0, [1, 0, 2, 3, 1, 0], 2);
    const composed = jest.spyOn(enc, 'composeWeighted');
    const update = jest.spyOn(Context.prototype, 'update');
    model.write(enc, step.sym, step.row, step.history);
    const [[, hits, total], [, width, sum]] = composed.mock.calls;
    const enter = inherited(width, sum, hits, total - hits);
    expect(enter).toBeGreaterThan(1);
    // The order-1 context, below the one that coded it, gains 1.
    expect(update.mock.calls).toEqual([
      [2, enter, 2],
      [2, enter, 2],
      [2, enter, 2],
      [2, enter, 1],
    ]);
    composed.mockRestore();
    // A symbol the prior codes, or one learned, enters at 1 everywhere.
    update.mockClear();
    model.write(enc, 4, 0, [2, 0, 1, 3]);
    model.learn(enc, 3, 0, [4, 2, 0, 1]);
    expect(update.mock.calls).toEqual(
      new Array(2 * MAX_ORDER).fill(0).map((_, i) => [i < MAX_ORDER ? 4 : 3, 1, 2])
    );
    update.mockRestore();
  });

  it('teaches the contexts from the one that coded a symbol up, the one below at 1, and the prior below order 3', () => {
    // 2 after 1 0 2 1: a hit in the order-4 context.
    const { model, prior, enc, step } = trained(0, [0, 1, 2, 0, 1, 2, 0, 1], 2);
    const update = jest.spyOn(Context.prototype, 'update');
    const learned = jest.spyOn(prior, 'learn');
    model.write(enc, step.sym, step.row, step.history);
    expect(model.hitTop(enc)).toBe(true);
    expect(update.mock.calls.map(([, , gain]) => gain)).toEqual([2, 1]);
    expect(learned).not.toHaveBeenCalled();
    // The same through `absorb`, and a hit in the order-2 context teaches
    // the prior.
    for (const [symbols, gains, taught] of [
      [[0, 1, 2, 0, 1, 2, 0, 1], [2, 1], 0],
      [[1, 0, 2, 3, 1, 0], [2, 2, 2, 1], 1],
    ] as const) {
      const run = trained(0, symbols, 2);
      const spied = jest.spyOn(run.prior, 'learn');
      update.mockClear();
      run.model.absorb(run.enc, run.step.sym, run.step.row, run.step.history);
      expect(update.mock.calls.map(([, , gain]) => gain)).toEqual(gains);
      expect(spied).toHaveBeenCalledTimes(taught);
    }
    update.mockRestore();
  });

  it('builds the same contexts again after a rollback, their keys in step with the decoder', () => {
    const symbols = sequence(21, 400);
    const tried = sequence(22, 300, 0.5);
    for (const order of [0, 1] as const) {
      const run = steps([...symbols.slice(0, 200), ...tried], order);
      const kept = steps(symbols, order);
      const model = modelOf(order);
      const enc = new Encoder();
      kept.slice(0, 200).forEach(({ sym, row, history }) => model.write(enc, sym, row, history));
      const mark = enc.mark();
      run.slice(200).forEach(({ sym, row, history }) => model.write(enc, sym, row, history));
      enc.rollback(mark);
      kept.slice(200).forEach(({ sym, row, history }) => model.write(enc, sym, row, history));
      const bytes = enc.output();
      expect(bytes).toEqual(encode(modelOf(order), symbols, order));
      expect(decode(modelOf(order), bytes, symbols, order)).toEqual(symbols);
    }
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
    const history = [START, START, START, START];
    expect(() => model.write(enc, 5, 0, history)).toThrow(
      new RangeError('w symbol 5 is outside [0, 5)')
    );
    // The end, 5, is a symbol only where a value may end.
    expect(() => model.learn(enc, -1, 0, history)).toThrow(
      new RangeError('w symbol -1 is outside [0, 6)')
    );
    expect(() => model.write(enc, 6, 0, history, undefined, true)).toThrow(
      new RangeError('w symbol 6 is outside [0, 6)')
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
    for (const bad of [[START, START, START], [START, START, START, START, START], []]) {
      const message = new TypeError(`w history must hold 4 symbols, got ${bad.length}`);
      expect(() => model.write(enc, 0, 0, bad)).toThrow(message);
      expect(() => model.read(dec, 0, bad)).toThrow(message);
    }
    expect(() => model.read(dec, 0, [6, 0, 0, 0])).toThrow(
      new RangeError('w history symbol 6 is outside [0, 5]')
    );
    expect(() => model.write(enc, 0, 0, [0, -1, 0, 0])).toThrow(
      new RangeError('w history symbol -1 is outside [0, 5]')
    );
    expect(() => model.write(enc, 0, 0, [0, 0, 0, 1.5])).toThrow(
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
        prior.learn(withPrior, sym, row);
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
    const model = new ContextModel(prior, SIZE, 'w');
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

describe('ContextModel absorb', () => {
  /** Sums, over the calls of `enc.composeWeighted` while it runs, what each costs in `COST_UNITS`. */
  const costOf = (enc: Encoder, run: () => void): number => {
    let sum = 0;
    const compose = enc.composeWeighted.bind(enc);
    const spy = jest.spyOn(enc, 'composeWeighted').mockImplementation((cum, freq, total) => {
      sum += costUnits(freq, total);
      compose(cum, freq, total);
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }
    return sum;
  };

  /** A seeded choice, per step, of whether it is absorbed: 40% of those past the warm-up. */
  const absorbed = (length: number, seed: number): boolean[] => {
    const random = mulberry32(seed);
    return Array.from({ length }, (_, i) => i >= WARMUP && random() < 0.4);
  };

  it.each([0, 1] as const)(
    'absorbs a symbol as write codes it, in a model of order %i',
    (order) => {
      const symbols = sequence(31, 700, 0.02);
      const choice = absorbed(symbols.length, 5);
      const written = modelOf(order);
      const mixed = modelOf(order);
      const enc1 = new Encoder();
      const enc2 = new Encoder();
      let compared = 0;
      for (const [i, { sym, row, history }] of steps(symbols, order).entries()) {
        const cost = costOf(enc1, () => written.write(enc1, sym, row, history));
        if (choice[i]) {
          const got = mixed.absorb(enc2, sym, row, history);
          expect(got).toBe(written.fell ? -1 : cost);
          compared++;
        } else {
          mixed.write(enc2, sym, row, history);
        }
        expect(mixed.hitTop(enc2)).toBe(written.hitTop(enc1));
        if (written.fell && i >= WARMUP) {
          break;
        }
      }
      expect(compared).toBeGreaterThan(0);
    }
  );

  it.each([0, 1] as const)(
    'reports the cost of a symbol it reads, in a model of order %i',
    (order) => {
      const symbols = sequence(31, 700);
      const choice = absorbed(symbols.length, 9);
      const list = steps(symbols, order);
      const model = modelOf(order);
      const enc = new Encoder();
      const expected: number[] = [];
      list.forEach(({ sym, row, history }, i) => {
        if (choice[i]) {
          expected.push(model.absorb(enc, sym, row, history));
          return;
        }
        const cost = costOf(enc, () => model.write(enc, sym, row, history));
        expected.push(model.fell ? -1 : cost);
      });
      const reader = modelOf(order);
      const dec = new Decoder(enc.output());
      const out: number[] = [];
      list.forEach(({ sym, row, history }, i) => {
        if (choice[i]) {
          reader.absorb(dec, sym, row, history);
          out.push(sym);
          return;
        }
        out.push(reader.read(dec, row, history));
        expect(reader.readUnits).toBe(expected[i]);
      });
      dec.finalize();
      expect(out).toEqual(symbols);
    }
  );

  it('falls to the prior in the warm-up and hits a context after it', () => {
    const phrase = [0, 1, 2, 0, 3, 1, 0, 4];
    const symbols = Array.from({ length: 200 }, (_, i) => phrase[i % phrase.length]);
    const model = modelOf(0);
    const enc = new Encoder();
    const fell = steps(symbols, 0).map(({ sym, row, history }) => {
      model.write(enc, sym, row, history);
      return model.fell;
    });
    expect(fell.slice(0, WARMUP)).toEqual(new Array<boolean>(WARMUP).fill(true));
    expect(fell.slice(WARMUP)).toEqual(new Array<boolean>(200 - WARMUP).fill(false));
  });

  it('rules out nothing for an except naming the symbol itself', () => {
    const all = steps([...sequence(4, 200), ...sequence(8, 6)], 0);
    const train = (): { model: ContextModel; enc: Encoder } => {
      const model = modelOf(0);
      const enc = new Encoder();
      all.slice(0, 200).forEach(({ sym, row, history }) => model.write(enc, sym, row, history));
      return { model, enc };
    };
    const a = train();
    const b = train();
    all.slice(200).forEach(({ sym, row, history }, i) => {
      const priced = a.model.price(a.enc, sym, row, history);
      expect(b.model.price(b.enc, sym, row, history)).toBe(priced);
      const withExcept = a.model.absorb(a.enc, sym, row, history, i === 0 ? sym : undefined);
      const without = b.model.absorb(b.enc, sym, row, history);
      expect(withExcept).toBe(without);
    });
  });

  it('is warm once the warm-up is coded or learned, and not before', () => {
    const model = modelOf(0);
    const enc = new Encoder();
    expect(model.warm(enc)).toBe(false);
    steps(sequence(2, WARMUP + 5), 0).forEach(({ sym, row, history }, i) => {
      if (i % 2 === 0) {
        model.write(enc, sym, row, history);
      } else {
        model.learn(enc, sym, row, history);
      }
      expect(model.warm(enc)).toBe(i + 1 >= WARMUP);
    });
  });
});
