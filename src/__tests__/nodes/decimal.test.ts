/**
 * `p.decimal()`: values on a fixed decimal step.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import { mulberry32, trip } from '../support';
import { decimalPlaces } from '../../nodes/decimal';

describe('Schema decimal', () => {
  it.each([0, 0.07, 0.29, 3.14, 99.99, 100])(
    'round-trips %p in cents bit-exact, float traps included',
    (value) => {
      // 0.29 / 0.01 = 28.999... under raw float division; the scaled-integer
      // path returns the value itself, not a close neighbour.
      expect(trip(p.decimal(0.01).min(0).max(100), value)).toBe(value);
    }
  );

  it.each([
    ['unbounded', p.decimal(0.5)],
    ['min-only', p.decimal(0.5).min(-1)],
    ['max-only', p.decimal(0.5).max(1)],
    ['max of -0', p.decimal(0.5).max(-0)],
    ['bounded', p.decimal(0.5).min(-1).max(1)],
    ['weighted', p.decimal(0.5).min(-0.5).max(0.5).weights([1, 2, 3])],
  ])('encodes -0 as plain zero, %s', (_name, node) => {
    expect(node.encode(-0)).toEqual(node.encode(0));
    expect(Object.is(node.decode(node.encode(-0)), 0)).toBe(true);
  });

  it('spends only what the step and bounds allow', () => {
    // 0..100 in cents is 10001 states: 2 bytes, where p.float's per-value
    // fraction search, blind to the bounds, spends 4 on 3.14.
    expect(p.decimal(0.01).min(0).max(100).encode(3.14)).toHaveLength(2);
  });

  it('rejects off-grid values instead of snapping', () => {
    expect(() => p.decimal(0.01).encode(0.005)).toThrow('not a multiple of step');
    expect(() => p.decimal(0.01).encode(0.123)).toThrow('not a multiple of step');
    expect(() => p.decimal(0.1).encode(0.35)).toThrow('not a multiple of step');
  });

  it('names the bound a value breaks', () => {
    expect(() => p.decimal(0.01).min(0).max(100).encode(100.01)).toThrow(
      new RangeError('Value 100.01 is above the maximum 100')
    );
    const node = p.decimal(0.5).min(0.5).max(2);
    expect(trip(node, 0.5)).toBe(0.5);
    expect(trip(node, 2)).toBe(2);
    expect(() => node.encode(0)).toThrow(new RangeError('Value 0 is below the minimum 0.5'));
    expect(() => node.encode(2.5)).toThrow(new RangeError('Value 2.5 is above the maximum 2'));
  });

  it('puts bounds on the step like values', () => {
    expect(() => p.decimal(0.5).min(0.3)).toThrow(
      new RangeError('p.decimal min 0.3 is not a multiple of step 0.5')
    );
    expect(() => p.decimal(0.5).max(2.2)).toThrow(
      new RangeError('p.decimal max 2.2 is not a multiple of step 0.5')
    );
    // A bound finer than the step is off it too.
    expect(() => p.decimal(1).min(1e-7)).toThrow(
      new RangeError('p.decimal min 1e-7 is not a multiple of step 1')
    );
    expect(() => p.decimal(0.1).max(1 / 3)).toThrow(RangeError);
    expect(() => p.decimal(0.1).min(NaN)).toThrow(
      new TypeError('p.decimal min must be a finite number, got NaN')
    );
    expect(() => p.decimal(0.1).max(Infinity)).toThrow(
      new TypeError('p.decimal max must be a finite number, got Infinity')
    );
    expect(trip(p.decimal(0.1).min(-0.3).max(0.3), -0.3)).toBe(-0.3);
  });

  it('rejects invalid steps at construction', () => {
    expect(() => p.decimal(0)).toThrow(
      new TypeError('p.decimal step must be a positive finite number, got 0')
    );
    expect(() => p.decimal(-0.1)).toThrow(TypeError);
    expect(() => p.decimal(Infinity)).toThrow(TypeError);
    // 1/3 has no finite decimal form, so no value could ever sit on its grid.
    expect(() => p.decimal(1 / 3)).toThrow(TypeError);
  });

  it('keeps a fractional step within 2^53 of its last decimal place', () => {
    // The limit sits on the scaled value, so 0.25 reaches no further than 0.01.
    expect(() => p.decimal(0.01).max(1e20)).toThrow(
      'p.decimal max 100000000000000000000 is outside the exact range ±90071992547409.9 of step 0.01'
    );
    expect(() => p.decimal(0.25).min(-1e20)).toThrow(
      'p.decimal min -100000000000000000000 is outside the exact range ±90071992547409.9 of step 0.25'
    );
    expect(() => p.decimal(0.1).encode(1e15)).toThrow(
      'Value 1000000000000000 is outside the exact range ±900719925474099.1 of step 0.1'
    );
    expect(trip(p.decimal(0.1), 900719925474099)).toBe(900719925474099);
    expect(() => p.decimal(1).encode(NaN)).toThrow('p.decimal expected a finite number');
  });

  it.each([
    [1, 1e20],
    [1000, 1e16],
    [1000, -(1000 * 2 ** 60)],
    [1e21, 3e21],
    [1e21, 0],
    [3, 3 * 2 ** 60],
  ])('reaches as far as p.int on the integer step %p: %p', (step, value) => {
    expect(trip(p.decimal(step), value)).toBe(value);
  });

  it('still refuses what is off the grid of an integer step past 2^53', () => {
    expect(() => p.decimal(1000).encode(1e16 + 2)).toThrow(
      'Value 10000000000000002 is not a multiple of step 1000'
    );
    expect(() => p.decimal(3).encode(2 ** 60)).toThrow('not a multiple of step 3');
    expect(() => p.decimal(1e21).encode(1e21 + 2 ** 20)).toThrow('not a multiple of step 1e+21');
  });

  it('bounds an integer step past 2^53 by its multiples', () => {
    const node = p
      .decimal(1000)
      .min(1e18)
      .max(1e18 + 1024000);
    expect(trip(node, 1e18 + 512000)).toBe(1e18 + 512000);
    expect(node.encode(1e18)).toHaveLength(2);
    expect(() => node.encode(1e18 - 128000)).toThrow(
      'Value 999999999999872000 is below the minimum 1000000000000000000'
    );
    expect(() =>
      p
        .decimal(1000)
        .min(-1e18)
        .encode(-1e18 - 128000)
    ).toThrow('below the minimum');
  });

  it('rejects a step multiple that cannot reconstruct exactly', () => {
    // The multiple is a valid term, but scaled by the step it rounds past
    // 2^53, so dividing it back out would decode a neighbouring value.
    const enc = new Encoder();
    enc.compose(0, 2);
    enc.composeTerm(2 ** 60);
    expect(() => p.decimal(0.01).decode(enc.output())).toThrow(CorruptInputError);
    // An integer step has no limit, but this multiple's product with the step
    // is odd past 2^53, so it rounds.
    const odd = new Encoder();
    odd.compose(0, 2);
    odd.composeTerm(2 ** 52 + 1);
    expect(() => p.decimal(3).decode(odd.output())).toThrow(CorruptInputError);
  });

  it('rejects a bounded multiple whose product rounds between exact bounds', () => {
    // Both bounds are doubles, and the one multiple between them is not.
    const node = p
      .decimal(3)
      .min(3 * 2 ** 52)
      .max(3 * 2 ** 52 + 6);
    expect(trip(node, 3 * 2 ** 52 + 6)).toBe(3 * 2 ** 52 + 6);
    const enc = new Encoder();
    enc.compose(1, 3);
    expect(() => node.decode(enc.output())).toThrow(CorruptInputError);
    expect(() => node._fromDigit?.(1)).toThrow(CorruptInputError);
  });
});

describe('decimalPlaces', () => {
  it.each([
    [0, 0],
    [-0, 0],
    [7, 0],
    [1e300, 0],
    [0.1, 1],
    [-0.5, 1],
    [0.25, 2],
    [1e-15, 15],
    [1.000000000000001, 15],
    [Math.PI, 15],
  ])('gives %p %p places', (x, places) => {
    expect(decimalPlaces(x)).toBe(places);
  });

  it.each([1e-16, 1 / 3, Infinity, -Infinity, NaN])('has no exact decimal form for %p', (x) => {
    expect(decimalPlaces(x)).toBeNull();
  });
});

describe('Digit reads', () => {
  it('map a digit only with both bounds and no prior', () => {
    const bounded = p.decimal(0.5).min(-1).max(1);
    expect(bounded._fromDigit?.(3)).toBe(0.5);
    expect(p.decimal(0.5)._fromDigit).toBeUndefined();
    expect(p.decimal(0.5).max(1)._fromDigit).toBeUndefined();
    expect(bounded.weights([1, 1, 1, 1, 1])._fromDigit).toBeUndefined();
  });
});

describe('p.decimal adaptive', () => {
  const plain = p.decimal(0.5).min(0).max(7.5);
  const weights = Array.from({ length: 16 }, (_, i) => (i === 3 ? 61 : 1));
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => (rnd() < 0.8 ? 1.5 : Math.floor(rnd() * 16) / 2));
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
      new RangeError('p.decimal adaptive window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.decimal adaptive window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(15).fill(1)]).adaptive()).toThrow(
      new RangeError(
        'p.decimal adaptive prior 32 and window 1024 overflow with weights totalling 35184372088847'
      )
    );
    expect(() => p.decimal(0.5).max(7.5).adaptive()).toThrow(
      new TypeError('p.decimal adaptive requires both bounds')
    );
    const cdf = new TypeError('p.decimal adaptive takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).adaptive()).toThrow(cdf);
    expect(() => plain.adaptive().cdf((v) => v)).toThrow(cdf);
  });
});
