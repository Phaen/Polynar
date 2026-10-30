/**
 * `p.any()`: self-describing values of no declared type.
 */

import { p, Encoder, CorruptInputError, type AnyValue, type PNode, type PAny } from '../../index';
import {
  AnyMissing,
  MAX_DEPTH,
  TAG_TIERS,
  kindMarker,
  sameValue,
  typedNode,
} from '../../nodes/any';
import { PBinary, type TypedArrayClass } from '../../nodes/binary';
import type { Float16ArrayLike } from '../../nodes/guards';
import { members } from '../../nodes/members';
import { DEPTH } from '../../nodes/lazy';
import { loadedPriors } from '../../predictor/prior';
import { STRUCT } from '../../predictor/types';
import { trip } from '../support';

/** The static tag table inside a plain `p.any`. */
const tags = () => members(TAG_TIERS.length, { weights: TAG_TIERS }, 'p.any');

/** A value of every kind `p.any` has a tag for, nested in every container. */
const everyKind = (): AnyValue => ({
  absent: undefined,
  nothing: null,
  flags: [false, true],
  numbers: [0, -7, 2 ** 60, 0.1, -0, NaN, Infinity],
  big: [0n, -(2n ** 70n)],
  text: ['', 'hello', 'hello', 'héllo 👋'],
  when: new Date(0),
  pattern: /a+b/gi,
  nested: { deep: [{ k: 1 }, { k: 2 }], '': {} },
  map: new Map<AnyValue, AnyValue>([
    ['k', 1],
    [[0], new Set<AnyValue>(['x', 2])],
  ]),
  set: new Set<AnyValue>([null, 'x']),
  buffer: Uint8Array.of(1, 2, 3).buffer,
  view: new DataView(Uint8Array.of(4, 5).buffer),
  typed: [Int16Array.of(-1, 2), Float64Array.of(0.5), BigUint64Array.of(1n)],
});

/** The tags of the kinds the hand-built messages use. */
const TAG = { INT: 4, FLOAT: 5, BIGINT: 6, REGEXP: 9, OBJECT: 11, FLOAT64_ARRAY: 24 };

