/**
 * Schema cross-node tests — validation, corruption detection, transport, and internals.
 */

import { p, CharSets, CorruptInputError, Encoder, PNode } from '../../index';

describe('Schema validation', () => {
  it('throws on non-finite numbers', () => {
    expect(() => p.int().min(0).max(120).encode(NaN)).toThrow();
    expect(() => p.float().encode(Infinity)).toThrow();
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

  it('a top-level optional round-trips present values through its inner node', () => {
    const optStr = p.optional(p.string());
    expect(optStr.decode(optStr.encode('here'))).toBe('here');
    // An optional `any` keeps an array whole instead of losing all but the
    // first element.
    const optAny = p.optional(p.any());
    expect(optAny.decode(optAny.encode([1, 2, 3]))).toEqual([1, 2, 3]);
    // Only undefined means absent; null reaches the inner node.
    expect(optAny.decode(optAny.encode(null))).toBeNull();
  });

  it('a top-level optional spends one bit on undefined, or less with weights', () => {
    const optInt = p.optional(p.int());
    expect(optInt.decode(optInt.encode(1))).toBe(1);
    expect(optInt.decode(optInt.encode(undefined))).toBeUndefined();
    expect(optInt.encode(undefined)).toEqual(p.bool().encode(false));
    const likely = p.optional(p.int().min(0).max(9)).weights([1, 99]);
    expect(likely.decode(likely.encode(4))).toBe(4);
    expect(likely.decode(likely.encode(undefined))).toBeUndefined();
    const many = Array.from({ length: 50 }, () => 4);
    expect(p.array(likely).encode(many).length).toBeLessThan(
      p.array(p.optional(p.int().min(0).max(9))).encode(many).length
    );
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
    // A present optional whose inner `any` reads its undefined tag: undefined
    // is spelled by the absent bit alone.
    const present = new Encoder();
    present.compose(1, 2);
    present.compose(0, 9); // TAG_UNDEFINED
    expect(() => p.optional(p.any()).decode(present.toUint8Array())).toThrow(CorruptInputError);
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

describe('Byte output (encode / decode with a range)', () => {
  const Player = p.object({ name: p.string().max(20), level: p.int().min(1).max(99) });
  const value = { name: 'Ada', level: 42 };

  it('round-trips through a restricted range', () => {
    const bytes = Player.encode(value, [32, 126]);
    expect(Player.decode(bytes, [32, 126])).toEqual(value);
  });

  it('emits only bytes from the range', () => {
    const bytes = Player.encode(value, [32, 126]);
    expect(bytes.every((b) => b >= 32 && b <= 126)).toBe(true);
  });

  it('spends no fewer bytes than the full range does', () => {
    const long = { name: 'a'.repeat(20), level: 42 };
    expect(Player.encode(long, [32, 126]).length).toBeGreaterThan(Player.encode(long).length);
    expect(Player.encode(value, [32, 126]).length).toBeGreaterThanOrEqual(
      Player.encode(value).length
    );
  });

  it('rejects a range the encoder would not have produced', () => {
    const bytes = Player.encode(value, [32, 126]);
    expect(() => Player.decode(bytes)).toThrow(CorruptInputError);
  });

  it('validates the range itself', () => {
    expect(() => Player.encode(value, [200, 10])).toThrow(RangeError);
    expect(() => Player.encode(value, [0, 300])).toThrow(RangeError);
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

  it('encode errors name the path to the offending value', () => {
    const Search = p.object({ filters: p.array(p.object({ op: p.enum(['eq', 'lt']) })) });
    const ops = [{ op: 'eq' }, { op: 'eq' }, { op: 'gt' }] as { op: 'eq' }[];
    expect(() => Search.encode({ filters: ops })).toThrow(
      "filters[2].op: Value 'gt' not found in list"
    );

    const Account = p.object({ user: p.object({ name: p.string() }) });
    expect(() => Account.encode({ user: {} as { name: string } })).toThrow(
      new ReferenceError('user.name: required field is missing')
    );

    // The class survives, and the stack's first line carries the path too.
    let caught: unknown;
    try {
      p.object({ a: p.int().max(3) }).encode({ a: 5 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).stack).toMatch(/^RangeError: a: Value '5' exceeds range bounds/);

    expect(() => p.array(p.int().max(1)).encode([0, 5])).toThrow('[1]: ');
    expect(() => p.any().encode({ a: [1, Symbol('s')] })).toThrow(
      "a[1]: Type 'symbol' not supported"
    );

    // Anything thrown that is not an Error passes through untouched.
    class PThrows extends PNode<number> {
      _write(): void {
        throw 'not an error';
      }
      _read(): number {
        return 0;
      }
    }
    expect(() => p.object({ a: new PThrows() }).encode({ a: 1 })).toThrow('not an error');
  });
});
