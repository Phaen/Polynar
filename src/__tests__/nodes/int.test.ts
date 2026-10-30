/**
 * `p.int()`: integers, bounded or not.
 */

import { p } from '../../index';
import { mulberry32, trip } from '../support';
import { STRUCT } from '../../predictor/types';

describe('Schema int', () => {
  it.each([
    [p.int(), 5.5],
    [p.int().min(0).max(100), -3.7],
    [p.int(), NaN],
  ])('rejects %p, which is not an integer, instead of truncating', (node, value) => {
    expect(() => node.encode(value)).toThrow(
      new TypeError(`p.int expected an integer, got ${value}`)
    );
  });

  it.each([
    ['min', () => p.int().min(0.5), 0.5],
    ['max', () => p.int().max(9.2), 9.2],
    ['min', () => p.int().min(-Infinity), -Infinity],
    ['max', () => p.int().max(NaN), NaN],
  ])('rejects a %s bound that is not an integer', (bound, thunk, n) => {
    expect(thunk).toThrow(new TypeError(`p.int ${bound} must be an integer, got ${n}`));
  });

  it.each([
    ['unbounded', p.int()],
    ['min-only', p.int().min(-5)],
    ['max-only', p.int().max(5)],
    ['max of -0', p.int().max(-0)],
    ['bounded', p.int().min(-5).max(5)],
    ['weighted', p.int().min(-1).max(1).weights([1, 2, 3])],
    ['compress', p.int().compress()],
    ['compress and min-only', p.int().min(-5).compress()],
  ])('encodes -0 as plain zero, %s', (_name, node) => {
    expect(node.encode(-0)).toEqual(node.encode(0));
    expect(Object.is(node.decode(node.encode(-0)), 0)).toBe(true);
  });

  it('names the bound a value breaks', () => {
    const node = p.int().min(3).max(9);
    expect(trip(node, 3)).toBe(3);
    expect(trip(node, 9)).toBe(9);
    expect(() => node.encode(2)).toThrow(new RangeError('Value 2 is below the minimum 3'));
    expect(() => node.encode(10)).toThrow(new RangeError('Value 10 is above the maximum 9'));
  });

  it('maps a digit only with both bounds and no prior', () => {
    expect(p.int().min(-5).max(5)._fromDigit?.(10)).toBe(5);
    expect(p.int()._fromDigit).toBeUndefined();
    expect(p.int().min(0)._fromDigit).toBeUndefined();
    expect(p.int().min(0).max(1).weights([1, 2])._fromDigit).toBeUndefined();
  });

  it('maps a value to its digit only with both bounds and no prior, throwing as a write does', () => {
    const node = p.int().min(-5).max(5);
    expect(node._toDigit?.(-5)).toBe(0);
    expect(node._toDigit?.(5)).toBe(10);
    expect(() => node._toDigit?.(1.5)).toThrow(new TypeError('p.int expected an integer, got 1.5'));
    expect(() => node._toDigit?.(6)).toThrow(new RangeError('Value 6 is above the maximum 5'));
    expect(() => node._toDigit?.(-6)).toThrow(new RangeError('Value -6 is below the minimum -5'));
    expect(p.int()._toDigit).toBeUndefined();
    expect(p.int().min(0)._toDigit).toBeUndefined();
    expect(p.int().min(0).max(1).weights([1, 2])._toDigit).toBeUndefined();
  });
});

