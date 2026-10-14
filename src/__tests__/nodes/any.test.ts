/**
 * `p.any()`: self-describing values of no declared type.
 */

import { p, Encoder, CorruptInputError, type AnyValue, type PNode } from '../../index';
import { MAX_DEPTH, TAG_PRIOR, TAG_TIERS, TAG_WINDOW } from '../../nodes/any';
import { AdaptiveTable } from '../../nodes/adaptive';
import { members } from '../../nodes/members';
import { PRecall } from '../../nodes/recall';
import { mulberry32, trip } from '../support';

/** The static tag table inside a plain `p.any`. */
const tags = () => members(TAG_TIERS.length, { weights: TAG_TIERS }, 'p.any');

/**
 * A tag table like the one inside `p.any().adaptive()`. Its counts live on
 * the encoder, so every tag written through one table bumps them as the
 * decoding node's reads do, and a hand-built message matches.
 */
const adaptiveTags = () =>
  new AdaptiveTable(TAG_TIERS, TAG_TIERS.length, TAG_PRIOR, TAG_WINDOW, 'p.any');

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

/**
 * The bytes `p.any().adaptive()` gives this value with the Unit K sequence
 * engine, pinned as a regression check of its wire format.
 */
const LEARNING_VALUE = {
  name: 'Ada',
  tags: ['x', 'y', 'x'],
  rows: [
    { id: 1, ok: true, at: null },
    { id: 2, ok: false, at: 2.5 },
  ],
  big: -12n,
};
const LEARNING_BYTES = [
  8, 32, 150, 178, 144, 32, 204, 66, 161, 84, 232, 186, 170, 114, 194, 36, 99, 22, 25, 96, 71, 158,
  171, 60, 149, 37, 60, 82, 145, 41, 34, 44, 86, 72, 138, 7, 106, 169, 212, 217, 28, 139, 96, 244,
  8,
];

/** The tags of the kinds the hand-built messages use. */
const TAG = { INT: 4, FLOAT: 5, BIGINT: 6, REGEXP: 9, OBJECT: 11, FLOAT64_ARRAY: 24 };

