/**
 * `p.map()`, `p.record()` and `p.set()`: one collection node with a count
 * like an array's, read back into a Map, a plain object or a Set.
 */

import { p, Encoder } from '../../index';
import { mulberry32, trip } from '../support';

/** A wire of `count`, then each of `keys` written by `write`. */
const wire = (count: number, keys: unknown[], write: (enc: Encoder, key: any) => void) => {
  const enc = new Encoder();
  enc.composeTerm(count);
  keys.forEach((key) => write(enc, key));
  return enc.output();
};

describe('Schema map', () => {
  it('round-trips keys of any node in insertion order', () => {
    const node = p.map(p.array(p.int()), p.string());
    // Two keys with equal contents are still two keys of a Map.
    const value = new Map([
      [[2], 'b'],
      [[1], 'a'],
      [[2], 'c'],
    ]);
    const back = trip(node, value);
    expect(back).toBeInstanceOf(Map);
    expect([...back]).toEqual([...value]);
    expect(trip(node, new Map())).toEqual(new Map());
  });

  it('bounds and weighs the count like an array', () => {
    const node = p.map(p.string(), p.bool()).min(1).max(2);
    expect(() => node.encode(new Map())).toThrow(
      new RangeError('Map size 0 is below the minimum 1')
    );
    expect(() =>
      node.encode(
        new Map([
          ['a', true],
          ['b', true],
          ['c', true],
        ])
      )
    ).toThrow('Map size 3 is above the maximum 2');
    // Two booleans and a fixed count of two: two bits, one byte.
    const pair = new Map<'' | ' ', boolean>([
      ['', true],
      [' ', false],
    ]);
    expect(
      p
        .map(p.enum(['', ' ']), p.bool())
        .length(2)
        .encode(pair)
    ).toHaveLength(1);
    expect(trip(node.weights([1, 9]), pair)).toEqual(pair);
    expect(
      trip(
        p
          .map(p.string(), p.bool())
          .max(3)
          .cdf((n) => n * n),
        pair
      )
    ).toEqual(pair);
  });

  it('sets each bound once', () => {
    const node = p.map(p.string(), p.int());
    expect(() => node.min(1).min(2)).toThrow(new TypeError('p.map min is already set'));
    expect(() => node.max(1).max(2)).toThrow('p.map max is already set');
    expect(() => node.min(1).length(2)).toThrow('p.map min is already set');
    expect(() => node.max(1).length(2)).toThrow('p.map max is already set');
    expect(() => node.weights([1, 2])).toThrow('p.map weights requires a max count');
  });

  it('names an entry by its string key, or else by its position', () => {
    const digit = p.int().min(0).max(9);
    expect(() =>
      p.map(p.string(), digit).encode(
        new Map([
          ['a', 1],
          ['b', 10],
        ])
      )
    ).toThrow(new RangeError('b: Value 10 is above the maximum 9'));
    expect(() =>
      p.map(digit, digit).encode(
        new Map([
          [1, 1],
          [10, 1],
        ])
      )
    ).toThrow('[1]: Value 10 is above the maximum 9');
  });

  it('reads a repeated key as one entry holding the last value', () => {
    const int = p.int();
    const node = p.map(int, int);
    let value = 0;
    const back = node.decode(
      wire(2, [1, 1], (enc, k) => {
        int._write(enc, k);
        int._write(enc, ++value);
      })
    );
    expect([...back]).toEqual([[1, 2]]);
  });

  it('reads a -0 key as the 0 a Map holds', () => {
    const float = p.float();
    const node = p.map(float, p.null());
    const back = node.decode(wire(1, [-0], (enc, k) => float._write(enc, k)));
    expect([...back.keys()]).toEqual([0]);
  });
});

