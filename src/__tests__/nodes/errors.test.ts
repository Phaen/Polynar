/**
 * The error surface every node shares: which class a failure throws, the
 * path prefix on errors from inside a schema, and the CorruptInputError
 * contract on decode.
 */

import { p, CharSets, CorruptInputError, Encoder, PNode, type PObject } from '../../index';

/** A runtime-built member list, typed as plain strings. */
const letters = (): string[] => ['a', 'b'];

describe('Error classes', () => {
  const members: Record<string, PObject<any>> = { a: p.object({}) };

  it.each([
    ['a non-member', () => p.enum(letters()).encode('c'), RangeError],
    ['an unknown tag', () => p.tagged('type', members).encode({ type: 'x' }), RangeError],
    ['a character outside the charset', () => p.string().charset('ab').encode('abc'), RangeError],
    ['an empty charset', () => p.string().charset(''), TypeError],
    ['a reversed charset range', () => p.string().charset([98, 97]), RangeError],
  ])('%s throws its class', (_name, thunk, kind) => {
    expect(thunk).toThrow(kind);
  });
});

describe('Error paths', () => {
  it('prefixes an encode error with the path to the offending value', () => {
    const Search = p.object({ filters: p.array(p.object({ op: p.enum(letters()) })) });
    expect(() => Search.encode({ filters: [{ op: 'a' }, { op: 'a' }, { op: 'c' }] })).toThrow(
      'filters[2].op: Value "c" is not one of "a", "b"'
    );
    expect(() => p.array(p.int().max(1)).encode([0, 5])).toThrow('[1]: ');
    expect(() => p.any().encode({ a: [1, Symbol('s')] })).toThrow(
      'a[1]: p.any cannot encode symbol values'
    );
  });

  it('names a missing required field by its path', () => {
    const Account = p.object({ user: p.object({ name: p.string() }) });
    expect(() => Account.encode({ user: {} as { name: string } })).toThrow(
      new TypeError('user.name: Required field is missing')
    );
  });

  it('keeps the error class, with the path on the stack too', () => {
    let caught: unknown;
    try {
      p.object({ a: p.int().max(3) }).encode({ a: 5 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).stack).toMatch(/^RangeError: a: Value 5 is above the maximum 3/);
  });

  it('passes anything thrown that is not an Error through untouched', () => {
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

describe('CorruptInputError', () => {
  it('is the one catchable class for every decode failure, named for discrimination', () => {
    // The name doubles as the discriminant where instanceof cannot reach
    // (two package copies in one process).
    const node = p.int().min(0).max(100);
    const bytes = node.encode(42);
    // The altered byte still reads as an in-range value (192 % 101 = 91);
    // only the leftover-value check tells it was changed.
    const corrupted = Uint8Array.of(bytes[0] + 150);
    const padded = Uint8Array.of(...bytes, 0);
    expect(() => node.decode(corrupted)).toThrow(CorruptInputError);
    expect(() => node.decode(padded)).toThrow(CorruptInputError);
    expect(() => node.decode(new Uint8Array(0))).toThrow(CorruptInputError);
    expect(() => node.decode('!', { charset: CharSets.digit })).toThrow(CorruptInputError);
    expect(() => node.decode(padded)).toThrow(
      expect.objectContaining({ name: 'CorruptInputError' })
    );
  });

  it('is not thrown for a bad value on encode', () => {
    expect(() => p.int().encode(3.7)).toThrow(TypeError);
    expect(() => p.int().encode(3.7)).not.toThrow(CorruptInputError);
  });

  it.each([
    ['p.int', p.int()],
    ['p.decimal', p.decimal(0.01)],
    ['p.date', p.date()],
  ] as [string, PNode<unknown>][])(
    '%s rejects a negative zero the encoder never emits',
    (_, node) => {
      // A set sign bit with a zero magnitude is a representable digit pattern
      // but not a canonical encoding. p.float is exempt: IEEE -0 is a real,
      // distinct double there.
      const enc = new Encoder();
      enc.compose(1, 2);
      enc.composeTerm(0);
      expect(() => node.decode(enc.output())).toThrow('Non-canonical negative zero');
    }
  );
});
