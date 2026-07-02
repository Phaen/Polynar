/**
 * Schema layer (`p`) — full coverage of every node, refinement, and the
 * encode/decode + encodeMany/decodeMany surface, plus normalisation/validation
 * bounds.
 */

import { p, PInt } from '../../schema';

const trip = <T>(node: { encode(v: T): Uint8Array; decode(b: Uint8Array): T }, value: T): T =>
  node.decode(node.encode(value));

describe('Schema scalars', () => {
  it('int round-trips bounded and unbounded (signed) values', () => {
    expect(trip(p.int(0, 100), 42)).toBe(42);
    expect(trip(p.int(), -12345)).toBe(-12345);
  });

  it('int truncates values toward zero and rounds bounds inward', () => {
    expect(trip(p.int(0, 100), 3.7)).toBe(3);
    expect(trip(p.int(-100, 100), -3.7)).toBe(-3);
    // fractional bounds round inward (ceil min, floor max): [1, 10] and [-5, 5]
    expect(trip(p.int(0.5, 10.5), 10)).toBe(10);
    expect(trip(p.int(-5.9, 5.9), -5)).toBe(-5);
  });

  it('int bounds round inward so the declared range is never widened', () => {
    const node = p.int().min(2.7).max(9.2); // -> [3, 9]
    expect(trip(node, 3)).toBe(3);
    expect(trip(node, 9)).toBe(9);
    expect(() => node.encode(2)).toThrow(); // 2 < 2.7
    expect(() => node.encode(10)).toThrow(); // 10 > 9.2
  });

  it('p.number is an int alias and is safe to destructure', () => {
    const { number } = p;
    const node = number(0, 10);
    expect(node).toBeInstanceOf(PInt);
    expect(trip(node, 7)).toBe(7);
  });

  it('float keeps decimals (lossy ~1e-15)', () => {
    expect(trip(p.float(), 3.14159)).toBeCloseTo(3.14159, 10);
    expect(trip(p.float().precision(1e-10), Math.PI)).toBeCloseTo(Math.PI, 9);
  });

  it('string round-trips real-world unicode and bounded lengths', () => {
    const value = 'café — line1\nline2 👋 漢字';
    expect(trip(p.string(), value)).toBe(value);
    expect(trip(p.string().max(20), 'Ada Lovelace')).toBe('Ada Lovelace');
  });

  it('string honours a custom charset', () => {
    expect(trip(p.string().charset('0123456789'), '12345')).toBe('12345');
  });

  it('bool round-trips both values', () => {
    expect(trip(p.bool(), true)).toBe(true);
    expect(trip(p.bool(), false)).toBe(false);
  });

  it('enum round-trips a member', () => {
    expect(trip(p.enum(['admin', 'user', 'guest']), 'user')).toBe('user');
  });

  it('enum rejects an empty list at construction', () => {
    expect(() => p.enum([])).toThrow(TypeError);
  });

  it('date is lossless at the default ms interval', () => {
    const d = new Date('2026-06-24T12:30:45.123Z');
    expect(trip(p.date(), d).getTime()).toBe(d.getTime());
  });

  it('date round-trips with bounds and a coarse interval', () => {
    const node = p.date(new Date('2020-01-01Z'), new Date('2021-01-01Z')).interval('day');
    const d = new Date('2020-06-15T00:00:00Z');
    expect(trip(node, d).getTime()).toBe(d.getTime());
  });

  it('any round-trips heterogeneous values', () => {
    expect(trip(p.any(), 'hello')).toBe('hello');
    expect(trip(p.any(), true)).toBe(true);
  });
});