describe('Schema any', () => {
  it.each([['p.any()', p.any()]])('round-trips a value of every kind through %s', (_name, node) => {
    const value = everyKind();
    const back = trip(node, value) as { buffer: ArrayBuffer; view: DataView };
    expect(back).toEqual(value);
    expect([...new Uint8Array(back.buffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(back.view.buffer)]).toEqual([4, 5]);
  });

  it('copies shared references', () => {
    const shared = { n: 1 };
    const back = trip(p.any(), { a: shared, b: shared }) as { a: object; b: object };
    expect(back).toEqual({ a: { n: 1 }, b: { n: 1 } });
    expect(back.a).not.toBe(back.b);
  });

  it('reads a hole in a sparse array as undefined', () => {
    const back = trip(p.any(), [1, , 3]) as AnyValue[];
    expect(back).toStrictEqual([1, undefined, 3]);
    expect(1 in back).toBe(true);
  });

  const wrappers: [string, (inner: AnyValue) => AnyValue][] = [
    ['array', (inner) => [inner]],
    ['record', (inner) => ({ k: inner })],
    ['map', (inner) => new Map([['k', inner]])],
    ['set', (inner) => new Set([inner])],
  ];

  /**
   * A message one level deeper than the encoder writes: the node's depth for
   * the message starts a level below zero, so the limit lets one more through.
   */
  const tooDeep = (node: PNode<AnyValue>, value: AnyValue): Uint8Array => {
    const enc = new Encoder();
    enc.state(node, () => ({ depth: -1 }));
    node._write(enc, value);
    return enc.output();
  };
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

  it.each(wrappers)('rejects input with %s nesting deeper than MAX_DEPTH', (_kind, wrap) => {
    const node = p.any();
    expect(() => node.decode(tooDeep(node, nest(wrap, MAX_DEPTH + 1)))).toThrow(
      new CorruptInputError(`p.any input nests deeper than ${MAX_DEPTH} levels`)
    );
  });

  it('packs a JSON-like value into fewer bytes than a uniform tag would', () => {
    // A uniform tag costs 4.8 bits per value and took 25 bytes here.
    const value = { name: 'Ada', age: 36, tags: ['a', 'b'] };
    expect(trip(p.any(), value)).toEqual(value);
    expect(p.any().encode(value)).toHaveLength(24);
  });

  it('works again after a write or read that threw', () => {
    const node = p.any();
    const wrap = (inner: AnyValue) => [inner];
    expect(() => node.encode(nest(wrap, MAX_DEPTH, Symbol('s') as never))).toThrow('symbol');
    expect(() => node.decode(tooDeep(node, nest(wrap, MAX_DEPTH + 1)))).toThrow(CorruptInputError);
    const value = nest(wrap, MAX_DEPTH);
    expect(trip(node, value)).toEqual(value);
  });

  it('counts its depth per message, so a value at the limit encodes twice in a row', () => {
    const node = p.any();
    const value = nest((inner) => ({ k: inner }), MAX_DEPTH);
    const bytes = node.encode(value);
    expect(node.encode(value)).toEqual(bytes);
    expect(node.decode(bytes)).toEqual(value);
    expect(node.decode(bytes)).toEqual(value);
  });

  it('names the key of a record value p.any() cannot encode', () => {
    expect(() => p.any().encode({ a: [Symbol('s') as never] })).toThrow(
      'a[0]: p.any cannot encode symbol values'
    );
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

  const Float16 = (globalThis as { Float16Array?: TypedArrayClass<Float16ArrayLike> }).Float16Array;

  (Float16 === undefined ? it.skip : it)('round-trips a Float16Array as the same class', () => {
    const value = new (Float16 as TypedArrayClass<Float16ArrayLike>)(
      Uint16Array.of(0x3c00, 0x8000, 0x7e01).buffer
    );
    const back = trip(p.any(), { v: [value] }) as { v: [Float16ArrayLike] };
    expect(back.v[0]).toBeInstanceOf(Float16);
    expect(new Uint16Array(back.v[0].buffer)).toEqual(Uint16Array.of(0x3c00, 0x8000, 0x7e01));
  });

  it('keeps a tag for a typed-array class the environment lacks', () => {
    expect(typedNode(Uint16Array, 'Uint16Array')).toBeInstanceOf(PBinary);
    const missing = typedNode(undefined, 'Float16Array') as AnyMissing;
    expect(missing).toBeInstanceOf(AnyMissing);
    expect(missing._kinds).toEqual(['Float16Array']);
    expect(() => missing._write()).toThrow(
      new TypeError('p.any cannot encode Float16Array values here: the class is missing')
    );
    expect(() => missing._read()).toThrow(
      new TypeError('p.any read a Float16Array, which this environment lacks')
    );
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

  it('reads a subclass of Date, RegExp, ArrayBuffer, Array, Map or Set as its built-in class', () => {
    class Day extends Date {}
    class Pattern extends RegExp {}
    class Buf extends ArrayBuffer {}
    class List extends Array<AnyValue> {}
    class Table extends Map<AnyValue, AnyValue> {}
    class Bag extends Set<AnyValue> {}
    for (const [value, plain] of [
      [new Day(0), new Date(0)],
      [new Pattern('a', 'g'), /a/g],
      [new Buf(2), new ArrayBuffer(2)],
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
    ['WeakMap', new WeakMap()],
    ['Error', new Error('boom')],
    ['Number', new Number(1)],
    ['String', new String('a')],
    ['SharedArrayBuffer', new SharedArrayBuffer(2)],
    ['Point', new Point()],
    // A prototype chain with no constructor anywhere has no name to show.
    ['this type', Object.create(Object.create(null))],
  ] as [string, unknown][])('rejects %s values, which it has no tag for', (name, value) => {
    // The type rules these out; data typed `any` can still carry them.
    expect(() => p.any().encode(value as AnyValue)).toThrow(`p.any cannot encode ${name} values`);
  });

  it.each([Infinity, -Infinity, NaN])('round-trips %p under the float tag', (value) => {
    expect(trip(p.any(), value)).toBe(value);
    const enc = new Encoder();
    tags().write(enc, TAG.FLOAT);
    p.float()._write(enc, value);
    expect(p.any().encode(value)).toEqual(enc.output());
  });

  it('round-trips the non-finite values inside containers', () => {
    const value = new Map<AnyValue, AnyValue>([
      [NaN, [Infinity, -Infinity, NaN]],
      [Infinity, new Set<AnyValue>([NaN, -Infinity])],
      ['k', { n: -Infinity }],
    ]);
    expect(trip(p.any(), value)).toEqual(value);
  });

  it('reads every NaN as the one NaN, its payload bits dropped', () => {
    const payload = new Float64Array(new BigUint64Array([0x7ff8000000000001n]).buffer)[0];
    expect(p.any().encode(payload)).toEqual(p.any().encode(NaN));
    expect(trip(p.any(), payload)).toBeNaN();
  });

  it.each([
    0n,
    1n,
    -1n,
    2n ** 31n,
    2n ** 32n - 1n,
    -(2n ** 32n),
    2n ** 63n,
    -(2n ** 64n) + 1n,
    2n ** 200n,
    -(2n ** 200n) - 12345n,
    3n ** 1000n,
  ])('round-trips the bigint %p', (value) => {
    expect(trip(p.any(), value)).toBe(value);
    expect(trip(p.any(), [value, { v: value }])).toEqual([value, { v: value }]);
  });

  it.each([
    [0n, 2],
    [-1n, 2],
    [100n, 3],
    // A bit count and a top bit: the zero bits below it end the message.
    [2n ** 64n, 3],
    [2n ** 64n - 1n, 11],
    [2n ** 200n, 3],
    [2n ** 200n - 1n, 28],
  ])('packs the bigint %p into %p bytes', (value, bytes) => {
    expect(p.any().encode(value)).toHaveLength(bytes);
  });

  it.each([
    new ArrayBuffer(0),
    Uint8Array.of(0, 1, 255).buffer,
    new DataView(new ArrayBuffer(0)),
    new DataView(Uint8Array.of(9, 8, 7).buffer),
  ])('round-trips %p as the same class', (value) => {
    // Jest's equality sees no difference between two buffers of other bytes.
    const bytes = (of: ArrayBuffer | DataView) =>
      of instanceof DataView ? [...new Uint8Array(of.buffer)] : [...new Uint8Array(of)];
    const back = trip(p.any(), [value]) as [typeof value];
    expect(back[0]).toBeInstanceOf(value.constructor);
    expect(bytes(back[0])).toEqual(bytes(value));
  });

  it('reads a DataView into a larger buffer as one over exactly its bytes', () => {
    const view = new DataView(Uint8Array.of(1, 2, 3, 4, 5).buffer, 1, 3);
    const back = trip(p.any(), view) as DataView;
    expect(back).toBeInstanceOf(DataView);
    expect(back.byteOffset).toBe(0);
    expect(back.buffer.byteLength).toBe(3);
    expect([...new Uint8Array(back.buffer)]).toEqual([2, 3, 4]);
  });

  /** Whether this engine knows the `v` flag, which Node 20 added. */
  const unicodeSets = (() => {
    try {
      return new RegExp('', 'v').flags === 'v';
    } catch {
      return false;
    }
  })();

  it.each([
    /a/,
    /(?:)/,
    new RegExp(''),
    new RegExp('a/b', 'dgimsuy'),
    new RegExp('line\nbreak/[/]', 'y'),
    ...(unicodeSets ? [new RegExp('[\\p{L}--a]', 'dgimsvy')] : []),
  ])('round-trips %p', (value) => {
    const back = trip(p.any(), { r: value }) as { r: RegExp };
    expect(back.r).toBeInstanceOf(RegExp);
    expect(back.r.source).toBe(value.source);
    expect(back.r.flags).toBe(value.flags);
  });

  it('leaves out lastIndex, which is state rather than part of the value', () => {
    const value = /a/g;
    value.lastIndex = 3;
    expect((trip(p.any(), value) as RegExp).lastIndex).toBe(0);
  });

  it('refuses a RegExp flag it has no bit for', () => {
    class Future extends RegExp {
      get flags(): string {
        return 'gx';
      }
    }
    expect(() => p.any().encode(new Future('a'))).toThrow(
      new TypeError('p.any cannot encode the RegExp flag x')
    );
  });

  /** The RegExp tag, then a source and a flag mask as the encoder lays them out. */
  const regexpWire = (source: string, mask: number): Uint8Array => {
    const enc = new Encoder();
    tags().write(enc, TAG.REGEXP);
    p.string()._write(enc, source);
    enc.compose(mask, 256);
    return enc.output();
  };

  it('reads each flag from its bit', () => {
    expect((p.any().decode(regexpWire('a', 0b10000010)) as RegExp).flags).toBe('gy');
  });

  it('reads a source the engine rewrites, which the encoder never writes, as the engine does', () => {
    expect((p.any().decode(regexpWire('/', 0)) as RegExp).source).toBe('\\/');
    expect((p.any().decode(regexpWire('', 0)) as RegExp).source).toBe('(?:)');
  });

  it.each([
    ['(', 0],
    // The u and v flags exclude each other.
    ['a', 0b01100000],
  ])('rejects the invalid RegExp %p with flag mask %p', (source, mask) => {
    expect(() => p.any().decode(regexpWire(source, mask))).toThrow(/^Invalid RegExp/);
  });

  it.each([
    [0, 1],
    [-(2 ** 53 - 1), 9],
    [2 ** 53 - 1, 9],
    [-0, 2],
    [0.5, 2],
    [2 ** 53, 3],
    [-(2 ** 53), 3],
    // Under the int tag 1e300 would take 128 bytes.
    [1e300, 5],
    [Number.MAX_VALUE, 10],
  ])('round-trips %p in %p bytes, safe integers under the int tag', (value, bytes) => {
    expect(trip(p.any(), value)).toBe(value);
    expect(p.any().encode(value)).toHaveLength(bytes);
  });

  it.each([
    [TAG.FLOAT, p.float(), 42],
    [TAG.FLOAT, p.float(), 2 ** 53 - 1],
    [TAG.INT, p.int(), 2 ** 53],
    [TAG.INT, p.int(), 1e300],
  ] as [number, PNode<number>, number][])(
    'reads tag %p on a number the other tag carries as that number',
    (tag, node, value) => {
      const enc = new Encoder();
      tags().write(enc, tag);
      node._write(enc, value);
      expect(p.any().decode(enc.output())).toBe(value);
    }
  );

  it('rejects a typed-array length too large for any buffer', () => {
    // The Float64Array tag, then a count whose byte size is past 2^53.
    const enc = new Encoder();
    tags().write(enc, TAG.FLOAT64_ARRAY);
    enc.composeTerm(2 ** 1021);
    expect(() => p.any().decode(enc.output())).toThrow(
      new CorruptInputError(`Binary length ${2 ** 1021} is above the largest possible buffer`)
    );
  });

  it('reads back a record whose key is __proto__ as an own property', () => {
    const value = JSON.parse('{"__proto__": 1, "a": 2}') as AnyValue;
    const back = trip(p.any(), value) as object;
    expect(Object.keys(back)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
  });
  it('round-trips inside p.versioned, migrated, with nothing left over between messages', () => {
    const value = { name: 'Ada', tags: ['a', 'b', 'a'], n: [1, 1, 2] };
    const Old = p.versioned(p.any());
    const New = p.versioned(p.any(), [
      p.any(),
      (v: AnyValue) => ({ old: v, keys: ['a', 'b', 'a'] }) as AnyValue,
    ]);
    const migrated = New.decode(Old.encode(value));
    expect(migrated).toEqual({ old: value, keys: ['a', 'b', 'a'] });
    const bytes = New.encode(migrated);
    expect(New.encode(migrated)).toEqual(bytes);
    expect(New.decode(bytes)).toEqual(migrated);
    expect(New.decode(bytes)).toEqual(migrated);
  });

  it.each([['p.any()', () => p.any()]])(
    'round-trips %s through p.lazy recursion, with nothing left over between messages',
    (_name, any) => {
      type Tree = { v?: AnyValue; kids: Tree[] };
      const Tree: PNode<Tree> = p.object({ v: any(), kids: p.array(p.lazy(() => Tree)) });
      const value: Tree = {
        v: 'root',
        kids: [
          { v: { k: 'root' }, kids: [] },
          { v: ['root', 1], kids: [{ v: 'root', kids: [] }] },
        ],
      };
      const bytes = Tree.encode(value);
      expect(Tree.encode(value)).toEqual(bytes);
      expect(Tree.decode(bytes)).toEqual(value);
      expect(Tree.decode(bytes)).toEqual(value);
    }
  );
});

describe('p.any hints', () => {
  const HEX = '0123456789abcdef';
  const uuid = p.string().charset(`${HEX}-`).length(36);
  const ids = [
    '0f8fad5b-d9cb-469f-a165-70867728950e',
    '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    '0f8fad5b-d9cb-469f-a165-70867728950e',
  ];

  it('is the plain wire without hints', () => {
    const value = everyKind();
    expect(p.any([]).encode(value)).toEqual(p.any().encode(value));
  });

  it.each([['p.any(hints)', p.any([uuid]), p.any()]])(
    'codes the values a hint takes behind its tag, at any depth, through %s',
    (_n, node, bare) => {
      const value = { ids, deep: [new Map([[ids[0], new Set([ids[1], 'other'])]])], n: 1 };
      expect(trip(node, value)).toEqual(value);
      expect(node.encode(value).length).toBeLessThan(bare.encode(value).length);
    }
  );

  it('tries the hints of the value kind in order, and takes the first that writes it', () => {
    const small = p.int().min(0).max(3);
    const first = p.any([small, p.int().min(0).max(1000), p.string().length(1)]);
    const value = [2, 900, 'x', 'xy', 5000, true];
    expect(trip(first, value)).toEqual(value);
    const swapped = p.any([p.int().min(0).max(1000), small, p.string().length(1)]);
    expect(first.encode([2]).length).toBeLessThanOrEqual(swapped.encode([2]).length);
    expect(first.encode(value)).not.toEqual(swapped.encode(value));
  });

  it('refuses a hint without kinds', () => {
    expect(() => p.any([p.lazy(() => p.int())])).toThrow(
      new TypeError('p.any hints must declare their kinds')
    );
  });

  it('takes only values a hint gives back unchanged', () => {
    const sorted = p.array(p.int().min(0).max(9)).unordered();
    const node = p.any([sorted, p.int(), p.array(p.bool())]);
    const value = { a: [3, 1, 2], b: [1, 2, 3], c: -0, d: [5], e: [true, false] };
    const back = trip(node, value) as typeof value;
    expect(back).toEqual(value);
    expect(Object.is(back.c, -0)).toBe(true);
    // Only the values each hint takes cost less than the built-in path.
    expect(node.encode([1, 2, 3]).length).toBeLessThan(p.any().encode([1, 2, 3]).length);
    expect(node.encode([3, 1, 2]).length).toBeGreaterThan(node.encode([1, 2, 3]).length);
  });

  it('counts a hint value as a level, so a hint holding p.any cannot nest without bound', () => {
    const Any: PAny = p.any([p.array(p.lazy((): PNode<AnyValue> => Any))]);
    let deep: AnyValue = 0;
    for (let i = 0; i <= MAX_DEPTH; i++) deep = [deep];
    expect(() => Any.encode(deep)).toThrow(
      new RangeError(`p.any nests deeper than ${MAX_DEPTH} levels`)
    );
    const enc = new Encoder();
    enc.state(Any, () => ({ depth: -1 }));
    enc.state(DEPTH, () => ({ depth: -1 }));
    Any._write(enc, deep);
    expect(() => Any.decode(enc.output())).toThrow(
      new CorruptInputError(`p.any input nests deeper than ${MAX_DEPTH} levels`)
    );
  });
});

describe('sameValue', () => {
  const view = (bytes: number[], at = 0) => new DataView(Uint8Array.from(bytes).buffer, at);

  it.each([
    ['equal primitives', 1, 1],
    ['NaN', NaN, NaN],
    ['bigints', 2n, 2n],
    ['dates', new Date(5), new Date(5)],
    ['regular expressions', /a/g, /a/g],
    ['buffers', Uint8Array.of(1, 2).buffer, Uint8Array.of(1, 2).buffer],
    ['DataViews by the bytes they span', view([0, 1, 2], 1), view([1, 2])],
    ['typed arrays', Int16Array.of(1, -1), Int16Array.of(1, -1)],
    ['arrays', [1, [2]], [1, [2]]],
    [
      'records, a null prototype too',
      { a: 1 },
      Object.assign(Object.create(null) as object, { a: 1 }),
    ],
    ['Maps', new Map([[1, 'a']]), new Map([[1, 'a']])],
    ['Sets', new Set([1, 2]), new Set([1, 2])],
  ])('holds for %s', (_name, a, b) => {
    expect(sameValue(a, b)).toBe(true);
  });

  it.each([
    ['-0 and 0', 0, -0],
    ['a number and a string', 1, '1'],
    ['null and an object', null, {}],
    ['an object and null', {}, null],
    ['dates', new Date(5), new Date(6)],
    ['flags', /a/g, /a/i],
    ['sources', /a/, /b/],
    ['bytes', Uint8Array.of(1), Uint8Array.of(2)],
    ['byte counts', Uint8Array.of(1), Uint8Array.of(1, 2)],
    ['typed array classes', Int8Array.of(1), Uint8Array.of(1)],
    ['an array and a record', [], {}],
    ['array lengths', [1], [1, 2]],
    ['array items', [1], [2]],
    ['record keys', { a: 1 }, { b: 1 }],
    ['record key order', { a: 1, b: 2 }, { b: 2, a: 1 }],
    ['record key counts', { a: 1 }, { a: 1, b: 2 }],
    ['record values', { a: 1 }, { a: 2 }],
    [
      'Map order',
      new Map([
        [1, 1],
        [2, 2],
      ]),
      new Map([
        [2, 2],
        [1, 1],
      ]),
    ],
    ['Map values', new Map([[1, 1]]), new Map([[1, 2]])],
    ['Map sizes', new Map([[1, 1]]), new Map()],
    ['Set order', new Set([1, 2]), new Set([2, 1])],
    ['a Map and its subclass', new Map(), new (class extends Map {})()],
  ])('fails for %s', (_name, a, b) => {
    expect(sameValue(a, b)).toBe(false);
  });

  it('ends on a value holding itself', () => {
    const ring: unknown[] = [1];
    ring.push(ring);
    expect(sameValue([1, [1, 2]], ring)).toBe(false);
  });
});

describe('p.any().compress()', () => {
  const small = p.int().min(0).max(3);
  const Float16 = (globalThis as { Float16Array?: TypedArrayClass<Float16ArrayLike> }).Float16Array;

  it('round-trips a value of every kind', () => {
    const value = everyKind();
    const back = trip(p.any().compress(), value) as { buffer: ArrayBuffer; view: DataView };
    expect(back).toEqual(value);
    expect([...new Uint8Array(back.buffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(back.view.buffer)]).toEqual([4, 5]);
  });

  it.each<[string, AnyValue]>([
    ['null', null],
    ['undefined', undefined],
    ['true', true],
    ['false', false],
    ['a safe integer', -42],
    ['the largest safe integer', Number.MAX_SAFE_INTEGER],
    ['-0', -0],
    ['a float', 0.1],
    ['a small float', 5e-324],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a number past 2^53', 2 ** 60],
    ['a negative number past 2^53', -(2 ** 53) - 2],
    ['a bigint', -(2n ** 70n)],
    ['an empty string', ''],
    ['a string', 'héllo 👋'],
    ['a lone surrogate', 'a\ud800b\udc00'],
    ['a date', new Date(1700000000000)],
    ['a date before 1970', new Date(-1)],
    ['a regexp', /a+b/gimsuy],
    ['an empty array', []],
    ['an empty object', {}],
    ['an empty map', new Map()],
    ['an empty set', new Set()],
  ])('round-trips %s at the root and inside containers', (_name, value) => {
    const node = p.any().compress();
    expect(trip(node, value)).toEqual(value);
    const nested = [value, { k: value }, new Map([[value, value]]), new Set([value])];
    expect(trip(node, nested)).toEqual(nested);
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
    const back = trip(p.any().compress(), { v: [value] }) as { v: [typeof value] };
    expect(back.v[0]).toBeInstanceOf(value.constructor);
    expect(back.v[0]).toEqual(value);
  });

  (Float16 === undefined ? it.skip : it)('round-trips a Float16Array as the same class', () => {
    const value = new (Float16 as TypedArrayClass<Float16ArrayLike>)(
      Uint16Array.of(0x3c00, 0x8000, 0x7e01).buffer
    );
    const back = trip(p.any().compress(), [value]) as [Float16ArrayLike];
    expect(back[0]).toBeInstanceOf(Float16);
    expect(new Uint16Array(back[0].buffer)).toEqual(Uint16Array.of(0x3c00, 0x8000, 0x7e01));
  });

  it('round-trips an ArrayBuffer and a DataView over part of a buffer', () => {
    const bytes = Uint8Array.of(9, 8, 7, 6);
    const value = [bytes.buffer, new DataView(bytes.buffer, 1, 2)];
    const back = trip(p.any().compress(), value) as [ArrayBuffer, DataView];
    expect(back[0]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(back[0])]).toEqual([9, 8, 7, 6]);
    expect(back[1]).toBeInstanceOf(DataView);
    expect([...new Uint8Array(back[1].buffer)]).toEqual([8, 7]);
  });

  it('reads a hole in a sparse array as undefined', () => {
    const back = trip(p.any().compress(), [1, , 3]) as AnyValue[];
    expect(back).toStrictEqual([1, undefined, 3]);
    expect(1 in back).toBe(true);
  });

  it('keeps a __proto__ key as an own property', () => {
    const value = JSON.parse('{"__proto__": {"x": 1}, "a": [2]}') as AnyValue;
    const back = trip(p.any().compress(), value) as Record<string, AnyValue>;
    expect(Object.keys(back)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(back['__proto__']).toEqual({ x: 1 });
  });

  it('round-trips nested objects, Maps with any keys and Sets', () => {
    const value = {
      user: { name: 'Ada', tags: ['a', 'b'], address: { city: 'X', zip: 1234 } },
      index: new Map<AnyValue, AnyValue>([
        ['k', 1],
        [2, new Set<AnyValue>([null, 'x', [1]])],
        [[0], new Map()],
        [{ o: true }, -0],
        [undefined, 1.5],
      ]),
      seen: new Set<AnyValue>([1, 'one', { one: 1 }]),
    };
    const back = trip(p.any().compress(), value) as typeof value;
    expect(back).toEqual(value);
    expect([...back.index.keys()]).toEqual(['k', 2, [0], { o: true }, undefined]);
  });

  it('round-trips values of different kinds at one key path', () => {
    const value = [{ a: 1 }, { a: 'x' }, { a: [1, 'y'] }, { a: 1.5 }, { a: null }, { a: 2 }];
    expect(trip(p.any().compress(), value)).toEqual(value);
  });

  it('round-trips a run of the same value, which the encoder classifies once per position', () => {
    const value = [1, 1, 'a', 'a', true, true, [], []];
    expect(trip(p.any().compress(), value)).toEqual(value);
  });

  it('learns from the values before, so a repeating record costs less than plain', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i, name: 'item', ok: true }));
    const node = p.any().compress();
    expect(trip(node, rows)).toEqual(rows);
    expect(node.encode(rows).length).toBeLessThan(p.any().encode(rows).length);
  });

  it('takes the predictor options', () => {
    const value = { a: [1, 2, 3], b: 'text' };
    const node = p.any().compress({ window: 4, separate: true, prior: loadedPriors.json.source });
    expect(trip(node, value)).toEqual(value);
  });

  it.each<[string, unknown, Error]>([
    ['a non-object', 5, new TypeError('p.any: compress options must be an object')],
    [
      'a window below 1',
      { window: 0 },
      new RangeError('p.any: compress window must be at least 1'),
    ],
    [
      'a non-boolean separate',
      { separate: 1 },
      new TypeError('p.any: compress separate must be a boolean'),
    ],
  ])('refuses %s as options', (_name, options, error) => {
    expect(() => p.any().compress(options as never)).toThrow(error);
  });

  it('refuses a second .compress()', () => {
    expect(() => p.any().compress().compress()).toThrow(
      new TypeError('p.any compress is already set')
    );
  });

  it('adapts under _adapted, and stays as it is when compressed already', () => {
    const plain = p.any([p.int().min(0).max(3)]);
    const adapted = plain._adapted({});
    expect(adapted).not.toBe(plain);
    expect(adapted._compress).toEqual({});
    const value = [2, 'x'];
    expect(trip(adapted, value)).toEqual(value);
    const own = p.any().compress({ window: 8 });
    expect(own._adapted({})).toBe(own);
  });

  it('names the first structure symbol of a value in _marker', () => {
    const node = p.any([p.int().min(0).max(3)]);
    expect(node._marker(2)).toBe(STRUCT.HINT);
    expect(node._marker(9)).toBe(STRUCT.INT);
    expect(node._marker(-0)).toBe(STRUCT.NUM);
    expect(node._marker('x')).toBe(STRUCT.STR);
    expect(node._marker(true)).toBe(STRUCT.TRUE);
    expect(node._marker([])).toBe(STRUCT.ARR_START);
    expect(node._marker(new Map())).toBe(STRUCT.MAP_START);
    expect(node._marker(new Uint8Array(1))).toBe(STRUCT.TYPED_0 + 1);
  });

  it.each<[string, unknown]>([
    ['a symbol', Symbol('s')],
    ['a function', () => 0],
    ['a class instance', new (class Point {})()],
    ['an invalid Date', new Date(NaN)],
  ])('gives the kind marker of %s, which p.any cannot encode, without throwing', (_n, value) => {
    expect(p.any()._marker(value)).toBe(kindMarker(value));
  });

  it.each<[string, unknown, Error]>([
    ['a symbol', Symbol('s'), new TypeError('p.any cannot encode symbol values')],
    ['a function', () => 0, new TypeError('p.any cannot encode function values')],
    [
      'a class instance',
      new (class Point {})(),
      new TypeError('p.any cannot encode Point values, only plain objects'),
    ],
    [
      'an invalid Date',
      new Date(NaN),
      new TypeError('p.any expected a valid Date, got Invalid Date'),
    ],
  ])('refuses %s as plain p.any does', (_n, value, error) => {
    expect(() =>
      p
        .any()
        .compress()
        .encode(value as AnyValue)
    ).toThrow(error);
    expect(() => p.any().encode(value as AnyValue)).toThrow(error);
  });

  it('locates an encode error at an object key, an array index and a map entry', () => {
    const node = p.any().compress();
    const bad = Symbol('s') as never;
    expect(() => node.encode({ a: [1, bad] })).toThrow('a[1]: p.any cannot encode symbol values');
    expect(() =>
      node.encode({
        m: new Map<AnyValue, AnyValue>([
          ['k', 1],
          ['j', bad],
        ]),
      })
    ).toThrow('m[1]: p.any cannot encode symbol values');
    expect(() => node.encode({ s: new Set<AnyValue>([1, bad]) })).toThrow(
      's[1]: p.any cannot encode symbol values'
    );
  });

  const wrappers: [string, (inner: AnyValue) => AnyValue][] = [
    ['array', (inner) => [inner]],
    ['record', (inner) => ({ k: inner })],
    ['map key', (inner) => new Map([[inner, 0]])],
    ['map value', (inner) => new Map([['k', inner]])],
    ['set', (inner) => new Set([inner])],
  ];
  const nest = (wrap: (inner: AnyValue) => AnyValue, levels: number): AnyValue => {
    let value: AnyValue = 0;
    for (let i = 0; i < levels; i++) value = wrap(value);
    return value;
  };

  it.each(wrappers)('round-trips %s nesting exactly MAX_DEPTH levels deep', (_kind, wrap) => {
    const value = nest(wrap, MAX_DEPTH);
    expect(trip(p.any().compress(), value)).toEqual(value);
  });

  it.each(wrappers)('refuses to encode %s nesting deeper than MAX_DEPTH', (_kind, wrap) => {
    expect(() =>
      p
        .any()
        .compress()
        .encode(nest(wrap, MAX_DEPTH + 1))
    ).toThrow(new RangeError(`p.any nests deeper than ${MAX_DEPTH} levels`));
  });

  it.each(wrappers)('rejects input with %s nesting deeper than MAX_DEPTH', (_kind, wrap) => {
    const node = p.any().compress();
    const enc = new Encoder();
    enc.state(node, () => ({ depth: -1 }));
    node._write(enc, nest(wrap, MAX_DEPTH + 1));
    expect(() => node.decode(enc.output())).toThrow(
      new CorruptInputError(`p.any input nests deeper than ${MAX_DEPTH} levels`)
    );
  });

  describe('hints', () => {
    it('codes a value a hint takes through it, and the rest by kind', () => {
      const node = p.any([small]).compress();
      const value = [2, 9, 'x', 3, -0];
      const back = trip(node, value) as AnyValue[];
      expect(back).toEqual(value);
      expect(Object.is(back[4], -0)).toBe(true);
    });

    it('picks among several hints, the first that takes a value', () => {
      const node = p.any([small, p.int().min(0).max(1000), p.string().length(1)]).compress();
      const value = [2, 900, 'x', 'xy', 5000, true, 1, 'z'];
      expect(trip(node, value)).toEqual(value);
      expect(node._marker(900)).toBe(STRUCT.HINT);
      expect(node._marker('xy')).toBe(STRUCT.STR);
    });

    it('takes hinted values inside nested containers', () => {
      const point = p.object({ x: small, y: small });
      const node = p.any([point]).compress();
      const value = {
        list: [
          { x: 1, y: 2 },
          { x: 9, y: 0 },
        ],
        deep: new Map<AnyValue, AnyValue>([[{ x: 0, y: 0 }, new Set<AnyValue>([{ x: 3, y: 3 }])]]),
      };
      expect(trip(node, value)).toEqual(value);
    });

    it('codes a hint holding p.any', () => {
      const node = p.any([p.array(p.any())]).compress();
      const value = { a: [1, 'x', [true]] };
      expect(trip(node, value)).toEqual(value);
    });
  });

  describe('in a schema', () => {
    const value = { data: { a: [1, 'x'], b: null }, n: 3 };

    it('is reached by a compressed object, which codes its first symbol', () => {
      const node = p.object({ data: p.any(), n: p.int() }).compress();
      expect(trip(node, value)).toEqual(value);
      expect(trip(node, { data: 'text', n: 1 })).toEqual({ data: 'text', n: 1 });
      expect(trip(node, { data: [new Date(3)], n: 1 })).toEqual({ data: [new Date(3)], n: 1 });
    });

    it('keeps its own options under a compressed object', () => {
      const node = p.object({ data: p.any().compress({ window: 8 }), n: p.int() }).compress();
      expect(trip(node, value)).toEqual(value);
    });

    it('codes its own first symbol as a plain object field', () => {
      const node = p.object({ data: p.any().compress(), n: p.int() });
      expect(trip(node, value)).toEqual(value);
    });

    it('codes a hint under a compressed array', () => {
      const node = p.array(p.any([small])).compress();
      const items = [1, 'x', 2, [3]];
      expect(trip(node, items)).toEqual(items);
    });
  });
});
