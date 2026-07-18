/**
 * Schema cross-node tests — validation, corruption detection, transport, and internals.
 */

import { p, CharSets, CorruptInputError, Encoder } from '../../index';

describe('Schema validation', () => {
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
});

describe('Schema hardening', () => {
  it('rejects non-finite numbers everywhere they could hang', () => {
    expect(() => p.float().encode(Infinity)).toThrow(TypeError);
    expect(() => p.any().encode(Infinity)).toThrow(TypeError);
    expect(() => p.any().encode(NaN)).toThrow(TypeError);
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