describe('Schema objects', () => {
  const Person = p.object({
    name: p.string().max(20),
    age: p.int(0, 120),
    active: p.bool(),
    role: p.enum(['admin', 'user', 'guest']),
    bio: p.string().optional(),
  });

  it('round-trips with an optional field present and absent', () => {
    const present = { name: 'Ada', age: 36, active: true, role: 'admin' as const, bio: 'math' };
    const absent = { name: 'Ada', age: 36, active: true, role: 'user' as const };
    expect(Person.decode(Person.encode(present))).toEqual(present);
    expect(Person.decode(Person.encode(absent))).toEqual(absent);
  });

  it('preserves falsy-but-defined fields', () => {
    const value = { name: '', age: 0, active: false, role: 'guest' as const };
    expect(Person.decode(Person.encode(value))).toEqual(value);
  });

  it('round-trips nested objects', () => {
    const Schema = p.object({
      id: p.int(0, 1000),
      address: p.object({ city: p.string().max(30), zip: p.int(0, 99999) }),
    });
    const value = { id: 7, address: { city: 'London', zip: 12345 } };
    expect(Schema.decode(Schema.encode(value))).toEqual(value);
  });

  it('round-trips an any-typed field that holds an array', () => {
    const Schema = p.object({ tags: p.any(), id: p.int(0, 100) });
    const value = { tags: ['a', 'b', 'c'], id: 7 };
    expect(Schema.decode(Schema.encode(value))).toEqual(value);
  });

  it('round-trips null in an any-typed field', () => {
    // null is a value the any type carries; only undefined means absent.
    const Schema = p.object({ x: p.any() });
    expect(Schema.decode(Schema.encode({ x: null }))).toEqual({ x: null });
  });

  it('an optional nested object stays all-or-nothing and keeps its sub-fields required', () => {
    const Schema = p.object({
      inner: p.object({ a: p.int(0, 9), b: p.int(0, 9) }).optional(),
    });
    expect(Schema.decode(Schema.encode({}))).toEqual({});
    expect(Schema.decode(Schema.encode({ inner: { a: 3, b: 7 } }))).toEqual({
      inner: { a: 3, b: 7 },
    });
    expect(() => Schema.encode({ inner: { a: 1 } } as never)).toThrow();
  });
});

describe('Schema validation', () => {
  it('throws on out-of-range ints', () => {
    expect(() => p.int(0, 120).encode(150)).toThrow();
  });

  it('throws on non-finite numbers', () => {
    expect(() => p.int(0, 120).encode(NaN)).toThrow();
    expect(() => p.float().encode(Infinity)).toThrow();
  });

  it('throws when a top-level optional encodes null/undefined', () => {
    expect(() =>
      p
        .string()
        .optional()
        .encode(undefined as never)
    ).toThrow();
  });

  it('throws when an object value is not an object', () => {
    expect(() => p.object({ a: p.int(0, 9) }).encode(null as never)).toThrow(TypeError);
  });

  it('rejects an array passed where an object is expected', () => {
    expect(() => p.object({ a: p.int(0, 9) }).encode([1] as never)).toThrow(TypeError);
  });

  it('throws when an int range is empty after inward rounding', () => {
    expect(() => p.int(2.1, 2.9).encode(2)).toThrow(RangeError);
  });
});

describe('Schema v3 hardening', () => {
  it('rejects zero/negative divisors instead of hanging', () => {
    expect(() => p.float().precision(0)).not.toThrow(); // node construction is lazy
    expect(() => p.float().precision(0).encode(Math.PI)).toThrow(TypeError);
    expect(() => p.date().interval(0).encode(new Date())).toThrow(TypeError);
    expect(() => p.date().interval(-1000).encode(new Date())).toThrow(TypeError);
  });

  it('rejects non-finite numbers everywhere they could hang', () => {
    expect(() => p.float().encode(Infinity)).toThrow(TypeError);
    expect(() => p.any().encode(Infinity)).toThrow(TypeError);
    expect(() => p.any().encode(NaN)).toThrow(TypeError);
  });

  describe('p.any() round-trips the full unknown space', () => {
    const trip = <T>(v: T): T => p.any().decode(p.any().encode(v)) as T;

    it('null and undefined', () => {
      expect(trip(null)).toBeNull();
      expect(trip(undefined)).toBeUndefined();
    });

    it('arrays (empty, flat, nested, heterogeneous)', () => {
      expect(trip([])).toEqual([]);
      expect(trip([1, 2, 3])).toEqual([1, 2, 3]);
      expect(trip([1, 'two', [3, [4]], { k: 5 }])).toEqual([1, 'two', [3, [4]], { k: 5 }]);
    });

    it('non-ASCII strings and unicode object keys/values', () => {
      expect(trip('café — 漢字 👋\nline2')).toBe('café — 漢字 👋\nline2');
      expect(trip({ café: 'José', emoji: '🎉' })).toEqual({ café: 'José', emoji: '🎉' });
    });

    it('objects containing null and arrays', () => {
      const value = { tags: ['a', 'b'], parent: null, meta: { n: 1 } };
      expect(trip(value)).toEqual(value);
    });
  });

  it('a date with a non-interval-aligned min never decodes below that min', () => {
    const min = new Date('2020-06-15T12:00:00Z'); // noon — not day-aligned
    const max = new Date('2021-01-01T00:00:00Z');
    const node = p.date(min, max).interval('day');
    const decoded = node.decode(node.encode(new Date('2020-06-15T13:00:00Z')));
    expect(decoded.getTime()).toBeGreaterThanOrEqual(min.getTime());
  });

  it('a top-level optional rejects null in both encode and encodeMany', () => {
    const node = p.string().optional();
    expect(() => node.encode(undefined as never)).toThrow(TypeError);
    expect(() => node.encodeMany(['ok', null as never])).toThrow(TypeError);
  });

  it('a top-level optional round-trips present values through its inner node', () => {
    const optStr = p.string().optional();
    expect(optStr.decode(optStr.encode('here'))).toBe('here');
    expect(optStr.decodeMany(optStr.encodeMany(['a', 'b']))).toEqual(['a', 'b']);
    // The inner node's own encode override still applies, so an optional `any`
    // keeps an array whole instead of losing all but the first element.
    const optAny = p.any().optional();
    expect(optAny.decode(optAny.encode([1, 2, 3]))).toEqual([1, 2, 3]);
  });
});

