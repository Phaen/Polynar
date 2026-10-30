/**
 * `p.object()`: records of named fields. A field whose node takes undefined
 * is optional: a missing key and an undefined value both decode as missing.
 */

import { inspect } from 'node:util';
import { loadedPriors } from '../../predictor/prior';
import { p, Decoder, Encoder, PNode, UnknownVersionError, type PObject } from '../../index';
import { STRUCT } from '../../predictor/types';
import { mulberry32, trip } from '../support';

describe('Schema object', () => {
  it("decodes a field named '__proto__' as an own property", () => {
    // Plain assignment would route the value into the prototype setter,
    // dropping the field and leaving the prototype untouched anyway.
    const Schema = p.object({ ['__proto__']: p.int().min(0).max(9) });
    const value = Object.defineProperty({}, '__proto__', {
      value: 5,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const decoded = Schema.decode(Schema.encode(value as never)) as object;
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toBe(5);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  it('leaves the key of an undefined optional field out', () => {
    const Person = p.object({ name: p.string(), bio: p.optional(p.string()) });
    expect('bio' in trip(Person, { name: 'Ada', bio: undefined })).toBe(false);
  });

  it.each([
    [
      'a union with an optional member',
      p.object({ f: p.union([p.optional(p.int()), p.string()]) }),
      'a',
    ],
    ['p.any', p.object({ f: p.any() }), [1]],
    ['a versioned optional', p.object({ f: p.versioned(p.optional(p.int())) }), 3],
    ['a lazy optional', p.object({ f: p.lazy(() => p.optional(p.string())) }), 'Ada'],
    [
      'a nullable lazy optional',
      p.object({ f: p.nullable(p.optional(p.lazy(() => p.int()))) }),
      null,
    ],
    [
      'a versioned lazy optional',
      p.object({ f: p.versioned(p.optional(p.lazy(() => p.int()))) }),
      2,
    ],
  ] as [string, PNode<{ f?: unknown }>, unknown][])(
    'takes a missing key on a field of %s',
    (_name, Schema, present) => {
      expect(Object.keys(trip(Schema, { f: undefined }))).toEqual([]);
      expect(Object.keys(trip(Schema, {}))).toEqual([]);
      expect(trip(Schema, { f: present })).toEqual({ f: present });
    }
  );
});

/** The fields of an object's shape. */
const shape = (node: PNode<any>): Record<string, PNode<any>> =>
  (node as unknown as { _shape: Record<string, PNode<any>> })._shape;

/** A node of no declared kinds that spells a number in 0..9 as one digit. */
class Digit extends PNode<number> {
  _write(enc: Encoder, value: number): void {
    enc.compose(value, 10);
  }
  _read(dec: Decoder): number {
    return dec.parse(10);
  }
}

describe('p.object().compress()', () => {
  it('round-trips strings that follow the earlier strings of their record, nested records apart', () => {
    const Event = p.object({
      user: p.string(),
      session: p.string(),
      meta: p.object({ agent: p.string(), lang: p.string() }),
    });
    const users = ['ann', 'bob', 'cy', 'dee'];
    const events = Array.from({ length: 40 }, (_, i) => {
      const u = users[(i * 7) % 4];
      return { user: u, session: `s-${u}`, meta: { agent: `ua-${u}`, lang: i % 3 ? 'en' : 'nl' } };
    });
    const node = p.array(Event).compress();
    expect(node.decode(node.encode(events))).toEqual(events);
  });

  const Item = p.object({
    name: p.string(),
    price: p.decimal(0.01).min(0),
    tags: p.array(p.string()),
  });
  const Order = p.object({
    id: p.int().min(0),
    paid: p.bool(),
    status: p.enum(['new', 'sent', 'done'] as const),
    at: p.date(),
    ratio: p.float(),
    blob: p.binary(),
    note: p.optional(p.string()),
    parent: p.nullable(p.int()),
    either: p.union([p.int(), p.string(), p.null()]),
    items: p.array(Item),
    counts: p.map(p.string(), p.int()),
    extras: p.record(p.bool()),
    seen: p.set(p.int()),
    shape: p.tagged('kind', {
      dot: p.object({}),
      line: p.object({ length: p.int().min(0) }),
    }),
    meta: p.object({ inner: p.object({ deep: p.optional(p.bool()) }) }),
    nothing: p.null(),
    anything: p.any(),
    empty: p.object({}),
  });
  type Order = Parameters<typeof Order.encode>[0];
  const order = (i: number): Order => ({
    id: i,
    paid: i % 2 === 0,
    status: (['new', 'sent', 'done'] as const)[i % 3],
    at: new Date(1_700_000_000_000 + i * 60_000),
    ratio: i / 7,
    blob: new Uint8Array([i, i + 1]),
    note: i % 3 === 0 ? undefined : `note ${i}`,
    parent: i % 4 === 0 ? null : i - 1,
    either: i % 3 === 0 ? i : i % 3 === 1 ? `s${i}` : null,
    items: Array.from({ length: i % 3 }, (_, k) => ({
      name: `item ${k}`,
      price: k + 0.25,
      tags: k ? ['a', 'b'] : [],
    })),
    counts: new Map([[`k${i}`, i]]),
    extras: { a: true, [`b${i}`]: false },
    seen: new Set([i, i + 2]),
    shape: i % 2 ? { kind: 'line', length: i } : { kind: 'dot' },
    meta: { inner: i % 2 ? { deep: true } : {} },
    nothing: null,
    anything: { i, list: [i, 'x'] },
    empty: {},
  });

  it('round-trips fields of every kind, nested objects and optional and nullable ones', () => {
    const node = Order.compress();
    for (let i = 0; i < 12; i++) {
      expect(trip(node, order(i))).toEqual(order(i));
    }
    const orders = Array.from({ length: 40 }, (_, i) => order(i));
    expect(trip(p.array(Order).compress(), orders)).toEqual(orders);
    expect(trip(p.array(node), orders)).toEqual(orders);
  });

  it('round-trips an empty object, alone and in an array', () => {
    const Empty = p.object({}).compress();
    expect(trip(Empty, {})).toEqual({});
    expect(trip(p.array(Empty), [{}, {}, {}])).toEqual([{}, {}, {}]);
  });

  it("decodes a field named '__proto__' as an own property", () => {
    const Schema = p.object({ ['__proto__']: p.int().min(0).max(9), b: p.string() }).compress();
    const value = Object.defineProperty({ b: 'x' }, '__proto__', {
      value: 5,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const decoded = Schema.decode(Schema.encode(value as never)) as object;
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toBe(5);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  it('learns a repeated shape', () => {
    const random = mulberry32(1);
    const Row = p.object({ a: p.optional(p.int().min(0).max(9)), b: p.nullable(p.bool()) });
    const rows = Array.from({ length: 300 }, () => ({
      a: random() < 0.95 ? 3 : undefined,
      b: random() < 0.95 ? null : true,
    }));
    const size = (node: PNode<any>) => {
      expect(trip(node, rows)).toEqual(rows);
      return node.encode(rows).length;
    };
    expect(size(p.array(Row).compress())).toBeLessThan(size(p.array(Row)));
  });

  it('leaves a field with .learn() or its own .compress() as it is', () => {
    const learned = p.bool().learn();
    const own = p.string().compress({ window: 8 });
    const inner = p.object({ x: p.int() }).compress({ window: 16 });
    const below = p.bool();
    const kept = p.array(below).learn();
    const node = p.object({ learned, own, inner, kept, fresh: p.int() }).compress();
    const fields = shape(node);
    expect(fields.learned).toBe(learned);
    expect(fields.own).toBe(own);
    expect(fields.inner).toBe(inner);
    expect(fields.kept).toBe(kept);
    expect(fields.fresh._compress).toEqual({ prior: loadedPriors.json.source });
    expect(node._compress).toEqual({ prior: loadedPriors.json.source });
    const value = { learned: true, own: 'a', inner: { x: 1 }, kept: [true, false], fresh: 2 };
    expect(trip(node, value)).toEqual(value);
  });

  it('leaves p.null and a custom node as they are, and adapts p.any', () => {
    const nothing = p.null();
    const anything = p.any();
    const digit = new Digit();
    const fields = shape(p.object({ nothing, anything, digit }).compress());
    expect(fields.nothing).toBe(nothing);
    expect(fields.anything._compress).toEqual({ prior: loadedPriors.json.source });
    expect(fields.digit).toBe(digit);
  });

  it('maps a node reused in two fields to one adapted node', () => {
    const point = p.object({ x: p.int(), y: p.int() });
    const node = p.object({ from: point, to: point, label: p.string() }).compress({ window: 32 });
    const fields = shape(node);
    expect(fields.from).toBe(fields.to);
    expect(fields.from).not.toBe(point);
    expect(fields.from._compress).toEqual({ window: 32, prior: loadedPriors.json.source });
    const memo = new Map<PNode<any>, PNode<any>>();
    const outer = p.object({ a: point, b: p.array(point) });
    const adapted = outer._adapted({}, memo);
    expect(memo.get(point)).toBe(shape(adapted).a);
    const value = { from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, label: 'l' };
    expect(trip(node, value)).toEqual(value);
  });

  it('returns itself from _adapted when it adapts already', () => {
    const node = p.object({ a: p.int() }).compress();
    expect(node._adapted({ window: 4 }, new Map())).toBe(node);
  });

  it('ends at a p.lazy cycle and round-trips through it', () => {
    type Tree = { v: number; kids: Tree[]; next?: Tree };
    const Tree: PNode<Tree> = p.object({
      v: p.int(),
      kids: p.array(p.lazy(() => Tree)),
      next: p.optional(p.lazy(() => Tree)),
    });
    const node = (Tree as unknown as PObject<any>).compress() as unknown as PNode<Tree>;
    const tree: Tree = {
      v: 1,
      kids: [
        { v: 2, kids: [] },
        { v: 3, kids: [{ v: 4, kids: [] }], next: { v: 5, kids: [] } },
      ],
      next: { v: 6, kids: [] },
    };
    expect(trip(node, tree)).toEqual(tree);
    expect(node.decode(node.encode(tree))).toEqual(Tree.decode(Tree.encode(tree)));
  });

  it('validates its options', () => {
    const node = p.object({ a: p.int() });
    expect(() => node.compress({ window: 0 })).toThrow(
      new RangeError('p.object: compress window must be at least 1')
    );
    expect(() => p.object({}).compress({ order: 3 })).toThrow(
      new TypeError("p.object: compress order 3 differs from the prior's order 8")
    );
    expect(() => node.compress().compress()).toThrow(
      new TypeError('p.object compress is already set')
    );
  });

  it('locates a missing required field at its key', () => {
    const node = p.object({ id: p.int(), inner: p.object({ name: p.string() }) }).compress();
    expect(() => node.encode({ inner: { name: 'x' } } as never)).toThrow(
      new TypeError('id: Required field is missing')
    );
    expect(() => node.encode({ id: 1, inner: {} } as never)).toThrow(
      new TypeError('inner.name: Required field is missing')
    );
  });

  it('locates an error reading a field at its key', () => {
    const newer = p.object({ v: p.versioned(p.int(), p.int()) });
    const older = p.object({ v: p.versioned(p.int()) });
    for (const [write, read] of [
      [newer, older],
      [newer.compress(), older.compress()],
    ]) {
      const bytes = write.encode({ v: 1 });
      expect(() => read.decode(bytes)).toThrow(UnknownVersionError);
      expect(() => read.decode(bytes)).toThrow(/^v: /);
    }
  });
});

describe('a plain object holding a compressed field', () => {
  it('holds compress where a field does, and round-trips', () => {
    const plain = p.object({ a: p.int(), b: p.string() });
    expect(plain._holdsCompress).toBe(false);
    const holding = p.object({ a: p.int(), b: p.string().compress() });
    expect(holding._holdsCompress).toBe(true);
    expect(holding._compress).toBeUndefined();
    expect(holding.compress()._holdsCompress).toBe(true);
    const value = { a: 3, b: 'hello' };
    expect(trip(holding, value)).toEqual(value);
    const rows = Array.from({ length: 30 }, (_, i) => ({ a: i, b: `row ${i % 4}` }));
    expect(trip(p.array(holding), rows)).toEqual(rows);
    expect(trip(p.array(holding).compress(), rows)).toEqual(rows);
  });

  it('codes no structure symbols of its own', () => {
    const b = p.string().compress();
    const holding = p.object({ a: p.int().min(0).max(9), b });
    const enc = new Encoder();
    p.int().min(0).max(9)._write(enc, 3);
    b._write(enc, 'hello');
    expect(holding.encode({ a: 3, b: 'hello' })).toEqual(enc.output());
  });
});

describe('p.object internals', () => {
  it('starts every value with the object marker', () => {
    const node = p.object({ a: p.int() });
    expect(node._marker()).toBe(STRUCT.OBJ_START);
    expect([...node._markers()]).toEqual([STRUCT.OBJ_START]);
  });

  it('rebuilds with other methods', () => {
    const node = p.object({ a: p.int() });
    const compress = node._withMethods({ compress: {} });
    expect(compress._compress).toEqual({});
    expect(trip(compress, { a: 1 })).toEqual({ a: 1 });
    expect(node._has('a')).toBe(true);
    expect(node._has('toString')).toBe(false);
  });
});

describe('PNode', () => {
  it('defaults a custom node', () => {
    const digit = new Digit();
    expect(inspect(digit)).toBe('Digit');
    expect(digit._takesUndefined()).toBe(true);
    expect(digit._holdsCompress).toBe(false);
    expect(digit._marker(3)).toBe(STRUCT.INT);
    expect(digit._markers()).toBeUndefined();
    expect(digit._markerPrior()).toBeUndefined();
    expect(digit.decode(digit.encode(7, { type: 'text' }), { type: 'text' })).toBe(7);
    expect(trip(p.object({ d: digit }).compress(), { d: 4 })).toEqual({ d: 4 });
  });
});
