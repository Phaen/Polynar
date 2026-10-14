/**
 * `p.versioned()`: a schema that changes after data has been written.
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
  p.object({ version: p.int().min(0), value: node }).encode({ version, value } as never);

describe('Schema versioned', () => {
  it('a single version round-trips behind the version number', () => {
    const One = p.versioned(V1);
    expect(trip(One, { name: 'Ada' })).toEqual({ name: 'Ada' });
    expect(One.encode({ name: 'Ada' })).toEqual(Spelled(V1, 0, { name: 'Ada' }));
  });

  it('walk upgrades a value of an older version, as decode does', () => {
    const All = p.versioned(V1, [V2, toV2], [V3, (user: V2) => ({ ...user, active: true })]);
    expect(All.walk({ name: 'Ada' })).toEqual({ name: 'Ada', age: 0, active: true });
    expect(All.walk({ name: 'Ada', age: 36 }, V2)).toEqual({ name: 'Ada', age: 36, active: true });
    expect(All.walk({ name: 'Ada', age: 36, active: false }, V3)).toEqual({
      name: 'Ada',
      age: 36,
      active: false,
    });
    expect(() => All.walk({ name: 'Ada' }, p.object({ name: p.string() }))).toThrow(
      'not one of its versions'
    );
    // A node listed twice leaves it unclear which version a value is of.
    const Again = p.versioned(V1, [V2, toV2], [V1, (user: V2) => ({ name: user.name })]);
    expect(() => Again.walk({ name: 'Ada' }, V1)).toThrow('more than one version');
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
    expect(() => Old.decode(bytes)).toThrow(
      expect.objectContaining({ name: 'UnknownVersionError' })
    );
  });

  it('always writes the newest version', () => {
    const old = p.versioned(V1).encode({ name: 'Ada' });
    const again = Current.encode(Current.decode(old));
    expect(again).not.toEqual(old);
    expect(again).toEqual(Spelled(V2, 1, { name: 'Ada', age: 0 }));
  });

  it('is of the kinds of its newest version', () => {
    const Nullable = p.union([Current, p.null()]);
    expect(trip(Nullable, null)).toBeNull();
    expect(trip(Nullable, { name: 'Ada', age: 36 })).toEqual({ name: 'Ada', age: 36 });
    expect(() => p.union([Current, p.object({})])).toThrow('overlap on kind "object"');
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
      'age: Value 200 is above the maximum 120'
    );
    expect(() => p.object({ user: Current }).encode({ user: { name: 'Ada', age: 200 } })).toThrow(
      'user.age: Value 200 is above the maximum 120'
    );
  });

  const caught = (thunk: () => unknown): unknown => {
    try {
      thunk();
    } catch (e) {
      return e;
    }
    throw new Error('did not throw');
  };

  it('a migration result the newest version rejects throws, naming the versions', () => {
    const W1 = p.object({ n: p.int().min(0).max(1000) });
    const W2 = p.object({ n: p.int().min(0).max(10) });
    const S = p.versioned(W1, [W2, (prev) => ({ n: prev.n })]);
    const old = p.versioned(W1).encode({ n: 500 });
    const message = 'n: Value 500 is above the maximum 10, in data migrated from version 1 to 2';
    expect(() => S.decode(old)).toThrow(RangeError);
    expect(() => S.decode(old)).toThrow(message);
    expect(caught(() => S.decode(old))).not.toBeInstanceOf(CorruptInputError);
    expect(() => S.walk({ n: 500 })).toThrow(message);
    expect(S.decode(p.versioned(W1).encode({ n: 5 }))).toEqual({ n: 5 });
  });

  it('a bare narrower version rejects old values that no longer fit', () => {
    const Narrow = p.versioned(p.int().min(0).max(1000), p.int().min(0).max(10));
    const first = p.versioned(p.int().min(0).max(1000));
    expect(() => Narrow.decode(first.encode(500))).toThrow(
      'Value 500 is above the maximum 10, in data migrated from version 1 to 2'
    );
    expect(Narrow.decode(first.encode(5))).toBe(5);
  });

  it('every step is checked, not only the last', () => {
    const small = p.int().min(0).max(10);
    const S = p.versioned(
      small,
      [small, (v) => v + 100],
      [p.int().min(0).max(1000), (v) => v - 100]
    );
    expect(() => S.decode(p.versioned(small).encode(5))).toThrow(
      'Value 105 is above the maximum 10, in data migrated from version 1 to 2'
    );
  });

  it('a migration that throws names the step', () => {
    const Boom = p.versioned(V1, [
      V2,
      () => {
        throw new Error('boom');
      },
    ]);
    const old = p.versioned(V1).encode({ name: 'Ada' });
    expect(() => Boom.decode(old)).toThrow('boom, in migrating version 1 data to version 2');
    const e = caught(() => Boom.decode(old)) as Error;
    expect(e).toBeInstanceOf(Error);
    expect(e.constructor).toBe(Error);

    const Plain = p.versioned(V1, [
      V2,
      () => {
        throw 'boom';
      },
    ]);
    expect(caught(() => Plain.decode(old))).toBe('boom');
  });

  describe('a migrated value comes out as newest data would', () => {
    it('without removed fields', () => {
      const S = p.versioned(p.object({ a: p.int(), b: p.string() }), p.object({ a: p.int() }));
      const old = p.versioned(p.object({ a: p.int(), b: p.string() })).encode({ a: 1, b: 'x' });
      const result = S.decode(old);
      expect(result).toEqual({ a: 1 });
      expect('b' in result).toBe(false);
    });

    it('with dates floored to the precision', () => {
      const Day = p.date().precision('day');
      const S = p.versioned(p.date(), Day);
      const date = new Date('2024-05-06T13:14:15.123Z');
      const result = S.decode(p.versioned(p.date()).encode(date));
      expect(result).toEqual(trip(Day, date));
      expect(result.getTime()).not.toBe(date.getTime());
    });

    it('with minus zero as zero', () => {
      const S = p.versioned(p.int(), [p.int(), (v) => -v]);
      expect(Object.is(S.decode(p.versioned(p.int()).encode(0)), 0)).toBe(true);
    });

    it('as fresh objects every time', () => {
      const shared = [1];
      const S = p.versioned(p.int(), [p.array(p.int()), () => shared]);
      const old = p.versioned(p.int()).encode(7);
      const a = S.decode(old);
      const b = S.decode(old);
      expect(a).toEqual([1]);
      expect(a).not.toBe(shared);
      expect(b).not.toBe(shared);
      expect(a).not.toBe(b);
    });
  });

  it('a migration that returns undefined for a required field throws', () => {
    const N = p.object({ n: p.int() });
    const S = p.versioned(N, [N, (() => ({})) as never]);
    const old = p.versioned(N).encode({ n: 1 });
    expect(() => S.decode(old)).toThrow(TypeError);
    expect(() => S.decode(old)).toThrow(
      'n: Required field is missing, in data migrated from version 1 to 2'
    );
  });

  it('walk from the newest version returns the value as decoding does', () => {
    const All = p.versioned(V1, [V2, toV2], [V3, (user: V2) => ({ ...user, active: true })]);
    const value = { name: 'Ada', age: 36, active: false };
    const result = All.walk(value, V3);
    expect(result).toEqual(value);
    expect(result).not.toBe(value);
  });

  it('a nested versioned node migrates inside an outer migration', () => {
    const Inner = p.versioned(p.int().min(0).max(100), p.int().min(0).max(10));
    const Outer = p.versioned(p.object({ x: Inner }));
    const old = p
      .versioned(p.object({ x: p.versioned(p.int().min(0).max(100)) }))
      .encode({ x: 50 });
    expect(() => Outer.decode(old)).toThrow(
      'Value 50 is above the maximum 10, in data migrated from version 1 to 2'
    );
  });
});