describe('p.int().compress()', () => {
  const random = (length: number, seed: number, lo: number, hi: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => lo + Math.floor(rnd() * (hi - lo + 1)));
  };
  const constant = Array<number>(200).fill(7);
  const counter = Array.from({ length: 200 }, (_, i) => 1000 + i);

  it.each([
    ['unbounded', p.int().compress(), random(200, 1, -1e9, 1e9)],
    ['bounded', p.int().min(-1000).max(5000).compress(), random(200, 2, -1000, 5000)],
    ['min-only', p.int().min(-50).compress(), random(200, 3, -50, 1e7)],
    ['max-only', p.int().max(5000).compress(), random(200, 4, -1e7, 5000)],
    [
      'weighted',
      p
        .int()
        .min(-3)
        .max(1500)
        .weights(Array.from({ length: 1504 }, (_, i) => 1 + (i % 7)))
        .compress(),
      random(200, 5, -3, 1500),
    ],
    [
      'under a cdf',
      p
        .int()
        .min(-3)
        .max(1500)
        .cdf((v) => (v + 3) * 2)
        .compress(),
      random(200, 6, -3, 1500),
    ],
  ])('round-trips a constant, a counter and random values, %s', (_name, node, values) => {
    for (const run of [constant, counter, values]) {
      expect(trip(p.array(node), run)).toEqual(run);
    }
    expect(trip(node, values[0])).toBe(values[0]);
  });

  it('round-trips a weighted value written alone', () => {
    const node = p.int().min(0).max(2).weights([1, 5, 1]).compress();
    for (const value of [0, 1, 2]) {
      expect(trip(node, value)).toBe(value);
    }
  });

  it('round-trips values past 2^53 on its own spelling', () => {
    const values = [2 ** 60, 2 ** 60 + 2 ** 10, -(2 ** 70), 2 ** 60];
    expect(trip(p.array(p.int().compress()), values)).toEqual(values);
  });

  it('learns what repeats', () => {
    const size = (values: number[]) => p.array(p.int().compress()).encode(values).length;
    expect(size(Array<number>(200).fill(123456))).toBeLessThan(40);
    expect(size(counter)).toBeLessThan(size(random(200, 7, 1000, 1199)));
  });

  it('round-trips inside an object', () => {
    const node = p.array(p.object({ id: p.int().min(0).compress(), delta: p.int().compress() }));
    const values = counter.map((id, i) => ({ id, delta: i % 2 === 0 ? -i - 1 : i * 3 }));
    expect(trip(node, values)).toEqual(values);
  });

  it('round-trips one node reused in two fields', () => {
    const node = p.int().compress();
    const values = [
      { a: 5, b: 5 },
      { a: -7, b: 900 },
    ];
    expect(trip(p.array(p.object({ a: node, b: node })), values)).toEqual(values);
  });

  it('maps no digit with both bounds', () => {
    const node = p.int().min(0).max(9).compress();
    expect(node._radix).toBeUndefined();
    expect(node._fromDigit).toBeUndefined();
    expect(node._toDigit).toBeUndefined();
  });

  it('refuses options out of range, not an object, set twice or beside learn', () => {
    expect(() => p.int().compress({ candidates: 65 })).toThrow(
      new RangeError('p.int: compress candidates must be in 0..64, got 65')
    );
    expect(() => p.int().compress(5 as never)).toThrow(
      new TypeError('p.int: compress options must be an object')
    );
    expect(() => p.int().compress().compress()).toThrow(
      new TypeError('p.int compress is already set')
    );
    const both = new TypeError('p.int learn and compress cannot both be set');
    expect(() => p.int().learn().compress()).toThrow(both);
    expect(() => p.int().compress().learn()).toThrow(both);
  });

  it('refuses a value the plain node refuses, before learning from it', () => {
    const bounded = p.int().min(0).max(9).compress();
    expect(() => bounded.encode(10)).toThrow(new RangeError('Value 10 is above the maximum 9'));
    expect(() => bounded.encode(-1)).toThrow(new RangeError('Value -1 is below the minimum 0'));
    expect(() => p.int().compress().encode(1.5)).toThrow(
      new TypeError('p.int expected an integer, got 1.5')
    );
    expect(() =>
      p
        .int()
        .min(0)
        .max(4)
        .cdf((v) => Math.min(v, 2) + Math.max(v - 3, 0))
        .compress()
        .encode(2)
    ).toThrow(new RangeError('Value 2 has zero weight under the declared cdf'));
    expect(() =>
      p
        .int()
        .min(-(2 ** 60))
        .compress()
        .encode(1)
    ).toThrow(new RangeError(`Value 1 is too far from its bound ${-(2 ** 60)} to encode exactly`));
    expect(() =>
      p
        .int()
        .max(2 ** 60)
        .compress()
        .encode(-1)
    ).toThrow(new RangeError(`Value -1 is too far from its bound ${2 ** 60} to encode exactly`));
  });
});

