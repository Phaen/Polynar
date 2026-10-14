/**
 * The error surface every node shares: which class a failure throws, the
 * path prefix on errors from inside a schema, and the CorruptInputError
 * contract on decode, then the path module's helpers directly.
 */

import { p, CharSets, CorruptInputError, Encoder, PNode, type PObject } from '../../index';
import { atPath, describe as show, formatPath, oneOf, unlocated } from '../../nodes/path';

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
    expect(() => p.any().encode({ a: [1, [new WeakMap() as never]] })).toThrow(
      'a[1][0]: p.any cannot encode WeakMap values, only plain objects'
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

  it('shows a value JSON cannot write as plain text', () => {
    const notListed = (text: string) =>
      expect.objectContaining({
        name: 'RangeError',
        message: `Value ${text} is not one of the 1 listed values`,
      });
    expect(() => p.enum([{ id: 1n }]).encode({ id: 1n })).toThrow(notListed('[object Object]'));
    expect(() => p.enum([Math.max]).encode(Math.min)).toThrow(notListed(String(Math.min)));
  });

  it('cuts a long value short', () => {
    const members: string[] = ['a'];
    expect(() => p.enum(members).encode('x'.repeat(200))).toThrow(
      `Value "${'x'.repeat(78)}… is not one of "a"`
    );
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
    ['p.int', p.int(), 0],
    ['p.decimal', p.decimal(0.01), 0],
    ['p.date', p.date(), new Date(0)],
  ] as [string, PNode<unknown>, unknown][])(
    '%s reads a signed zero, which the encoder never emits, as zero',
    (_, node, zero) => {
      const enc = new Encoder();
      enc.compose(1, 2);
      enc.composeTerm(0);
      const back = node.decode(enc.output());
      expect(back).toEqual(zero);
      expect(Object.is(back, -0)).toBe(false);
    }
  );
});

describe('formatPath', () => {
  it.each([
    [[], ''],
    [['a'], 'a'],
    [[0], '[0]'],
    [['a', 0, 'b'], 'a[0].b'],
    [[0, 'a', 1], '[0].a[1]'],
    [[''], ''],
  ])('formats %p as %p', (segments, path) => {
    expect(formatPath(segments)).toBe(path);
  });
});

describe('atPath', () => {
  it('passes anything but an Error through untouched', () => {
    const thrown = { message: 'x' };
    for (const value of [thrown, 'boom', undefined, null, 3]) {
      expect(atPath(value, 'a')).toBe(value);
    }
    expect(thrown.message).toBe('x');
  });

  it('prepends segments to the message and the stack, keeping the class', () => {
    const error = new RangeError('bad');
    expect(atPath(atPath(error, 1), 'list')).toBe(error);
    expect(error.message).toBe('list[1]: bad');
    expect(error.stack?.startsWith('RangeError: list[1]: bad')).toBe(true);
  });

  it('leaves an unlocated error as thrown', () => {
    const error = unlocated(new RangeError('bad'));
    expect(atPath(atPath(error, 1), 'list')).toBe(error);
    expect(error.message).toBe('bad');
    expect(error.stack?.startsWith('RangeError: bad')).toBe(true);
  });

  it('leaves a missing or foreign stack alone', () => {
    const bare = new Error('bad');
    bare.stack = undefined;
    atPath(bare, 'a');
    expect([bare.message, bare.stack]).toEqual(['a: bad', undefined]);
    const foreign = new Error('bad');
    foreign.stack = 'elsewhere';
    atPath(foreign, 'a');
    expect([foreign.message, foreign.stack]).toEqual(['a: bad', 'elsewhere']);
  });
});

describe('oneOf', () => {
  it('lists one to eight primitives and counts anything else', () => {
    expect(oneOf(['a'])).toBe('one of "a"');
    expect(oneOf([1, null, true, 'x', undefined, 2n, -0, NaN])).toBe(
      'one of 1, null, true, "x", undefined, 2n, 0, NaN'
    );
    expect(oneOf([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe('one of the 9 listed values');
    expect(oneOf(['a', {}])).toBe('one of the 2 listed values');
    expect(oneOf([() => 1])).toBe('one of the 1 listed values');
    expect(oneOf([])).toBe('one of the 0 listed values');
  });
});

describe('describe', () => {
  it('shows primitives as text, strings quoted', () => {
    expect(show('5')).toBe('"5"');
    expect(show(5)).toBe('5');
    expect(show(-Infinity)).toBe('-Infinity');
    expect(show(NaN)).toBe('NaN');
    expect(show(10n)).toBe('10n');
    expect(show(/a+b/gi)).toBe('/a+b/gi');
    expect(show(undefined)).toBe('undefined');
    expect(show(null)).toBe('null');
    expect(show(Symbol('s'))).toBe('Symbol(s)');
  });

  it('shows dates, objects and arrays as JSON', () => {
    expect(show(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(show(new Date(NaN))).toBe('Invalid Date');
    expect(show({ a: [1, 'b'] })).toBe('{"a":[1,"b"]}');
    expect(show(Object.create(null))).toBe('{}');
  });

  it("shows what JSON can't write by its tag", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(show(cycle)).toBe('[object Object]');
    const bare: Record<string, unknown> = Object.create(null);
    bare.self = bare;
    expect(show(bare)).toBe('[object Object]');
    const list: unknown[] = [];
    list.push(list);
    expect(show(list)).toBe('[object Array]');
    expect(show({ n: 1n })).toBe('[object Object]');
    const hostile = () => 0;
    hostile.toString = () => {
      throw new Error('no');
    };
    expect(show(hostile)).toBe('[object Function]');
  });

  it('cuts a long rendering short', () => {
    const text = show('x'.repeat(200));
    expect(text).toHaveLength(80);
    expect(text.endsWith('xx…')).toBe(true);
    expect(show('x'.repeat(78))).toHaveLength(80);
  });
});
