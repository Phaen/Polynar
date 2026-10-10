/**
 * The bound rules every lattice-backed node shares: int, decimal and date
 * values, and string, binary and array lengths. Bounds are set once, length
 * bounds are non-negative integers, a range must be non-empty and span at
 * most 2^53 values, and a value on a lone bound must sit within exact reach
 * of it. IndexRange and the length helpers are also tested directly.
 */

import { p, Encoder, Decoder, CorruptInputError } from '../../index';
import { IndexRange, checkUnset, lengthBound, lengthRange } from '../../nodes/lattice';
import { trip } from '../support';

const day = new Date('2020-01-01Z');

describe('Bounds are set once', () => {
  it.each([
    ['p.int min', () => p.int().min(0).min(1)],
    ['p.int max', () => p.int().max(1).max(2)],
    ['p.decimal min', () => p.decimal(0.5).min(0).min(1)],
    ['p.decimal max', () => p.decimal(0.5).max(1).max(2)],
    ['p.date min', () => p.date().min(day).min(day)],
    ['p.date max', () => p.date().max(day).max(day)],
    ['p.string min', () => p.string().min(1).min(2)],
    ['p.string max', () => p.string().length(5).max(8)],
    ['p.string min', () => p.string().min(2).length(5)],
    ['p.string max', () => p.string().max(10).length(5)],
    ['p.binary max', () => p.binary().length(4).max(8)],
    ['p.binary min', () => p.binary().min(1).min(2)],
    ['p.array min', () => p.array(p.int()).length(3).min(1)],
    ['p.array max', () => p.array(p.int()).max(5).max(6)],
    ['p.array max', () => p.array(p.int()).max(5).length(3)],
  ])('%s', (bound, thunk) => {
    expect(thunk).toThrow(new TypeError(`${bound} is already set`));
  });

  it('treats length as min and max together', () => {
    expect(p.binary().length(3).encode(new Uint8Array(3))).toEqual(
      p.binary().min(3).max(3).encode(new Uint8Array(3))
    );
    expect(() => p.string().length(3).encode('ab')).toThrow(
      'String length 2 is below the minimum 3'
    );
  });
});

describe('Length bounds', () => {
  it.each([
    ['p.string min', () => p.string().min(-1), RangeError, -1],
    ['p.string max', () => p.string().max(1.5), TypeError, 1.5],
    ['p.string min', () => p.string().length(2.5), TypeError, 2.5],
    ['p.binary min', () => p.binary().min(1.5), TypeError, 1.5],
    ['p.binary max', () => p.binary().max(-2), RangeError, -2],
    ['p.array max', () => p.array(p.int()).max(NaN), TypeError, NaN],
    ['p.array max', () => p.array(p.int()).max(Infinity), TypeError, Infinity],
    ['p.array min', () => p.array(p.int()).length(-1), RangeError, -1],
  ])('%s must be a non-negative integer', (bound, thunk, kind, n) => {
    expect(thunk).toThrow(new kind(`${bound} must be a non-negative integer, got ${n}`));
  });
});

describe('Ranges', () => {
  it.each([
    ['p.int', () => p.int().min(3).max(2), '3', '2'],
    ['p.decimal', () => p.decimal(0.5).min(1).max(0.5), '1', '0.5'],
    ['p.string', () => p.string().min(3).max(2), '3', '2'],
    ['p.binary', () => p.binary().min(3).max(2), '3', '2'],
    ['p.array', () => p.array(p.int()).min(5).max(2), '5', '2'],
  ])('%s refuses an empty range at definition', (who, thunk, min, max) => {
    expect(thunk).toThrow(new RangeError(`${who} range is empty: min ${min} exceeds max ${max}`));
  });

  it.each([
    [
      'p.int',
      () =>
        p
          .int()
          .min(-(2 ** 53))
          .max(2 ** 53),
      '[-9007199254740992, 9007199254740992]',
    ],
    ['p.int', () => p.int().min(0).max(Number.MAX_SAFE_INTEGER), '[0, 9007199254740991]'],
    ['p.decimal', () => p.decimal(1).min(-9e15).max(9e15), '[-9000000000000000, 9000000000000000]'],
    [
      'p.date',
      () => p.date().min(new Date(-8.64e15)).max(new Date(8.64e15)),
      '[-271821-04-20T00:00:00.000Z, +275760-09-13T00:00:00.000Z]',
    ],
  ])('%s refuses a range of more than 2^53 values at definition', (who, thunk, range) => {
    expect(thunk).toThrow(new RangeError(`${who} range ${range} spans more than 2^53 values`));
  });
});

