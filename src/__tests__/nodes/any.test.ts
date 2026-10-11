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
      new RegExp(`p\\.any nests deeper than ${MAX_DEPTH} levels$`)
    );
  });

  it('refuses a value that contains itself, which is infinitely deep', () => {
    const message = `p.any nests deeper than ${MAX_DEPTH} levels`;
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

  it('rejects a float tag on an integer value', () => {
    // Integers always travel under the int tag.
    const enc = new Encoder();
    enc.compose(4, 22); // TAG_FLOAT
    p.float()._write(enc, 42);
    expect(() => p.any().decode(enc.output())).toThrow(
      'Non-canonical float tag on an integer value'
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
