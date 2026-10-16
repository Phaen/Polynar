/**
 * `p.bool()`: true or false.
 */

import { p } from '../../index';
import { mulberry32, trip } from '../support';

describe('Schema bool', () => {
  it('lists weights true first', () => {
    const likelyTrue = p.array(p.bool().weights([99, 1])).length(64);
    const trues = Array<boolean>(64).fill(true);
    const falses = Array<boolean>(64).fill(false);
    expect(likelyTrue.encode(trues).length).toBeLessThan(likelyTrue.encode(falses).length);
  });
});

describe('p.bool digits', () => {
  it('map true to 0 and false to 1, and back', () => {
    const node = p.bool();
    expect([node._toDigit(true), node._toDigit(false)]).toEqual([0, 1]);
    expect([node._fromDigit(0), node._fromDigit(1)]).toEqual([true, false]);
  });
});

describe('p.bool adaptive', () => {
  const plain = p.bool();
  const weights = [9, 1];
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => rnd() < 0.9);
  };

  it('round-trips a run of values, inside an array too', () => {
    const values = run(300, 1);
    for (const node of [plain.adaptive(), plain.weights(weights).adaptive({ window: 8 })]) {
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

  it('learns by `.learn()`, spending what `.adaptive()` does', () => {
    const values = run(300, 5);
    const size = (node: typeof plain) => p.array(node).encode(values);
    expect(size(plain.learn())).toEqual(size(plain.adaptive()));
    expect(size(plain.weights(weights).learn())).toEqual(size(plain.weights(weights).adaptive()));
    expect(size(plain.learn().weights(weights))).toEqual(size(plain.weights(weights).adaptive()));
    expect(size(plain.learning({ window: 8 }).learn())).toEqual(
      size(plain.adaptive({ window: 8 }))
    );
    expect(size(plain.learn())).not.toEqual(size(plain));
  });

  it('sets its learning once and each method once', () => {
    expect(() => plain.learning({}).learning({})).toThrow(
      new TypeError('p.bool learning is already set')
    );
    expect(() => plain.learn().learn()).toThrow(new TypeError('p.bool learn is already set'));
    expect(() => plain.learning({ window: 8 }).adaptive({ window: 8 })).toThrow(
      new TypeError('p.bool learning is already set')
    );
    expect(() => plain.adaptive({ window: 8 }).learning({ window: 8 })).toThrow(
      new TypeError('p.bool learning is already set')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.adaptive({ window: 0 })).toThrow(
      new RangeError('p.bool learning window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.bool learning window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, 2 ** 45]).adaptive()).toThrow(
      new RangeError(
        'p.bool adaptive prior 4 and window 1024 overflow with weights totalling 70368744177664'
      )
    );
    expect(() => plain.adaptive().weights([1])).toThrow(
      new TypeError('p.bool weights must list one weight per value: expected 2, got 1')
    );
  });
});