describe('Lone bounds', () => {
  it('refuse a value too far from the bound to index exactly', () => {
    // The offset against the bound is float arithmetic; past 2^53 it rounds
    // to a neighbouring integer.
    expect(() =>
      p
        .int()
        .max(1)
        .encode(-(2 ** 53))
    ).toThrow(
      new RangeError('Value -9007199254740992 is too far from its bound 1 to encode exactly')
    );
    expect(() =>
      p
        .int()
        .min(1)
        .encode(2 ** 53 + 6)
    ).toThrow(`Value ${2 ** 53 + 6} is too far from its bound 1`);
    expect(() =>
      p
        .decimal(1)
        .min(-9e15)
        .encode(9e15 + 1)
    ).toThrow('Value 9000000000000001 is too far from its bound -9000000000000000');
    expect(() =>
      p
        .date()
        .min(new Date(-8.6e15))
        .encode(new Date(8.6e15 + 1))
    ).toThrow(
      'Value +274493-02-24T00:53:20.001Z is too far from its bound -270554-11-06T23:06:40.000Z to encode exactly'
    );
  });

  it('round-trip the largest exactly indexable offset', () => {
    expect(trip(p.int().min(1), 2 ** 53)).toBe(2 ** 53);
  });

  it('read a term offset that cannot reconstruct exactly as corrupt input', () => {
    // bound + offset rounds past 2^53, so the encoder could never have
    // emitted it.
    const enc = new Encoder();
    enc.composeTerm(2 ** 53);
    expect(() => p.int().min(1).decode(enc.output())).toThrow(CorruptInputError);
    const far = p
      .int()
      .min(0)
      .encode(2 ** 53 + 2);
    expect(() => p.int().max(-3).decode(far)).toThrow(CorruptInputError);
  });
});

/** Writes indices through `range`, then reads as many back. */
const roundTrip = (range: IndexRange, indices: number[]): number[] => {
  const enc = new Encoder();
  for (const index of indices) {
    range.write(enc, index);
  }
  const dec = new Decoder(enc.output());
  const out = indices.map(() => range.read(dec));
  dec.finalize();
  return out;
};

