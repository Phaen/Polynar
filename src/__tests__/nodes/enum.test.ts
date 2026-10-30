/**
 * `p.enum()`: one member of a fixed list.
 */

import { p } from '../../index';

import { STRUCT } from '../../predictor/types';
import { mulberry32, trip } from '../support';

describe('Schema enum', () => {
  it('rejects an empty list at construction', () => {
    expect(() => p.enum([])).toThrow(TypeError);
  });

  it('rejects a value not in its list, showing the list when it is short', () => {
    // Lists built at runtime type their members as plain values.
    const letters: string[] = ['a', 'b'];
    expect(() => p.enum(letters).encode('c')).toThrow(
      new RangeError('Value "c" is not one of "a", "b"')
    );
    const many: string[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    expect(() => p.enum(many).encode('z')).toThrow('Value "z" is not one of the 9 listed values');
    const numbers: (number | string)[] = [1, 5];
    expect(() => p.enum(numbers).encode('5')).toThrow(
      new RangeError('Value "5" is not one of 1, 5')
    );
    const bigints: bigint[] = [1n, 2n];
    expect(() => p.enum(bigints).encode(3n)).toThrow('Value 3n is not one of 1n, 2n');
  });

  it('matches members by identity, so any stable reference works', () => {
    // The wire carries an index into the shared list, so decode hands back
    // the listed member itself: objects and functions included.
    const strategies = [{ retries: 0 }, { retries: 5 }];
    const Strategy = p.enum(strategies);
    expect(trip(Strategy, strategies[1])).toBe(strategies[1]);
    expect(() => Strategy.encode({ retries: 5 })).toThrow('is not one of the 2 listed values');

    const Rounding = p.enum([Math.floor, Math.ceil, Math.round]);
    expect(trip(Rounding, Math.ceil)).toBe(Math.ceil);
  });

  it('rejects NaN and duplicate members at construction', () => {
    // NaN never equals itself under the === that indexOf uses, so a NaN
    // member could never be encoded; a duplicate is unreachable behind its
    // first occurrence and inflates the radix every value pays for.
    expect(() => p.enum([1, NaN])).toThrow(TypeError);
    expect(() => p.enum(['a', 'a'])).toThrow(TypeError);
    expect(() => p.enum([0, -0])).toThrow(TypeError);
    const shared = { retries: 0 };
    expect(() => p.enum([shared, shared])).toThrow(TypeError);
  });
});

describe('p.enum digits', () => {
  it('map members to their list position and back, throwing as a write does', () => {
    const node = p.enum(['a', 'b', 'c']);
    expect(node._toDigit('c')).toBe(2);
    expect(node._fromDigit(node._toDigit('b'))).toBe('b');
    expect(() => node._toDigit('d' as 'a')).toThrow(
      new RangeError('Value "d" is not one of "a", "b", "c"')
    );
  });
});

describe('p.enum adapt', () => {
  const plain = p.enum(['a', 'b', 'c', 'd']);
  const values = (() => {
    const rnd = mulberry32(5);
    return Array.from({ length: 300 }, () =>
      rnd() < 0.85 ? 'a' : (['b', 'c', 'd'] as const)[Math.floor(rnd() * 3)]
    );
  })();

  it('round-trips a run, learning the skew under its options', () => {
    for (const node of [
      plain.adapt(),
      plain.adapt({ window: 8 }),
      plain.weights([17, 1, 1, 1]).adapt(),
    ]) {
      expect(trip(p.array(node), values)).toEqual(values);
    }
    expect(p.array(plain.adapt()).encode(values)).not.toEqual(p.array(plain).encode(values));
  });

  it('sets each method once, and not both', () => {
    expect(() => plain.adapt().adapt()).toThrow(new TypeError('p.enum adapt is already set'));
    expect(() => plain.adapt().compress()).toThrow(
      new TypeError('p.enum adapt and compress cannot both be set')
    );
    expect(() => plain.compress().adapt()).toThrow(
      new TypeError('p.enum adapt and compress cannot both be set')
    );
    expect(() => plain.compress().compress()).toThrow(
      new TypeError('p.enum compress is already set')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.adapt({ window: 1.5 })).toThrow(
      new TypeError('p.enum learning window must be a positive integer, got 1.5')
    );
    expect(() => plain.adapt().weights([1])).toThrow(
      new TypeError('p.enum weights must list one weight per value: expected 4, got 1')
    );
  });
});

describe('p.enum compress', () => {
  const plain = p.enum(['a', 'b', 'c', 'd']);
  const weights = [17, 1, 1, 1];
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () =>
      rnd() < 0.85 ? 'a' : (['b', 'c', 'd'] as const)[Math.floor(rnd() * 3)]
    );
  };

  it('round-trips a run alone, in a plain array and in a compressed object', () => {
    const values = run(200, 1);
    for (const node of [plain.compress(), plain.weights(weights).compress({ window: 8 })]) {
      expect(node._radix).toBeUndefined();
      for (const value of values.slice(0, 20)) expect(trip(node, value)).toBe(value);
      expect(trip(p.array(node), values)).toEqual(values);
    }
    const Row = p.object({ x: plain, y: plain.weights(weights) }).compress();
    const rows = values.map((x, i) => ({ x, y: values[(i * 7) % values.length] }));
    expect(trip(p.array(Row), rows)).toEqual(rows);
  });

  it('takes members of mixed kinds, its parent coding each kind’s symbol', () => {
    const shared = { id: 1 };
    const members = ['a', 1, 2.5, true, null, shared] as const;
    const node = p.enum(members);
    expect(node._markers()).toEqual(
      new Set([STRUCT.STR, STRUCT.INT, STRUCT.NUM, STRUCT.TRUE, STRUCT.NULL, STRUCT.OBJ_START])
    );
    const rnd = mulberry32(6);
    const values = Array.from({ length: 120 }, () => members[Math.floor(rnd() * members.length)]);
    const decoded = p.array(node).compress().decode(p.array(node).compress().encode(values));
    expect(decoded).toEqual(values);
    expect(decoded[values.indexOf(shared)]).toBe(shared);
    expect(trip(p.array(node.compress()), values)).toEqual(values);
  });

  it('takes its weights as prior counts of its members', () => {
    const node = p.enum(['a', 'b']).weights([30, 1]);
    for (const list of [p.array(node.compress()).length(12), p.array(node).length(12).compress()]) {
      const as = Array<'a' | 'b'>(12).fill('a');
      const bs = Array<'a' | 'b'>(12).fill('b');
      expect(list.encode(as).length).toBeLessThan(list.encode(bs).length);
    }
  });

  it('refuses a member of zero weight where the weights are declared', () => {
    expect(() => p.enum(['a', 'b']).weights([1, 0]).compress()).toThrow(
      new TypeError('p.enum weights must be positive integers, got 0')
    );
    expect(() => p.enum(['a', 'b']).compress().weights([1, 0])).toThrow(
      new TypeError('p.enum weights must be positive integers, got 0')
    );
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).compress({ window: 64 })).encode(values)).toEqual(
      p.array(plain.compress({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.compress({ window: 0 })).toThrow(
      new RangeError('p.enum: compress window must be at least 1')
    );
    expect(() => plain.compress({ separate: 1 as never })).toThrow(
      new TypeError('p.enum: compress separate must be a boolean')
    );
    expect(() => plain.compress().weights([1])).toThrow(
      new TypeError('p.enum weights must list one weight per value: expected 4, got 1')
    );
  });
});
