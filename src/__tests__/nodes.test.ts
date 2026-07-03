/**
 * Schema nodes (`p`) — full coverage of every node, refinement, and the
 * encode/decode + encodeString/decodeString surface, plus validation bounds.
 */

import { p, CharSets, CorruptInputError, Encoder } from '../index';

const trip = <T>(node: { encode(v: T): Uint8Array; decode(b: Uint8Array): T }, value: T): T =>
  node.decode(node.encode(value));

describe('Schema scalars', () => {
  it('int round-trips bounded and unbounded (signed) values', () => {
    expect(trip(p.int().min(0).max(100), 42)).toBe(42);
    expect(trip(p.int(), -12345)).toBe(-12345);
  });

  it('int rejects non-integer values instead of truncating', () => {
    // Strict like every other node: truncation would silently lose data.
    expect(() => p.int().encode(3.7)).toThrow(TypeError);
    expect(() => p.int().min(0).max(100).encode(-3.7)).toThrow(TypeError);
  });

  it('int rounds fractional bounds inward', () => {
    // ceil the min, floor the max: [0.5, 10.5] admits [1, 10]
    expect(trip(p.int().min(0.5).max(10.5), 10)).toBe(10);
    expect(trip(p.int().min(-5.9).max(5.9), -5)).toBe(-5);
    expect(() => p.int().min(0.5).encode(0)).toThrow(RangeError);
  });

  it('int bounds round inward so the declared range is never widened', () => {
    const node = p.int().min(2.7).max(9.2); // -> [3, 9]
    expect(trip(node, 3)).toBe(3);
    expect(trip(node, 9)).toBe(9);
    expect(() => node.encode(2)).toThrow(); // 2 < 2.7
    expect(() => node.encode(10)).toThrow(); // 10 > 9.2
  });

  it('int round-trips unbounded values above 2^53 bit-exact', () => {
    expect(trip(p.int(), 18014398509481988)).toBe(18014398509481988);
    expect(trip(p.int(), -1e300)).toBe(-1e300);
  });

  it('int encodes -0 as plain zero', () => {
    expect(Object.is(trip(p.int(), -0), 0)).toBe(true);
    expect(Object.is(trip(p.int().min(-5).max(5), -0), 0)).toBe(true);
  });

  it('decimal round-trips grid values bit-exact, including the float traps', () => {
    const cents = p.decimal(0.01).min(0).max(100);
    // 0.07, 0.29 and 3.14 are classic drift cases under raw float division
    // (0.29/0.01 = 28.999...); the scaled-integer path must return them
    // identically, not as a close neighbour.
    for (const value of [0, 0.07, 0.29, 3.14, 99.99, 100]) {
      expect(trip(cents, value)).toBe(value);
    }
    expect(trip(p.decimal(0.1), 0.3)).toBe(0.3);
    expect(trip(p.decimal(0.1), -12.7)).toBe(-12.7);
  });

  it('decimal accepts coarse and integer steps', () => {
    expect(trip(p.decimal(0.5).min(-2).max(2), -1.5)).toBe(-1.5);
    expect(trip(p.decimal(5).min(0).max(100), 35)).toBe(35);
  });

  it('decimal spends only what the step and bounds allow', () => {
    // 0..100 in cents is 10001 states — 2 bytes, where p.float is a flat 8.
    expect(p.decimal(0.01).min(0).max(100).encode(3.14)).toHaveLength(2);
    expect(p.float().encode(3.14)).toHaveLength(8);
  });

  it('decimal rejects off-grid values instead of snapping', () => {
    expect(() => p.decimal(0.01).encode(0.005)).toThrow('not a multiple of step');
    expect(() => p.decimal(0.01).encode(0.123)).toThrow('not a multiple of step');
    expect(() => p.decimal(0.1).encode(0.35)).toThrow('not a multiple of step');
  });

  it('decimal enforces bounds and rounds off-grid bounds inward', () => {
    expect(() => p.decimal(0.01).min(0).max(100).encode(100.01)).toThrow(RangeError);
    // Bounds of [0.3, 2.2] on a 0.5 step admit only 0.5..2.0; the bounds
    // themselves are off-grid and must not become encodable.
    const node = p.decimal(0.5).min(0.3).max(2.2);
    expect(trip(node, 0.5)).toBe(0.5);
    expect(trip(node, 2)).toBe(2);
    expect(() => node.encode(0.3)).toThrow('not a multiple of step');
    expect(() => node.encode(2.2)).toThrow('not a multiple of step');
  });

  it('decimal rejects invalid steps and empty ranges at construction', () => {
    expect(() => p.decimal(0)).toThrow(TypeError);
    expect(() => p.decimal(-0.1)).toThrow(TypeError);
    // 1/3 has no finite decimal form, so no value could ever sit on its grid.
    expect(() => p.decimal(1 / 3)).toThrow(TypeError);
    // No multiple of 0.5 lies in [0.6, 0.9].
    expect(() => p.decimal(0.5).min(0.6).max(0.9)).toThrow(RangeError);
  });

  it('float round-trips every finite double bit-exact', () => {
    for (const value of [Math.PI, 0.1 + 0.2, -2.5, 7, 1e300, Number.EPSILON]) {
      expect(trip(p.float(), value)).toBe(value);
    }
  });

  it('float round-trips the edges of the double space', () => {
    expect(trip(p.float(), Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    expect(trip(p.float(), Number.MIN_VALUE)).toBe(Number.MIN_VALUE); // subnormal
    expect(Object.is(trip(p.float(), -0), -0)).toBe(true); // sign bit survives
  });

  it('string round-trips real-world unicode and bounded lengths', () => {
    const value = 'café — line1\nline2 👋 漢字';
    expect(trip(p.string(), value)).toBe(value);
    expect(trip(p.string().max(20), 'Ada Lovelace')).toBe('Ada Lovelace');
  });

  it('string honours a custom charset', () => {
    expect(trip(p.string().charset('0123456789'), '12345')).toBe('12345');
  });

  it('string rejects a value outside its charset', () => {
    expect(() => p.string().charset('0123456789').encode('12a')).toThrow(
      'String not compliant with character set'
    );
  });

  it('string rejects a value longer than its max', () => {
    expect(() => p.string().max(3).encode('long')).toThrow(RangeError);
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

  it('enum rejects a value not in its list', () => {
    expect(() => p.enum(['a', 'b']).encode('c' as never)).toThrow("'c' not found in list");
  });

  it('enum accepts any primitive literals', () => {
    expect(trip(p.enum([256, 512, 1024]), 512)).toBe(512);
    expect(trip(p.enum([true, false]), false)).toBe(false);
    expect(trip(p.enum(['on', 0.5, false]), 0.5)).toBe(0.5);
  });

  it('enum matches members by identity, so any stable reference works', () => {
    // The wire carries an index into the shared list, so decode hands back
    // the listed member itself: objects and functions included.
    const strategies = [{ retries: 0 }, { retries: 5 }];
    const Strategy = p.enum(strategies);
    expect(trip(Strategy, strategies[1])).toBe(strategies[1]);
    expect(() => Strategy.encode({ retries: 5 })).toThrow('not found in list');

    const Rounding = p.enum([Math.floor, Math.ceil, Math.round]);
    expect(trip(Rounding, Math.ceil)).toBe(Math.ceil);
  });

  it('enum rejects NaN and duplicate members at construction', () => {
    // NaN never equals itself under the === that indexOf uses, so a NaN
    // member could never be encoded; a duplicate is unreachable behind its
    // first occurrence and inflates the radix every value pays for.
    expect(() => p.enum([1, NaN])).toThrow(TypeError);
    expect(() => p.enum(['a', 'a'])).toThrow(TypeError);
    expect(() => p.enum([0, -0])).toThrow(TypeError);
    const shared = { retries: 0 };
    expect(() => p.enum([shared, shared])).toThrow(TypeError);
  });

  it('date is lossless at the default ms interval', () => {
    const d = new Date('2026-06-24T12:30:45.123Z');
    expect(trip(p.date(), d).getTime()).toBe(d.getTime());
    const before1970 = new Date('1955-11-05T06:00:00.000Z');
    expect(trip(p.date(), before1970).getTime()).toBe(before1970.getTime());
  });

  it('date round-trips with bounds and a coarse interval', () => {
    const node = p.date().min(new Date('2020-01-01Z')).max(new Date('2021-01-01Z')).interval('day');
    const d = new Date('2020-06-15T00:00:00Z');
    expect(trip(node, d).getTime()).toBe(d.getTime());
  });

  it('date enforces its bounds and rejects non-dates', () => {
    const node = p.date().min(new Date('2020-01-01Z')).max(new Date('2021-01-01Z'));
    expect(() => node.encode(new Date('2019-12-31Z'))).toThrow('before the minimum bound');
    expect(() => node.encode(new Date('2021-01-02Z'))).toThrow('after the maximum bound');
    expect(() => node.encode(new Date(NaN))).toThrow(TypeError);
    expect(() => p.date().encode('2020-01-01' as never)).toThrow(TypeError);
  });

  it('date rejects an unknown interval name and swapped bounds at construction', () => {
    expect(() => p.date().interval('fortnight' as never)).toThrow('Invalid date interval');
    expect(() => p.date().min(new Date('2021-01-01Z')).max(new Date('2020-01-01Z'))).toThrow(
      RangeError
    );
  });

  it('any round-trips heterogeneous values', () => {
    expect(trip(p.any(), 'hello')).toBe('hello');
    expect(trip(p.any(), true)).toBe(true);
  });
});

describe('Schema objects', () => {
  const Person = p.object({
    name: p.string().max(20),
    age: p.int().min(0).max(120),
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
      id: p.int().min(0).max(1000),
      address: p.object({ city: p.string().max(30), zip: p.int().min(0).max(99999) }),
    });
    const value = { id: 7, address: { city: 'London', zip: 12345 } };
    expect(Schema.decode(Schema.encode(value))).toEqual(value);
  });

  it('round-trips an any-typed field that holds an array', () => {
    const Schema = p.object({ tags: p.any(), id: p.int().min(0).max(100) });
    const value = { tags: ['a', 'b', 'c'], id: 7 };
    expect(Schema.decode(Schema.encode(value))).toEqual(value);
  });

  it('round-trips null in an any-typed field', () => {
    // null is a value the any type carries; only undefined means absent.
    const Schema = p.object({ x: p.any() });
    expect(Schema.decode(Schema.encode({ x: null }))).toEqual({ x: null });
  });

  it("decodes a field named '__proto__' as an own property", () => {
    // Plain assignment would route the value into the prototype setter,
    // silently dropping the field and leaving the prototype untouched anyway.
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

  it('an optional nested object stays all-or-nothing and keeps its sub-fields required', () => {
    const Schema = p.object({
      inner: p.object({ a: p.int().min(0).max(9), b: p.int().min(0).max(9) }).optional(),
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
    expect(() => p.int().min(0).max(120).encode(150)).toThrow();
  });

  it('throws on non-finite numbers', () => {
    expect(() => p.int().min(0).max(120).encode(NaN)).toThrow();
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
    expect(() => p.object({ a: p.int().min(0).max(9) }).encode(null as never)).toThrow(TypeError);
  });

  it('rejects an array passed where an object is expected', () => {
    expect(() => p.object({ a: p.int().min(0).max(9) }).encode([1] as never)).toThrow(TypeError);
  });

  it('throws at construction when an int range is empty after inward rounding', () => {
    // Config errors surface where the schema is DEFINED, not on first use.
    expect(() => p.int().min(2.1).max(2.9)).toThrow(RangeError);
  });

  it('refuses values too far from a lone bound to index exactly', () => {
    // The offset against the bound is float arithmetic; past 2^53 it rounds
    // to a neighbouring integer, so encoding must throw rather than drift.
    expect(() =>
      p
        .int()
        .max(1)
        .encode(-(2 ** 53))
    ).toThrow('too far from its bound to encode exactly');
    // The largest exactly indexable offset still round-trips.
    expect(
      p
        .int()
        .min(1)
        .decode(
          p
            .int()
            .min(1)
            .encode(2 ** 53)
        )
    ).toBe(2 ** 53);
  });

  it('rejects bounded ranges wider than exact integer arithmetic supports', () => {
    expect(() =>
      p
        .int()
        .min(-(2 ** 53))
        .max(2 ** 53)
    ).toThrow(RangeError);
    expect(() =>
      p
        .decimal(1)
        .min(-(2 ** 53))
        .max(2 ** 53)
    ).toThrow(RangeError);
  });

  it('date quantization refuses drift instead of shifting a millisecond', () => {
    // An odd millisecond offset past 2^53 has no exact float representation;
    // the reconstruction check turns the drift into an error, per value.
    const extreme = p.date().min(new Date(-8.6e15));
    expect(() => extreme.encode(new Date(8.6e15 + 1))).toThrow('quantize exactly');
    // The same spread is fine at a coarser interval, in any refinement order.
    // The min is day-aligned, so a midnight date sits on the anchored grid.
    const daily = p.date().min(new Date(-8.64e15)).max(new Date(8.64e15)).interval('day');
    const d = new Date('2020-06-15T00:00:00Z');
    expect(daily.decode(daily.encode(d)).getTime()).toBe(d.getTime());
  });
});

describe('Schema hardening', () => {
  it('rejects zero/negative divisors at construction instead of hanging', () => {
    expect(() => p.date().interval(0)).toThrow(TypeError);
    expect(() => p.date().interval(-1000)).toThrow(TypeError);
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

    it('shared references encode as copies; cycles throw instead of overflowing', () => {
      const shared = { n: 1 };
      expect(trip({ a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } });

      const loop: Record<string, unknown> = {};
      loop.self = loop;
      expect(() => p.any().encode(loop)).toThrow('circular');
      const ring: unknown[] = [];
      ring.push(ring);
      expect(() => p.any().encode(ring)).toThrow('circular');
    });
  });

  it('a date with a non-interval-aligned min never decodes below that min', () => {
    const min = new Date('2020-06-15T12:00:00Z'); // noon — not day-aligned
    const max = new Date('2021-01-01T00:00:00Z');
    const node = p.date().min(min).max(max).interval('day');
    const decoded = node.decode(node.encode(new Date('2020-06-15T13:00:00Z')));
    expect(decoded.getTime()).toBeGreaterThanOrEqual(min.getTime());
  });

  it('a top-level optional rejects null and undefined', () => {
    const node = p.string().optional();
    expect(() => node.encode(undefined as never)).toThrow(TypeError);
    expect(() => node.encode(null as never)).toThrow(TypeError);
  });

  it('a top-level optional round-trips present values through its inner node', () => {
    const optStr = p.string().optional();
    expect(optStr.decode(optStr.encode('here'))).toBe('here');
    // The wrapper delegates the whole codec to its inner node, so an optional
    // `any` keeps an array whole instead of losing all but the first element.
    const optAny = p.any().optional();
    expect(optAny.decode(optAny.encode([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it('any round-trips every number shape bit-exact', () => {
    // Integers travel through the cheap term path, everything else through
    // the flat IEEE-754 path — both exact, split by a type tag.
    expect(trip(p.any(), 18014398509481988 as unknown)).toBe(18014398509481988);
    expect(trip(p.any(), -12345 as unknown)).toBe(-12345);
    expect(trip(p.any(), Math.PI as unknown)).toBe(Math.PI);
    expect(trip(p.any(), 0.1 as unknown)).toBe(0.1);
    expect(Object.is(trip(p.any(), -0 as unknown), -0)).toBe(true);
  });
});

describe('Schema corruption rejection', () => {
  it('decode rejects a tampered byte instead of returning plausible values', () => {
    const node = p.int().min(0).max(100);
    const bytes = node.encode(42);
    expect(bytes).toHaveLength(1);
    // The tampered byte still yields an in-range value on read (192 % 101 =
    // 91); only the leftover-value check can tell the byte was altered.
    expect(() => node.decode(Uint8Array.of(bytes[0] + 150))).toThrow(
      'Unread or corrupted data at end of input'
    );
  });

  it('decode rejects trailing padding', () => {
    const node = p.int().min(0).max(100);
    const padded = Uint8Array.of(...node.encode(42), 0);
    expect(() => node.decode(padded)).toThrow('Input is longer than its contents');
  });

  it('array decode rejects trailing padding', () => {
    const node = p.array(p.int().min(0).max(1000));
    const padded = Uint8Array.of(...node.encode([1, 2, 3]), 0);
    expect(() => node.decode(padded)).toThrow('Input is longer than its contents');
  });

  it('every corruption failure is one catchable CorruptInputError', () => {
    // The class separates "bad input" from "bug" at an untrusted-input
    // boundary; its name doubles as the discriminant where instanceof cannot
    // reach (two package copies in one process).
    const node = p.int().min(0).max(100);
    const tampered = Uint8Array.of(node.encode(42)[0] + 150);
    const padded = Uint8Array.of(...node.encode(42), 0);
    expect(() => node.decode(tampered)).toThrow(CorruptInputError);
    expect(() => node.decode(padded)).toThrow(CorruptInputError);
    expect(() => node.decode(new Uint8Array(0))).toThrow(CorruptInputError);
    expect(() => node.decodeString('!', CharSets.digit)).toThrow(CorruptInputError);
    try {
      node.decode(padded);
    } catch (e) {
      expect((e as Error).name).toBe('CorruptInputError');
    }
    // Caller bugs stay ordinary errors: a bad VALUE is not corrupt input.
    expect(() => node.encode(3.7)).not.toThrow(CorruptInputError);
  });

  it('signed values reject a negative zero the encoder never emits', () => {
    // A set sign bit with a zero magnitude is a representable digit pattern
    // but not a canonical encoding, so it must read as corruption — not -0.
    // (p.float is exempt: IEEE -0 is a real, distinct double there.)
    const signedZero = (): Uint8Array => {
      const enc = new Encoder();
      enc.compose(1, 2);
      enc.composeTerm(0);
      return enc.toUint8Array();
    };
    expect(() => p.int().decode(signedZero())).toThrow('Non-canonical negative zero');
    expect(() => p.decimal(0.01).decode(signedZero())).toThrow('Non-canonical negative zero');
    expect(() => p.date().decode(signedZero())).toThrow('Non-canonical negative zero');
  });

  it('rejects wire states no encoder emits: mistagged and unencodable values', () => {
    // Each of these decodes to a plausible value whose re-encode would differ
    // from its bytes: a second spelling, which canonical closure forbids.
    // A float-tagged integer: integers always travel under the int tag.
    const tagged = new Encoder();
    tagged.compose(4, 9); // TAG_FLOAT
    p.float()._write(tagged, 42);
    expect(() => p.any().decode(tagged.toUint8Array())).toThrow(
      'Non-canonical float tag on an integer value'
    );
    // An undefined-tagged required object field: undefined marks absence on
    // encode, so no object can carry it as a value.
    const field = new Encoder();
    field.compose(0, 9); // TAG_UNDEFINED
    expect(() => p.object({ a: p.any() }).decode(field.toUint8Array())).toThrow(
      'decoded as undefined'
    );
  });

  it('rejects a term offset that cannot reconstruct exactly', () => {
    // min + offset rounds past 2^53, so the encoder could never have emitted
    // it; accepting it would decode a value that re-encodes differently.
    const enc = new Encoder();
    enc.composeTerm(2 ** 53);
    expect(() => p.int().min(1).decode(enc.toUint8Array())).toThrow(CorruptInputError);
  });

  it('rejects a step multiple that cannot reconstruct exactly', () => {
    // The multiple itself is a valid term, but scaled by the step it rounds
    // past 2^53, so dividing it back out would decode a neighbouring value
    // the encoder rejects.
    const enc = new Encoder();
    enc.compose(0, 2);
    enc.composeTerm(2 ** 60);
    expect(() => p.decimal(0.01).decode(enc.toUint8Array())).toThrow(CorruptInputError);
  });
});

describe('Schema arrays (p.array)', () => {
  it('round-trips empty, single and many elements', () => {
    const node = p.array(p.int().min(0).max(1000));
    expect(node.decode(node.encode([]))).toEqual([]);
    expect(node.decode(node.encode([42]))).toEqual([42]);
    const many = Array.from({ length: 250 }, (_, i) => i * 3);
    expect(node.decode(node.encode(many))).toEqual(many);
  });

  it('round-trips an array of objects', () => {
    const People = p.array(
      p.object({ name: p.string().max(20), age: p.int().min(0).max(120), active: p.bool() })
    );
    const people = [
      { name: 'Ada', age: 36, active: true },
      { name: 'Linus', age: 54, active: false },
      { name: '', age: 0, active: false },
    ];
    expect(People.decode(People.encode(people))).toEqual(people);
  });

  it('works as an object field, required and optional', () => {
    const Schema = p.object({
      id: p.int().min(0).max(100),
      tags: p.array(p.enum(['a', 'b', 'c'])),
      scores: p.array(p.int().min(0).max(10)).optional(),
    });
    const full = { id: 7, tags: ['a', 'c'] as ('a' | 'b' | 'c')[], scores: [1, 2, 3] };
    const bare = { id: 7, tags: [] as ('a' | 'b' | 'c')[] };
    expect(Schema.decode(Schema.encode(full))).toEqual(full);
    expect(Schema.decode(Schema.encode(bare))).toEqual(bare);
  });

  it('nests without extra ceremony', () => {
    const Grid = p.array(p.array(p.int().min(0).max(9)));
    const value = [[1, 2], [], [3, 4, 5]];
    expect(Grid.decode(Grid.encode(value))).toEqual(value);
  });

  it('carries heterogeneous any-typed elements, arrays included', () => {
    // Each element is one self-described `any` value, so an element that is
    // itself an array stays a single element instead of spreading.
    const node = p.array(p.any());
    const value = [1, 'two', [3, [4]], { k: 5 }, null];
    expect(node.decode(node.encode(value))).toEqual(value);
  });

  it('caps the count with max and packs the capped prefix denser', () => {
    const capped = p.array(p.int().min(0).max(9)).max(4);
    expect(capped.decode(capped.encode([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(() => capped.encode([1, 2, 3, 4, 5])).toThrow('Array length exceeds maximum');
    const uncapped = p.array(p.int().min(0).max(9));
    expect(capped.encode([1, 2, 3]).length).toBeLessThanOrEqual(uncapped.encode([1, 2, 3]).length);
  });

  it('rounds a fractional max inward and rejects invalid caps', () => {
    const node = p.array(p.int().min(0).max(9)).max(2.9); // -> cap of 2
    expect(node.decode(node.encode([1, 2]))).toEqual([1, 2]);
    expect(() => node.encode([1, 2, 3])).toThrow('Array length exceeds maximum');
    expect(() => p.array(p.int()).max(-1)).toThrow(RangeError);
    expect(() => p.array(p.int()).max(NaN)).toThrow(RangeError);
  });

  it('min bounds the count from below and combines with max', () => {
    const node = p.array(p.int().min(0).max(9)).min(2).max(4);
    expect(node.decode(node.encode([1, 2]))).toEqual([1, 2]);
    expect(node.decode(node.encode([1, 2, 3, 4]))).toEqual([1, 2, 3, 4]);
    expect(() => node.encode([1])).toThrow('Array length is below the minimum');
    expect(() => node.encode([1, 2, 3, 4, 5])).toThrow('Array length exceeds maximum');
    expect(() => p.array(p.int()).min(5).max(2)).toThrow(RangeError);
    expect(() => p.array(p.int()).min(-1)).toThrow(RangeError);
  });

  it('length fixes the count, which then costs zero wire bits', () => {
    const node = p.array(p.bool()).length(40);
    const value = Array.from({ length: 40 }, (_, i) => i % 3 === 0);
    expect(node.decode(node.encode(value))).toEqual(value);
    // 40 booleans are exactly 40 bits; the fixed count adds none: 5 bytes.
    expect(node.encode(value)).toHaveLength(5);
  });

  it('length rejects any other count, in both directions', () => {
    const node = p.array(p.int().min(0).max(9)).length(3);
    expect(node.decode(node.encode([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(() => node.encode([1, 2])).toThrow('differs from the fixed length');
    expect(() => node.encode([1, 2, 3, 4])).toThrow('differs from the fixed length');
  });

  it('length(0) admits only the empty array — and encodes it as nothing at all', () => {
    const node = p.array(p.int()).length(0);
    expect(node.decode(node.encode([]))).toEqual([]);
    expect(node.encode([])).toHaveLength(0);
    expect(() => node.encode([1])).toThrow('differs from the fixed length');
  });

  it('length refuses to combine with min or max, in either order', () => {
    expect(() => p.array(p.int()).length(3).min(1)).toThrow(TypeError);
    expect(() => p.array(p.int()).length(3).max(5)).toThrow(TypeError);
    expect(() => p.array(p.int()).min(1).length(3)).toThrow(TypeError);
    expect(() => p.array(p.int()).max(5).length(3)).toThrow(TypeError);
  });

  it('length must be an exact non-negative integer', () => {
    // No inward rounding: no count satisfies a fractional length, so rounding
    // would invent a contract that was never declared.
    expect(() => p.array(p.int()).length(2.9)).toThrow(RangeError);
    expect(() => p.array(p.int()).length(-1)).toThrow(RangeError);
    expect(() => p.array(p.int()).length(NaN)).toThrow(RangeError);
  });

  it('rejects an optional item type at construction', () => {
    // The presence bit only exists for object fields; an array slot is always
    // occupied. The array itself can be optional instead.
    expect(() => p.array(p.string().optional() as never)).toThrow(TypeError);
  });

  it('rejects a non-array value at encode', () => {
    expect(() => p.array(p.int().min(0).max(9)).encode('nope' as never)).toThrow(TypeError);
  });

  it('is denser than per-value encode over many records', () => {
    const node = p.int().min(0).max(7);
    const values = Array.from({ length: 500 }, (_, i) => i % 8);
    const batch = p.array(node).encode(values).length;
    const individual = values.reduce((n, v) => n + node.encode(v).length, 0);
    expect(batch).toBeLessThan(individual);
  });
});

describe('String output (encodeString / decodeString)', () => {
  const Player = p.object({
    name: p.string().max(20),
    level: p.int().min(1).max(99),
    tags: p.array(p.enum(['a', 'b', 'c'])),
  });
  const value = { name: 'Ada', level: 42, tags: ['a', 'c'] as ('a' | 'b' | 'c')[] };

  it('round-trips through the default Base64 charset', () => {
    expect(Player.decodeString(Player.encodeString(value))).toEqual(value);
  });

  it('round-trips through a chosen charset', () => {
    const urlSafe = Player.encodeString(value, CharSets.urlSafe);
    expect(Player.decodeString(urlSafe, CharSets.urlSafe)).toEqual(value);
    const hex = Player.encodeString(value, CharSets.hex);
    expect(Player.decodeString(hex, CharSets.hex)).toEqual(value);
  });

  it('emits only characters from the chosen charset', () => {
    const str = p.string().encodeString('any text at all — 👋', CharSets.digit);
    expect(str).toMatch(/^[0-9]+$/);
  });

  it('rejects trailing padding like the byte form does', () => {
    const str = p.int().min(0).max(100).encodeString(42);
    expect(() =>
      p
        .int()
        .min(0)
        .max(100)
        .decodeString(str + 'AA')
    ).toThrow('Input is longer than its contents');
  });
});

describe('Schema internals', () => {
  it('encodes identically across calls', () => {
    const node = p.object({ a: p.int().min(0).max(100), b: p.string().max(10) });
    const value = { a: 5, b: 'hi' };
    expect(Array.from(node.encode(value))).toEqual(Array.from(node.encode(value)));
  });

  it('bounded fields pack smaller than unbounded ones', () => {
    const Bounded = p.object({ a: p.int().min(0).max(100), b: p.int().min(0).max(7) });
    const Unbounded = p.object({ a: p.int(), b: p.int() });
    const records = Array.from({ length: 200 }, (_, i) => ({ a: i % 101, b: i % 8 }));
    const boundedBytes = records.reduce((n, r) => n + Bounded.encode(r).length, 0);
    const unboundedBytes = records.reduce((n, r) => n + Unbounded.encode(r).length, 0);
    expect(boundedBytes).toBeLessThan(unboundedBytes);
  });

  it('rejects a shape whose field is not a schema node', () => {
    expect(() => p.object({ a: 5 as never })).toThrow(TypeError);
  });
});