describe('IndexRange', () => {
  it.each([
    ['min', 1.5, undefined],
    ['min', NaN, 3],
    ['min', -Infinity, undefined],
    ['max', undefined, 2.5],
    ['max', 0, Infinity],
    ['max', undefined, NaN],
  ])('refuses a non-integer %s', (which, lo, hi) => {
    const bad = which === 'min' ? lo : hi;
    expect(() => new IndexRange('r', lo, hi)).toThrow(
      new TypeError(`r ${which} must be an integer, got ${bad}`)
    );
  });

  it('refuses an empty or too wide range, spelled through show', () => {
    expect(() => new IndexRange('r', 3, 2, undefined, (i) => `#${i}`)).toThrow(
      new RangeError('r range is empty: min #3 exceeds max #2')
    );
    expect(() => new IndexRange('r', 0, Number.MAX_SAFE_INTEGER)).toThrow(
      new RangeError(`r range [0, ${Number.MAX_SAFE_INTEGER}] spans more than 2^53 values`)
    );
    expect(new IndexRange('r', 0, Number.MAX_SAFE_INTEGER - 1).radix).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('takes a prior only between two bounds', () => {
    expect(() => new IndexRange('r', 0, undefined, [1])).toThrow(
      new TypeError('r weights requires both bounds')
    );
    expect(() => new IndexRange('r', undefined, 0, (v) => v)).toThrow(
      new TypeError('r cdf requires both bounds')
    );
    expect(() => new IndexRange('r', undefined, undefined, [1])).toThrow('requires both bounds');
  });

  it('has a radix and a digit mapping only with both bounds and no prior', () => {
    const range = new IndexRange('r', -2, 5);
    expect(range.radix).toBe(8);
    expect(range.fromDigit?.(0)).toBe(-2);
    expect(range.fromDigit?.(7)).toBe(5);
    expect(range.fromDigit?.(-1)).toBe(-3);
    for (const other of [
      new IndexRange('r'),
      new IndexRange('r', 0),
      new IndexRange('r', undefined, 0),
      new IndexRange('r', 0, 3, [1, 1, 1, 1]),
    ]) {
      expect(other.radix).toBeUndefined();
      expect(other.fromDigit).toBeUndefined();
    }
  });

  it('stores a max of -0 as 0', () => {
    expect(Object.is(new IndexRange('r', undefined, -0).hi, 0)).toBe(true);
    expect(Object.is(new IndexRange('r', -0).lo, -0)).toBe(true);
  });

  it.each([
    ['both bounds', new IndexRange('r', -3, 3), [-3, 0, 3]],
    ['a min', new IndexRange('r', -3), [-3, 0, 2 ** 40]],
    ['a max', new IndexRange('r', undefined, 3), [3, 0, -(2 ** 40)]],
    ['no bounds', new IndexRange('r'), [0, -1, 1, -(2 ** 53), 2 ** 53]],
    ['a weight prior', new IndexRange('r', 1, 3, [1, 2, 5]), [1, 2, 3, 3]],
    ['a cdf prior', new IndexRange('r', 0, 9, (v) => v * v), [9, 1, 5]],
  ])('round-trips indices under %s', (_name, range, indices) => {
    expect(roundTrip(range, indices)).toEqual(indices);
  });

  it('writes -0 as 0', () => {
    for (const range of [
      new IndexRange('r'),
      new IndexRange('r', -0),
      new IndexRange('r', -1, 1),
    ]) {
      expect(Object.is(roundTrip(range, [-0])[0], 0)).toBe(true);
    }
  });

  it.each([
    ['no bounds', new IndexRange('r')],
    ['both bounds', new IndexRange('r', 0, 9)],
    ['a prior', new IndexRange('r', 0, 2, [1, 1, 1])],
  ])('refuses a non-integer index under %s', (_name, range) => {
    for (const index of [0.5, NaN, Infinity, -Infinity]) {
      expect(() => range.write(new Encoder(), index)).toThrow(
        new TypeError(`Value ${index} is not an integer`)
      );
    }
  });

  it('refuses an index outside the bounds, named by subject and spelled by show', () => {
    const show = (i: number) => `#${i}`;
    for (const range of [
      new IndexRange('r', 1, 3, undefined, show),
      new IndexRange('r', 1, 3, [1, 1, 1], show),
    ]) {
      expect(() => range.write(new Encoder(), 0, () => 'Item')).toThrow(
        new RangeError('Item is below the minimum #1')
      );
      expect(() => range.write(new Encoder(), 4)).toThrow(
        new RangeError('Value #4 is above the maximum #3')
      );
    }
    expect(() => new IndexRange('r', 1).write(new Encoder(), -5)).toThrow(
      'Value -5 is below the minimum 1'
    );
    expect(() => new IndexRange('r', undefined, 1).write(new Encoder(), 5)).toThrow(
      'Value 5 is above the maximum 1'
    );
  });

  it('refuses an index too far from a lone max', () => {
    expect(() => new IndexRange('r', undefined, 2 ** 53).write(new Encoder(), -7)).toThrow(
      new RangeError(`Value -7 is too far from its bound ${2 ** 53} to encode exactly`)
    );
  });
});

describe('lengthBound', () => {
  it('passes a non-negative integer or undefined through', () => {
    expect(lengthBound(undefined, 'w', 'min')).toBeUndefined();
    expect(lengthBound(0, 'w', 'min')).toBe(0);
    expect(lengthBound(2 ** 53, 'w', 'max')).toBe(2 ** 53);
    expect(lengthBound(-0, 'w', 'min')).toBe(-0);
  });

  it.each([
    [1.5, TypeError],
    [NaN, TypeError],
    [Infinity, TypeError],
    [-Infinity, TypeError],
    [-1, RangeError],
    [-(2 ** 53), RangeError],
  ])('refuses %s', (n, kind) => {
    expect(() => lengthBound(n, 'w', 'max')).toThrow(
      new kind(`w max must be a non-negative integer, got ${n}`)
    );
  });
});

describe('lengthRange', () => {
  it('floors the range at 0 and keeps the max', () => {
    const range = lengthRange({}, 'w', 'length');
    expect([range.lo, range.hi]).toEqual([0, undefined]);
    const capped = lengthRange({ min: 2, max: 4 }, 'w', 'length');
    expect([capped.lo, capped.hi, capped.radix]).toEqual([2, 4, 3]);
  });

  it('takes a prior only with a max', () => {
    expect(() => lengthRange({ prior: [1] }, 'w', 'count')).toThrow(
      new TypeError('w weights requires a max count')
    );
    expect(() => lengthRange({ min: 1, prior: (v) => v }, 'w', 'length')).toThrow(
      new TypeError('w cdf requires a max length')
    );
    expect(lengthRange({ max: 1, prior: [1, 3] }, 'w', 'count').prior?.declared).toEqual([1, 3]);
  });

  it('refuses an empty range', () => {
    expect(() => lengthRange({ min: 3, max: 2 }, 'w', 'count')).toThrow(
      new RangeError('w range is empty: min 3 exceeds max 2')
    );
  });
});

describe('checkUnset', () => {
  it('passes an unset bound', () => {
    expect(() => checkUnset(undefined, 'w', 'min')).not.toThrow();
  });

  it.each([0, null, NaN, '', false])('refuses a bound already set to %p', (current) => {
    expect(() => checkUnset(current, 'w', 'max')).toThrow(new TypeError('w max is already set'));
  });
});
