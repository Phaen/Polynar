/**
 * `p.bool()`: true or false.
 */

import { p } from '../../index';
import { STRUCT } from '../../predictor/types';
import { mulberry32, trip } from '../support';

describe('Schema bool', () => {
  it('lists weights true first', () => {
    const likelyTrue = p.array(p.bool().weights([99, 1])).length(64);
    const trues = Array<boolean>(64).fill(true);
    const falses = Array<boolean>(64).fill(false);
    expect(likelyTrue.encode(trues).length).toBeLessThan(likelyTrue.encode(falses).length);
    expect(trip(likelyTrue, falses)).toEqual(falses);
  });

  it('spells true and false as their own structure symbols', () => {
    const node = p.bool();
    expect([node._marker(true), node._marker(false)]).toEqual([STRUCT.TRUE, STRUCT.FALSE]);
    expect(node._markers()).toEqual(new Set([STRUCT.TRUE, STRUCT.FALSE]));
    expect(node._markerPrior()).toBeUndefined();
  });
});

describe('p.bool digits', () => {
  it('map true to 0 and false to 1, and back', () => {
    const node = p.bool();
    expect([node._toDigit(true), node._toDigit(false)]).toEqual([0, 1]);
    expect([node._fromDigit(0), node._fromDigit(1)]).toEqual([true, false]);
  });
});

describe('p.bool learn', () => {
  const plain = p.bool();
  const values = (() => {
    const rnd = mulberry32(5);
    return Array.from({ length: 300 }, () => rnd() < 0.9);
  })();

  it('round-trips a run, learning the skew under its options', () => {
    for (const node of [plain.learn(), plain.learn({ window: 8 }), plain.weights([9, 1]).learn()]) {
      expect(trip(p.array(node), values)).toEqual(values);
    }
    expect(p.array(plain.learn()).encode(values)).not.toEqual(p.array(plain).encode(values));
  });

  it('sets each method once, and not both', () => {
    expect(() => plain.learn().learn()).toThrow(new TypeError('p.bool learn is already set'));
    expect(() => plain.learn().adaptive()).toThrow(
      new TypeError('p.bool learn and adaptive cannot both be set')
    );
    expect(() => plain.adaptive().learn()).toThrow(
      new TypeError('p.bool learn and adaptive cannot both be set')
    );
    expect(() => plain.adaptive().adaptive()).toThrow(
      new TypeError('p.bool adaptive is already set')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.learn({ window: 0 })).toThrow(
      new RangeError('p.bool learning window must be a positive integer, got 0')
    );
    expect(() => plain.weights([2 ** 45, 2 ** 45]).learn()).toThrow(RangeError);
  });
});

describe('p.bool adaptive', () => {
  const plain = p.bool();
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => rnd() < 0.8);
  };

  it('round-trips a run alone, in a plain array and in an adaptive object', () => {
    const values = run(300, 1);
    for (const node of [plain.adaptive(), plain.weights([9, 1]).adaptive({ window: 8 })]) {
      expect(node._radix).toBeUndefined();
      for (const value of values.slice(0, 20)) expect(trip(node, value)).toBe(value);
      expect(trip(p.array(node), values)).toEqual(values);
    }
    const Row = p.object({ a: plain, b: plain.weights([1, 3]) }).adaptive();
    const rows = values.map((a, i) => ({ a, b: values[(i * 7) % values.length] }));
    expect(trip(p.array(Row), rows)).toEqual(rows);
    expect(trip(p.array(plain).adaptive(), values)).toEqual(values);
  });

  it('takes its weights as prior counts of its symbols, coded by itself or its parent', () => {
    const trues = Array<boolean>(12).fill(true);
    const falses = Array<boolean>(12).fill(false);
    const node = plain.weights([30, 1]).adaptive();
    expect(node._markerPrior()?.counts).toEqual([
      [STRUCT.TRUE, 30],
      [STRUCT.FALSE, 1],
    ]);
    for (const list of [
      p.array(node).length(12),
      p
        .array(plain.weights([30, 1]))
        .length(12)
        .adaptive(),
    ]) {
      expect(list.encode(trues).length).toBeLessThan(list.encode(falses).length);
    }
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights([9, 1]).adaptive({ window: 64 })).encode(values)).toEqual(
      p.array(plain.adaptive({ window: 64 }).weights([9, 1])).encode(values)
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.adaptive({ window: 0 })).toThrow(
      new RangeError('p.bool: adaptive window must be at least 1')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.bool: adaptive window must be an integer, got 1.5')
    );
  });
});
