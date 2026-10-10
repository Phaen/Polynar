/**
 * `p.map()`, `p.record()` and `p.set()`: one collection node with a count
 * like an array's, read back into a Map, a plain object or a Set.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import { trip } from '../support';

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

  it('rejects a repeated key, even one that takes no bits', () => {
    const int = p.int();
    const node = p.map(int, p.null());
    expect(() => node.decode(wire(2, [1, 1], (enc, k) => int._write(enc, k)))).toThrow(
      new CorruptInputError('Repeated key 1 in p.map')
    );
    // A count no input could hold stops at its second entry.
    expect(() => p.map(p.null(), p.null()).decode(wire(2 ** 40, [], () => {}))).toThrow(
      'Repeated key null in p.map'
    );
  });

  it('rejects a -0 key, which a Map holds as 0', () => {
    const float = p.float();
    const node = p.map(float, p.null());
    expect(() => node.decode(wire(1, [-0], (enc, k) => float._write(enc, k)))).toThrow(
      new CorruptInputError('Key -0 in p.map, where a Map or Set holds it as 0')
    );
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

  it('rejects integer-like keys out of the order an object lists them in', () => {
    const string = p.string();
    const node = p.record(p.null());
    const write = (enc: Encoder, key: string) => string._write(enc, key);
    expect(node.decode(wire(2, ['1', 'a'], write))).toEqual({ 1: null, a: null });
    expect(() => node.decode(wire(2, ['a', '1'], write))).toThrow(
      new CorruptInputError('Record keys are out of the order an object lists them in')
    );
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

  it('rejects a repeated item', () => {
    const string = p.string();
    expect(() =>
      p.set(string).decode(wire(2, ['a', 'a'], (enc, k) => string._write(enc, k)))
    ).toThrow(new CorruptInputError('Repeated key "a" in p.set'));
  });
});
