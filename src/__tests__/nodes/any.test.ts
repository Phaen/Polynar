/**
 * `p.any()`: self-describing values of no declared type.
 */

import { p, Encoder, type AnyValue } from '../../index';
import { trip } from '../support';

describe('Schema any', () => {
  it('copies shared references and refuses cycles', () => {
    const shared = { n: 1 };
    expect(trip(p.any(), { a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } });

    const loop: { [key: string]: AnyValue } = {};
    loop.self = loop;
    expect(() => p.any().encode(loop)).toThrow('circular');
    const ring: AnyValue[] = [];
    ring.push(ring);
    expect(() => p.any().encode(ring)).toThrow('circular');
    const map = new Map<AnyValue, AnyValue>();
    map.set('self', [map]);
    expect(() => p.any().encode(map)).toThrow('circular');
    const set = new Set<AnyValue>();
    set.add({ set });
    expect(() => p.any().encode(set)).toThrow('circular');
  });

  it('closes a container whose write threw, so the node encodes it again later', () => {
    const node = p.any();
    const inner: { [key: string]: AnyValue } = { n: 1 };
    expect(() => node.encode([inner, Infinity])).toThrow('[1]: ');
    expect(() => node.encode({ v: new Set([inner, NaN]) })).toThrow('v[1]: ');
    expect(trip(node, [inner, inner])).toEqual([{ n: 1 }, { n: 1 }]);
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