describe('p.int learn', () => {
  const plain = p.int().min(0).max(15);
  const weights = Array.from({ length: 16 }, (_, i) => (i === 3 ? 61 : 1));
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => (rnd() < 0.8 ? 3 : Math.floor(rnd() * 16)));
  };

  it('round-trips a run of values, inside an array too', () => {
    const values = run(300, 1);
    for (const node of [plain.learn(), plain.weights(weights).learn({ window: 16 })]) {
      expect(node._radix).toBeUndefined();
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(node, values[0])).toEqual(values[0]);
    }
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).learn({ window: 64 })).encode(values)).toEqual(
      p.array(plain.learn({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('keeps learning through a bound set after it', () => {
    const values = run(200, 3);
    expect(p.array(p.int().learn().min(0).max(15)).encode(values)).toEqual(
      p.array(plain.learn()).encode(values)
    );
  });

  it('learns a skew, staying near the static prior of it', () => {
    const values = run(2000, 4);
    const size = (node: typeof plain) => p.array(node).encode(values).length;
    expect(size(plain.learn())).toBeLessThan(size(plain));
    expect(size(plain.weights(weights).learn())).toBeLessThanOrEqual(
      Math.ceil(size(plain.weights(weights)) * 1.05)
    );
  });

  it('takes its learning options, once', () => {
    const values = run(200, 5);
    expect(p.array(plain.learn({ window: 8 })).encode(values)).not.toEqual(
      p.array(plain.learn()).encode(values)
    );
    expect(() => plain.learn().learn()).toThrow(new TypeError('p.int learn is already set'));
    expect(() => plain.learn({ window: 8 }).learn({ window: 8 })).toThrow(
      new TypeError('p.int learn is already set')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.learn({ window: 0 })).toThrow(
      new RangeError('p.int learning window must be a positive integer, got 0')
    );
    expect(() => plain.learn({ window: 1.5 })).toThrow(
      new TypeError('p.int learning window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(15).fill(1)]).learn()).toThrow(
      new RangeError(
        'p.int adaptive prior 32 and window 1024 overflow with weights totalling 35184372088847'
      )
    );
    const cdf = new TypeError('p.int learn takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).learn()).toThrow(cdf);
    expect(() => plain.learn().cdf((v) => v)).toThrow(cdf);
  });

  it('learns ids on any range', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
    for (const node of [p.int(), p.int().min(1), p.int().min(1).max(65535), p.int().max(2000)]) {
      expect(trip(p.array(node.learn()), ids)).toEqual(ids);
    }
  });

  it('spells unbounded values on the learned magnitude scale', () => {
    const values = [0, -3, 2 ** 40, -(2 ** 52), 17, -(2 ** 52)];
    expect(trip(p.array(p.int().learn()), values)).toEqual(values);
    const wide = p
      .int()
      .min(-(2 ** 60))
      .max(-(2 ** 60) + 2 ** 30)
      .learn();
    expect(trip(p.array(wide), [-(2 ** 60)])).toEqual([-(2 ** 60)]);
    expect(trip(p.array(p.int().max(5).learn()), [5, -9, 5])).toEqual([5, -9, 5]);
    expect(() =>
      p
        .int()
        .learn()
        .encode(2 ** 53)
    ).toThrow(new RangeError(`Value ${2 ** 53} is too far from 0 to encode exactly`));
  });

  it('refuses a value outside the bounds before learning from it', () => {
    expect(() => p.array(plain.learn()).encode([1, 16])).toThrow(
      new RangeError('[1]: Value 16 is above the maximum 15')
    );
  });
});

describe('p.int methods', () => {
  it('refuses learn beside compress, either order', () => {
    const both = new TypeError('p.int learn and compress cannot both be set');
    expect(() => p.int().compress().learn()).toThrow(both);
    expect(() => p.int().learn().compress()).toThrow(both);
  });

  it('keeps a learner or a compressed node as it is under a container sugar', () => {
    const learner = p.int().min(0).max(9).learn();
    const compress = p.int().compress({ window: 8 });
    expect(learner._adapted({})).toBe(learner);
    expect(compress._adapted({ window: 16 })).toBe(compress);
    const plain = p.int().min(0).max(9);
    const adapted = plain._adapted({ window: 16 });
    expect(adapted).not.toBe(plain);
    expect(adapted._compress).toEqual({ window: 16 });
    expect(adapted._methods).toEqual({});
  });

  it('names the integer marker, its only one', () => {
    expect(p.int()._marker()).toBe(STRUCT.INT);
    expect(p.int()._markers()).toEqual(new Set([STRUCT.INT]));
  });
});