describe('Schema record', () => {
  it('writes a plain object like a map with string keys', () => {
    const value = { b: 1, a: 2, 7: 3 };
    const record = p.record(p.int());
    expect(record.encode(value)).toEqual(
      p.map(p.string(), p.int()).encode(new Map(Object.entries(value)))
    );
    expect(trip(record, value)).toEqual(value);
    expect(Object.getPrototypeOf(trip(record, value))).toBe(Object.prototype);
  });

  it('decodes a __proto__ key as an own property', () => {
    const value = JSON.parse('{"__proto__": 1, "a": 2}') as Record<string, number>;
    const back = trip(p.record(p.int()), value);
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(Object.keys(back)).toEqual(['__proto__', 'a']);
  });

  it('keeps keys whose optional value is undefined', () => {
    const back = trip(p.record(p.optional(p.int())), { a: undefined, b: 1 });
    expect(back).toHaveProperty('a', undefined);
  });

  it('names an entry by its key', () => {
    expect(() => p.record(p.int().max(9)).encode({ a: 1, b: 10 })).toThrow(
      'b: Value 10 is above the maximum 9'
    );
    expect(() => p.record(p.int()).max(1).encode({ a: 1, b: 2 })).toThrow(
      'Record size 2 is above the maximum 1'
    );
  });

  it('reads integer-like keys in any order as the object that lists them', () => {
    const string = p.string();
    const node = p.record(p.null());
    const write = (enc: Encoder, key: string) => string._write(enc, key);
    expect(node.decode(wire(2, ['1', 'a'], write))).toEqual({ 1: null, a: null });
    expect(Object.keys(node.decode(wire(2, ['a', '1'], write)))).toEqual(['1', 'a']);
  });

  it('has the object kind, beside other kinds in a union', () => {
    const node = p.union([p.record(p.int()), p.string()]);
    expect(trip(node, { a: 1 })).toEqual({ a: 1 });
    expect(trip(node, 'a')).toBe('a');
    expect(() => p.union([p.record(p.int()), p.object({})])).toThrow('overlap on kind "object"');
  });
});

describe('Schema set', () => {
  it('round-trips items in insertion order', () => {
    const value = new Set(['b', 'a', 'c']);
    const back = trip(p.set(p.string()), value);
    expect(back).toBeInstanceOf(Set);
    expect([...back]).toEqual(['b', 'a', 'c']);
    // Distinct arrays with equal contents are distinct items.
    expect(trip(p.set(p.array(p.int())), new Set([[1], [1]])).size).toBe(2);
  });

  it('names an item by its position, even a string one', () => {
    expect(() => p.set(p.string().max(1)).encode(new Set(['a', 'bc']))).toThrow(
      '[1]: String length 2 is above the maximum 1'
    );
    expect(() => p.set(p.int()).length(1).encode(new Set())).toThrow(
      'Set size 0 is below the minimum 1'
    );
  });

  it('reads a repeated item once', () => {
    const string = p.string();
    const back = p.set(string).decode(wire(2, ['a', 'a'], (enc, k) => string._write(enc, k)));
    expect([...back]).toEqual(['a']);
  });
});

describe('p.set adaptive', () => {
  const plain = p.set(p.int().min(0).max(9)).max(7);
  const weights = Array.from({ length: 8 }, (_, i) => (i === 3 ? 29 : 1));
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from(
      { length },
      () => new Set(Array.from({ length: rnd() < 0.8 ? 3 : Math.floor(rnd() * 8) }, (_, i) => i))
    );
  };

  it('round-trips a run of values, inside an array too', () => {
    const values = run(300, 1);
    for (const node of [plain.adaptive(), plain.weights(weights).adaptive({ window: 8 })]) {
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
      new RangeError('p.set adaptive window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.set adaptive window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(7).fill(1)]).adaptive()).toThrow(
      new RangeError(
        'p.set adaptive prior 16 and window 1024 overflow with weights totalling 35184372088839'
      )
    );
    expect(() => p.set(p.int()).adaptive()).toThrow(
      new TypeError('p.set adaptive requires a max count')
    );
    const cdf = new TypeError('p.set adaptive takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).adaptive()).toThrow(cdf);
    expect(() => plain.adaptive().cdf((v) => v)).toThrow(cdf);
  });
});
