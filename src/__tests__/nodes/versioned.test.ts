/**
 * Schema versioned node (`p.versioned()`) — a schema that changes after data
 * has been written.
 */

import { p, CorruptInputError, UnknownVersionError } from '../../index';
import type { Infer, PNode } from '../../index';
import { trip } from '../support';

const V1 = p.object({ name: p.string().max(40) });
const V2 = p.object({ name: p.string().max(40), age: p.int().min(0).max(120) });
const V3 = p.object({
  name: p.string().max(40),
  age: p.int().min(0).max(120),
  active: p.bool(),
});
type V1 = Infer<typeof V1>;
type V2 = Infer<typeof V2>;

const toV2 = (user: V1): V2 => ({ ...user, age: 0 });
const Current = p.versioned(V1, [V2, toV2]);

/** The same digits spelled as an object: the version index, then the value. */
const Spelled = <T>(node: PNode<T>, version: number, value: T): Uint8Array =>
  p.object({ version: p.int().min(0), value: node }).encode({ version, value });

describe('Schema versioned', () => {
  it('a single version round-trips behind the version number', () => {
    const One = p.versioned(V1);
    expect(trip(One, { name: 'Ada' })).toEqual({ name: 'Ada' });
    expect(One.encode({ name: 'Ada' })).toEqual(Spelled(V1, 0, { name: 'Ada' }));
  });

  it('data written by an earlier version decodes, migrated', () => {
    const old = p.versioned(V1).encode({ name: 'Ada' });
    expect(Current.decode(old)).toEqual({ name: 'Ada', age: 0 });
  });

  it('runs the migrations from the written version up, in order', () => {
    const calls: string[] = [];
    const Three = p.versioned(
      V1,
      [
        V2,
        (user) => {
          calls.push('1 to 2');
          return { ...user, age: 36 };
        },
      ],
      [
        V3,
        (user) => {
          calls.push('2 to 3');
          return { ...user, active: user.age > 0 };
        },
      ]
    );

    expect(Three.decode(p.versioned(V1).encode({ name: 'Ada' }))).toEqual({
      name: 'Ada',
      age: 36,
      active: true,
    });
    expect(calls).toEqual(['1 to 2', '2 to 3']);

    calls.length = 0;
    expect(Three.decode(Current.encode({ name: 'Ada', age: 0 }))).toEqual({
      name: 'Ada',
      age: 0,
      active: false,
    });
    expect(calls).toEqual(['2 to 3']);

    calls.length = 0;
    const now = { name: 'Ada', age: 36, active: false };
    expect(trip(Three, now)).toEqual(now);
    expect(calls).toEqual([]);
  });

  it('a bare later version reads old values as they are', () => {
    const old = p.versioned(p.int().min(0).max(100)).encode(42);
    const Wide = p.versioned(p.int().min(0).max(100), p.int().min(0).max(1000));
    expect(Wide.decode(old)).toBe(42);
    expect(trip(Wide, 500)).toBe(500);
  });

  it('data from a newer version throws UnknownVersionError', () => {
    const bytes = Current.encode({ name: 'Ada', age: 36 });
    const Old = p.versioned(V1);
    expect(() => Old.decode(bytes)).toThrow(UnknownVersionError);
    expect(() => Old.decode(bytes)).toThrow(CorruptInputError);
    expect(() => Old.decode(bytes)).toThrow('Data was written by version 2; this schema knows 1');
  });

  it('always writes the newest version', () => {
    const old = p.versioned(V1).encode({ name: 'Ada' });
    const again = Current.encode(Current.decode(old));
    expect(again).not.toEqual(old);
    expect(again).toEqual(Spelled(V2, 1, { name: 'Ada', age: 0 }));
  });

  it('composes like its newest version', () => {
    const Doc = p.object({ id: p.int(), owner: Current, editor: p.optional(Current) });
    const ada = { name: 'Ada', age: 36 };
    expect(trip(Doc, { id: 1, owner: ada })).toEqual({ id: 1, owner: ada });
    expect(trip(Doc, { id: 1, owner: ada, editor: ada })).toEqual({
      id: 1,
      owner: ada,
      editor: ada,
    });

    expect(trip(p.array(Current), [ada, { name: 'Bob', age: 7 }])).toEqual([
      ada,
      { name: 'Bob', age: 7 },
    ]);

    const Nullable = p.union([Current, p.null()]);
    expect(trip(Nullable, null)).toBeNull();
    expect(trip(Nullable, ada)).toEqual(ada);
    expect(() => p.union([Current, p.object({})])).toThrow("overlap on kind 'object'");
  });

  it('has no kinds when its newest version has none', () => {
    expect(() => p.union([p.versioned(p.lazy(() => p.string())), p.null()])).toThrow(
      'must declare their kinds'
    );
  });

  it('wraps a tagged union', () => {
    const Op1 = p.tagged('type', { move: p.object({ x: p.int(), y: p.int() }) });
    const Op2 = p.tagged('type', {
      move: p.object({ x: p.int(), y: p.int() }),
      chat: p.object({ text: p.string().max(200) }),
    });
    const Ops = p.versioned(Op1, Op2);
    const old = p.versioned(Op1).encode({ type: 'move', x: 1, y: 2 });
    expect(Ops.decode(old)).toEqual({ type: 'move', x: 1, y: 2 });
    expect(trip(Ops, { type: 'chat', text: 'hi' })).toEqual({ type: 'chat', text: 'hi' });
  });

  it('an error inside the chosen version keeps its path', () => {
    expect(() => Current.encode({ name: 'Ada', age: 200 })).toThrow(
      "age: Value '200' is above the maximum 120"
    );
    expect(() => p.object({ user: Current }).encode({ user: { name: 'Ada', age: 200 } })).toThrow(
      "user.age: Value '200' is above the maximum 120"
    );
  });
});