describe('Schema any', () => {
  it.each([
    ['p.any()', p.any()],
    ['p.any().adaptive()', p.any().adaptive()],
    ['p.any().adaptive({ window: 30 })', p.any().adaptive({ window: 30 })],
  ])('round-trips a value of every kind through %s', (_name, node) => {
    const value = everyKind();
    const back = trip(node, value) as { buffer: ArrayBuffer; view: DataView };
    expect(back).toEqual(value);
    expect([...new Uint8Array(back.buffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(back.view.buffer)]).toEqual([4, 5]);
  });

  it('keeps the pinned wire format of p.any().adaptive()', () => {
    expect([...p.any().adaptive().encode(LEARNING_VALUE)]).toEqual(LEARNING_BYTES);
    expect(p.any().adaptive().decode(Uint8Array.from(LEARNING_BYTES))).toEqual(LEARNING_VALUE);
  });

  it('spells a recurring key list again when plain, and recalls it when adaptive', () => {
    const once = [{ a: 1, b: 2 }];
    const twice = [...once, ...once];
    const extra = (node: PNode<AnyValue>) => node.encode(twice).length - node.encode(once).length;
    expect(trip(p.any(), twice)).toEqual(twice);
    expect(extra(p.any().adaptive())).toBeLessThan(extra(p.any()));
  });

  it.each([
    [0, RangeError],
    [-1, RangeError],
    [1.5, TypeError],
  ])('refuses the adaptive window %p', (window, type) => {
    expect(() => p.any().adaptive({ window })).toThrow(
      new type(`p.any adaptive window must be a positive integer, got ${window}`)
    );
  });

  it('halves its counts after the declared window', () => {
    const value = Array.from({ length: 400 }, (_, i) => (i < 200 ? 'ok' : i % 3 ? 'warn' : i));
    const windowed = p.any().adaptive({ window: 30 });
    expect(trip(windowed, value)).toEqual(value);
    expect(windowed.encode(value)).not.toEqual(p.any().adaptive().encode(value));
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

  it.each([
    ['p.any()', p.any()],
    ['p.any().adaptive()', p.any().adaptive()],
  ])('names the key of a record value %s cannot encode', (_name, node) => {
    expect(() => node.encode({ a: [Symbol('s') as never] })).toThrow(
      'a[0]: p.any cannot encode symbol values'
    );
  });

  it('packs 100 strings drawn from 3 into at most 30 bytes', () => {
    const rand = mulberry32(1);
    const statuses = Array.from({ length: 100 }, () => {
      const r = rand();
      return r < 0.9 ? 'ok' : r < 0.99 ? 'warn' : 'error';
    });
    expect(new Set(statuses).size).toBe(3);
    expect(trip(p.any().adaptive(), statuses)).toEqual(statuses);
    expect(p.any().adaptive().encode(statuses).length).toBeLessThanOrEqual(30);
  });

  it('spends about a byte per object on keys when the objects share a shape', () => {
    const objects = Array.from({ length: 20 }, (_, i) => ({ id: i, name: 'x', ok: i % 2 === 0 }));
    const tuples = objects.map(({ id, name, ok }) => [id, name, ok]);
    expect(trip(p.any().adaptive(), objects)).toEqual(objects);
    expect(p.any().adaptive().encode(objects).length).toBeLessThanOrEqual(
      p.any().adaptive().encode(tuples).length + objects.length
    );
  });

  it('spends under a bit on each boolean of a long run', () => {
    const flags = Array.from({ length: 200 }, (_, i) => i % 7 !== 0);
    expect(trip(p.any().adaptive(), flags)).toEqual(flags);
    expect(p.any().adaptive().encode(flags).length).toBeLessThan(flags.length / 8);
  });

  it('learns per node, so two nodes in one object each spell a string anew', () => {
    const value = { a: 'hello', b: 'hello' };
    const shared = p.any().adaptive();
    const together = p.object({ a: shared, b: shared });
    const apart = p.object({ a: p.any().adaptive(), b: p.any().adaptive() });
    expect(trip(together, value)).toEqual(value);
    expect(trip(apart, value)).toEqual(value);
    expect(together.encode(value).length).toBeLessThan(apart.encode(value).length);
  });

  it('copies stretches that strings share', () => {
    const value = [
      'the quick brown fox jumps over the lazy dog',
      'the quick brown cat jumps over the lazy dog',
      'a quick brown fox jumps over a lazy dog',
    ];
    expect(trip(p.any().adaptive(), value)).toEqual(value);
  });

  it('recalls a Map key among string values, and a record key apart from them', () => {
    const node = p.any().adaptive();
    const recalled = node.encode(new Map([['hello', 'hello']]));
    expect(recalled.length).toBeLessThan(node.encode(new Map([['hello', 'world']])).length);
    // Keys and values share what their characters learn, which below the
    // warm-up of contexts and repeats depends on the counts alone, so only
    // recall could tell these two apart.
    const record = { hello: 'hello' };
    expect(trip(node, record)).toEqual(record);
    expect(node.encode(record).length).toBe(node.encode({ hello: 'olleh' }).length);
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
    [2n ** 64n, 11],
    [2n ** 200n, 28],
  ])('packs the bigint %p into %p bytes', (value, bytes) => {
    expect(p.any().encode(value)).toHaveLength(bytes);
  });

  it('rejects a bigint bit count that outruns the input', () => {
    const enc = new Encoder();
    tags().write(enc, TAG.BIGINT);
    enc.composeTerm(1000);
    expect(() => p.any().decode(enc.output())).toThrow(CorruptInputError);
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
    [0, 2],
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

  /** The key-list recall a record's shape goes through, fresh for one message. */
  const shapes = () =>
    new PRecall<string[]>(
      p.array(new PRecall<string>(p.string().adaptive(), (key) => key, 'p.any key')),
      (keys) => JSON.stringify(keys),
      'p.any shape'
    );

  it('reads an adaptive record whose key list repeats a key, the last value winning', () => {
    const table = adaptiveTags();
    const enc = new Encoder();
    table.write(enc, TAG.OBJECT);
    shapes()._write(enc, ['a', 'a']);
    for (const value of [1, 2]) {
      table.write(enc, TAG.INT);
      p.int()._write(enc, value);
    }
    expect(p.any().adaptive().decode(enc.output())).toEqual({ a: 2 });
  });

  it('reads an adaptive record whose keys are out of the order an object lists them in', () => {
    const table = adaptiveTags();
    const enc = new Encoder();
    table.write(enc, TAG.OBJECT);
    shapes()._write(enc, ['b', '1']);
    for (const value of [1, 2]) {
      table.write(enc, TAG.INT);
      p.int()._write(enc, value);
    }
    expect(p.any().adaptive().decode(enc.output())).toEqual({ 1: 2, b: 1 });
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

  it.each([
    ['p.any()', () => p.any()],
    ['p.any().adaptive()', () => p.any().adaptive()],
  ])(
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
