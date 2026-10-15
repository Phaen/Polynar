/**
 * `p.int()`: integers, bounded or not.
 */

import { p } from '../../index';
import { mulberry32, trip } from '../support';

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

describe('p.int adaptive', () => {
  const plain = p.int().min(0).max(15);
  const weights = Array.from({ length: 16 }, (_, i) => (i === 3 ? 61 : 1));
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => (rnd() < 0.8 ? 3 : Math.floor(rnd() * 16)));
  };

  it('round-trips a run of values, inside an array too', () => {
    const values = run(300, 1);
    for (const node of [plain.adaptive(), plain.weights(weights).adaptive({ window: 16 })]) {
      expect(node._radix).toBeUndefined();
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(node, values[0])).toEqual(values[0]);
    }
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).adaptive({ window: 64 })).encode(values)).toEqual(
      p.array(plain.adaptive({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('learns a skew, at most a byte over the static prior of it', () => {
    const values = run(2000, 3);
    const size = (node: typeof plain) => p.array(node).encode(values).length;
    expect(size(plain.adaptive())).toBeLessThan(size(plain));
    expect(size(plain.weights(weights).adaptive())).toBeLessThanOrEqual(
      size(plain.weights(weights)) + 1
    );
  });

  it('written once, spends the bytes of its static form', () => {
    for (const value of run(20, 4)) {
      expect(plain.adaptive().encode(value)).toEqual(plain.encode(value));
      expect(plain.weights(weights).adaptive().encode(value)).toEqual(
        plain.weights(weights).encode(value)
      );
    }
  });

  it('refuses bad options', () => {
    expect(() => plain.adaptive({ window: 0 })).toThrow(
      new RangeError('p.int adaptive window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.int adaptive window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(15).fill(1)]).adaptive()).toThrow(
      new RangeError(
        'p.int adaptive prior 32 and window 1024 overflow with weights totalling 35184372088847'
      )
    );
    expect(() => p.int().min(0).adaptive()).toThrow(
      new TypeError('p.int adaptive requires both bounds')
    );
    const cdf = new TypeError('p.int adaptive takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).adaptive()).toThrow(cdf);
    expect(() => plain.adaptive().cdf((v) => v)).toThrow(cdf);
  });
});
