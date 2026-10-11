/**
 * `p.any()`: self-describing values of no declared type.
 */

import { p, Encoder, CorruptInputError, type AnyValue, type PNode } from '../../index';
import { MAX_DEPTH } from '../../nodes/any';
import { trip } from '../support';

describe('Schema any', () => {
  it('copies shared references', () => {
    const shared = { n: 1 };
    expect(trip(p.any(), { a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } });
  });

  const wrappers: [string, (inner: AnyValue) => AnyValue, PNode<any>, number][] = [
    ['array', (inner) => [inner], p.array(p.any()), 7],
    ['record', (inner) => ({ k: inner }), p.record(p.any()), 8],
    ['map', (inner) => new Map([['k', inner]]), p.map(p.any(), p.any()), 9],
    ['set', (inner) => new Set([inner]), p.set(p.any()), 10],
  ];
  const nest = (wrap: (inner: AnyValue) => AnyValue, levels: number, leaf: AnyValue = 0) => {
    let value: AnyValue = leaf;
    for (let i = 0; i < levels; i++) value = wrap(value);
    return value;
  };

  it.each(wrappers)('round-trips %s nesting exactly MAX_DEPTH levels deep', (_kind, wrap) => {
    const value = nest(wrap, MAX_DEPTH);
    expect(trip(p.any(), value)).toEqual(value);
  });

  it.each(wrappers)('refuses to encode %s nesting deeper than MAX_DEPTH', (_kind, wrap) => {
    expect(() => p.any().encode(nest(wrap, MAX_DEPTH + 1))).toThrow(
      new RangeError(`p.any nests deeper than ${MAX_DEPTH} levels`)
    );
  });

  it('leaves the path out of the depth error, even below a field', () => {
    const node = p.object({ data: p.any() });
    expect(() => node.encode({ data: nest((inner) => [inner], MAX_DEPTH + 1) })).toThrow(
      new RangeError(`p.any nests deeper than ${MAX_DEPTH} levels`)
    );
  });

  it('refuses a value that contains itself, which is infinitely deep', () => {
    const message = new RangeError(`p.any nests deeper than ${MAX_DEPTH} levels`);
    const loop: { [key: string]: AnyValue } = {};
    loop.self = loop;
    expect(() => p.any().encode(loop)).toThrow(message);
    const ring: AnyValue[] = [];
    ring.push(ring);
    expect(() => p.any().encode(ring)).toThrow(message);
    const map = new Map<AnyValue, AnyValue>();
    map.set('self', [map]);
    expect(() => p.any().encode(map)).toThrow(message);
    const set = new Set<AnyValue>();
    set.add({ set });
    expect(() => p.any().encode(set)).toThrow(message);
  });

  it.each(wrappers)(
    'rejects input with %s nesting deeper than MAX_DEPTH',
    (_kind, wrap, container, tag) => {
      // A container's tag, then that container around MAX_DEPTH more levels:
      // one level past what the encoder writes.
      const enc = new Encoder();
      enc.compose(tag, 22);
      container._write(enc, nest(wrap, MAX_DEPTH + 1));
      expect(() => p.any().decode(enc.output())).toThrow(
        new CorruptInputError(`p.any input nests deeper than ${MAX_DEPTH} levels`)
      );
    }
  );

  it('unwinds its depth after a write or read that threw, so the node works again', () => {
    const node = p.any();
    const wrap = (inner: AnyValue) => [inner];
    expect(() => node.encode(nest(wrap, MAX_DEPTH, Infinity))).toThrow('finite');
    const enc = new Encoder();
    enc.compose(7, 22);
    p.array(p.any())._write(enc, [nest(wrap, MAX_DEPTH)]);
    expect(() => node.decode(enc.output())).toThrow(CorruptInputError);
    const value = nest(wrap, MAX_DEPTH);
    expect(trip(node, value)).toEqual(value);
  });

  it('round-trips Maps and Sets of any values, keys included', () => {
    const value = new Map<AnyValue, AnyValue>([
      ['a', 1],
      [2, new Set<AnyValue>([null, 'x', [1]])],
      [[0], new Map()],
      [undefined, -0],
    ]);
    const back = trip(p.any(), value);
    expect(back).toBeInstanceOf(Map);
    expect(back).toEqual(value);
    expect([...(back as Map<AnyValue, AnyValue>).keys()]).toEqual(['a', 2, [0], undefined]);
  });

  it.each([
    new Int8Array([-1, 2]),
    new Uint8Array([1, 255]),
    new Uint8ClampedArray([0, 255]),
    new Int16Array([-300, 2]),
    new Uint16Array([65535]),
    new Int32Array([-1]),
    new Uint32Array([4294967295]),
    new Float32Array([-0, NaN]),
    new Float64Array([0.1, -Infinity]),
    new BigInt64Array([-1n]),
    new BigUint64Array([2n ** 64n - 1n]),
  ])('round-trips a %s as the same class', (value) => {
    const back = trip(p.any(), { v: [value] }) as { v: [typeof value] };
    expect(back.v[0]).toBeInstanceOf(value.constructor);
    expect(back.v[0]).toEqual(value);
  });

  it('reads a subclass or a view into a larger buffer as its built-in class', () => {
    const view = new Uint16Array(new ArrayBuffer(8), 2, 2);
    view.set([1, 2]);
    expect(trip(p.any(), view)).toEqual(Uint16Array.of(1, 2));
    class Bytes extends Uint8Array {}
    const back = trip(p.any(), Bytes.of(7));
    expect(back).toBeInstanceOf(Uint8Array);
    expect(back).not.toBeInstanceOf(Bytes);
  });

  it('reads a subclass of Date, Array, Map or Set as its built-in class', () => {
    class Day extends Date {}
    class List extends Array<AnyValue> {}
    class Table extends Map<AnyValue, AnyValue> {}
    class Bag extends Set<AnyValue> {}
    for (const [value, plain] of [
      [new Day(0), new Date(0)],
      [List.of(1), [1]],
      [new Table([[1, 2]]), new Map([[1, 2]])],
      [new Bag([1]), new Set([1])],
    ] as [AnyValue, AnyValue][]) {
      expect(trip(p.any(), value)).toStrictEqual(plain);
    }
  });

  it('accepts a null-prototype dictionary', () => {
    const dict = Object.create(null) as { [key: string]: AnyValue };
    dict.a = 1;
    expect(trip(p.any(), dict)).toEqual({ a: 1 });
  });

  class Point {
    constructor(
      public x = 1,
      public y = 2
    ) {}
  }

  it.each([
    ['symbol', Symbol('s')],
    ['bigint', 1n],
    ['WeakMap', new WeakMap()],
    ['RegExp', /a/g],
    ['Error', new Error('boom')],
    ['DataView', new DataView(new ArrayBuffer(2))],
    ['Point', new Point()],
    // A prototype chain with no constructor anywhere has no name to show.
    ['this type', Object.create(Object.create(null))],
  ] as [string, unknown][])('rejects %s values, which it has no tag for', (name, value) => {
    // The type rules these out; data typed `any` can still carry them.
    expect(() => p.any().encode(value as AnyValue)).toThrow(`p.any cannot encode ${name} values`);
  });

  it.each([Infinity, -Infinity, NaN])('rejects %p', (value) => {
    expect(() => p.any().encode(value)).toThrow(TypeError);
  });

  it.each([
    [0, 1],
    [-(2 ** 53 - 1), 9],
    [2 ** 53 - 1, 9],
    [-0, 10],
    [0.5, 2],
    [2 ** 53, 3],
    [-(2 ** 53), 3],
    // Under the int tag 1e300 would take 128 bytes.
    [1e300, 6],
    [Number.MAX_VALUE, 10],
  ])('round-trips %p in %p bytes, safe integers under the int tag', (value, bytes) => {
    expect(trip(p.any(), value)).toBe(value);
    expect(p.any().encode(value)).toHaveLength(bytes);
  });

  it.each([
    [4, p.float(), 42, 'Non-canonical float tag on the number 42'],
    [4, p.float(), 2 ** 53 - 1, 'Non-canonical float tag on the number 9007199254740991'],
    [3, p.int(), 2 ** 53, 'Non-canonical int tag on the number 9007199254740992'],
    [3, p.int(), 1e300, 'Non-canonical int tag on the number 1e+300'],
  ] as [number, PNode<number>, number, string][])(
    'rejects tag %p on a number the other tag carries',
    (tag, node, value, message) => {
      const enc = new Encoder();
      enc.compose(tag, 22);
      node._write(enc, value);
      expect(() => p.any().decode(enc.output())).toThrow(new CorruptInputError(message));
    }
  );

  it('rejects a typed-array length too large for any buffer', () => {
    // The Float64Array tag, then a count whose byte size is past 2^53.
    const enc = new Encoder();
    enc.compose(19, 22);
    enc.composeTerm(2 ** 1021);
    expect(() => p.any().decode(enc.output())).toThrow(
      new CorruptInputError(`Binary length ${2 ** 1021} is above the largest possible buffer`)
    );
  });

  it('rejects a record whose wire form repeats a key', () => {
    // The object tag (8 of 22), then a two-entry count, then the same key
    // twice: a shape the encoder never produces.
    const enc = new Encoder();
    enc.compose(8, 22);
    enc.composeTerm(2);
    p.string()._write(enc, 'a');
    p.any()._write(enc, 1);
    p.string()._write(enc, 'a');
    p.any()._write(enc, 2);
    expect(() => p.any().decode(enc.output())).toThrow('Repeated key "a" in p.record');
  });
});