describe('Schema corruption rejection', () => {
  it('decode rejects a tampered byte instead of returning plausible values', () => {
    const node = p.int(0, 100);
    const bytes = node.encode(42);
    expect(bytes).toHaveLength(1);
    // The tampered byte still yields an in-range value on read (192 % 101 =
    // 91); only the leftover-value check can tell the byte was altered.
    expect(() => node.decode(Uint8Array.of(bytes[0] + 150))).toThrow(
      'Unread or corrupted data at end of input'
    );
  });

  it('decode rejects trailing padding', () => {
    const node = p.int(0, 100);
    const padded = Uint8Array.of(...node.encode(42), 0);
    expect(() => node.decode(padded)).toThrow('Input is longer than its contents');
  });

  it('decodeMany rejects trailing padding', () => {
    const node = p.int(0, 1000);
    const padded = Uint8Array.of(...node.encodeMany([1, 2, 3]), 0);
    expect(() => node.decodeMany(padded)).toThrow('Input is longer than its contents');
  });
});

describe('Schema batch (encodeMany / decodeMany)', () => {
  it('round-trips empty, single and many batches', () => {
    const node = p.int(0, 1000);
    expect(node.decodeMany(node.encodeMany([]))).toEqual([]);
    expect(node.decodeMany(node.encodeMany([42]))).toEqual([42]);
    const many = Array.from({ length: 250 }, (_, i) => i * 3);
    expect(node.decodeMany(node.encodeMany(many))).toEqual(many);
  });

  it('round-trips a batch of objects', () => {
    const Person = p.object({ name: p.string().max(20), age: p.int(0, 120), active: p.bool() });
    const people = [
      { name: 'Ada', age: 36, active: true },
      { name: 'Linus', age: 54, active: false },
      { name: '', age: 0, active: false },
    ];
    expect(Person.decodeMany(Person.encodeMany(people))).toEqual(people);
  });

  it('is denser than per-value encode over many records', () => {
    const node = p.int(0, 7);
    const values = Array.from({ length: 500 }, (_, i) => i % 8);
    const batch = node.encodeMany(values).length;
    const individual = values.reduce((n, v) => n + node.encode(v).length, 0);
    expect(batch).toBeLessThan(individual);
  });
});

describe('Schema internals', () => {
  it('memoises options and encodes identically across calls', () => {
    const node = p.object({ a: p.int(0, 100), b: p.string().max(10) });
    const value = { a: 5, b: 'hi' };
    expect(Array.from(node.encode(value))).toEqual(Array.from(node.encode(value)));
    const intNode = p.int(0, 10);
    expect(intNode._options()).toBe(intNode._options());
  });

  it('bounded fields pack smaller than unbounded ones', () => {
    const Bounded = p.object({ a: p.int(0, 100), b: p.int(0, 7) });
    const Unbounded = p.object({ a: p.int(), b: p.int() });
    const records = Array.from({ length: 200 }, (_, i) => ({ a: i % 101, b: i % 8 }));
    const boundedBytes = records.reduce((n, r) => n + Bounded.encode(r).length, 0);
    const unboundedBytes = records.reduce((n, r) => n + Unbounded.encode(r).length, 0);
    expect(boundedBytes).toBeLessThan(unboundedBytes);
  });
});
