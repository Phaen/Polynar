/**
 * The bound rules every lattice-backed node shares: int, decimal and date
 * values, and string, binary and array lengths. Bounds are set once, length
 * bounds are non-negative integers, a range must be non-empty and span at
 * most 2^53 values, and a value on a lone bound must sit within exact reach
 * of it. IndexRange and the length helpers are also tested directly.
 */

import { p, Encoder, Decoder, CorruptInputError } from '../../index';
import { IndexRange, checkUnset, lengthBound, lengthRange } from '../../nodes/lattice';
import { LearnedMagnitude } from '../../nodes/magnitude';
import { AdaptivePrior, MAX_COMPRESS_MEMBERS } from '../../nodes/adaptive';
import type { PNode } from '../../nodes/base';
import { mulberry32, trip } from '../support';
import { buildWeights, readTable } from '../../nodes/weights';

const adaptation = { window: 1024 };
const ones = (n: number) => new Array<number>(n).fill(1);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

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
    ['p.int', () => p.int().min(-1).max(Number.MAX_SAFE_INTEGER), '[-1, 9007199254740991]'],
    ['p.decimal', () => p.decimal(1).min(-9e15).max(9e15), '[-9000000000000000, 9000000000000000]'],
    [
      'p.date',
      () => p.date().min(new Date(-8.64e15)).max(new Date(8.64e15)),
      '[-271821-04-20T00:00:00.000Z, +275760-09-13T00:00:00.000Z]',
    ],
  ])('%s refuses a range of more than 2^53 values at definition', (who, thunk, range) => {
    expect(thunk).toThrow(new RangeError(`${who} range ${range} spans more than 2^53 values`));
  });

  it.each([
    ['p.int', p.int().min(0).max(Number.MAX_SAFE_INTEGER), [0, 2 ** 27, Number.MAX_SAFE_INTEGER]],
    [
      'p.int',
      p
        .int()
        .min(-(2 ** 52))
        .max(2 ** 52 - 1),
      [-(2 ** 52), -1, 2 ** 52 - 1],
    ],
    [
      'p.decimal',
      p
        .decimal(2)
        .min(-(2 ** 53))
        .max(2 ** 53 - 2),
      [-(2 ** 53), 2, 2 ** 53 - 2],
    ],
    [
      'p.date',
      p
        .date()
        .min(-(2 ** 52))
        .max(2 ** 52 - 1),
      [new Date(-(2 ** 52)), new Date(0), new Date(2 ** 52 - 1)],
    ],
  ] as [string, PNode<unknown>, unknown[]][])(
    '%s round-trips a range of exactly 2^53 values in 53 bits',
    (_who, node, values) => {
      for (const value of values) {
        expect(trip(node, value)).toEqual(value);
        expect(node.encode(value).length).toBeLessThanOrEqual(7);
      }
      expect(node.encode(values[values.length - 1])).toHaveLength(7);
    }
  );
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

/** Writes indices through `range`, then reads as many back, each learned as a node teaches it. */
const roundTrip = (range: IndexRange, indices: number[]): number[] => {
  const enc = new Encoder();
  for (const index of indices) {
    range.write(enc, index);
    range.learn(enc, index);
  }
  const dec = new Decoder(enc.output());
  const out = indices.map(() => {
    const index = range.read(dec);
    range.learn(dec, index);
    return index;
  });
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
    expect(() => new IndexRange('r', 3, 2, undefined, undefined, (i) => `#${i}`)).toThrow(
      new RangeError('r range is empty: min #3 exceeds max #2')
    );
    expect(() => new IndexRange('r', -1, Number.MAX_SAFE_INTEGER)).toThrow(
      new RangeError(`r range [-1, ${Number.MAX_SAFE_INTEGER}] spans more than 2^53 values`)
    );
    expect(new IndexRange('r', 0, Number.MAX_SAFE_INTEGER - 1).radix).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('splits a range of exactly 2^53 values over two slots', () => {
    // One state past the largest radix, so the offset packs as two digits
    // whose radices multiply to 2^53; a prior over it would need as many
    // states in one total, and stays refused there.
    const range = new IndexRange('r', 1, 2 ** 53);
    const indices = [1, 2 ** 27, 2 ** 27 + 1, 12345678901234, 2 ** 53];
    expect(roundTrip(range, indices)).toEqual(indices);
    expect(
      roundTrip(new IndexRange('r', -(2 ** 52), 2 ** 52 - 1), [-(2 ** 52), 0, 2 ** 52 - 1])
    ).toEqual([-(2 ** 52), 0, 2 ** 52 - 1]);
    const enc = new Encoder();
    range.write(enc, 2 ** 53);
    expect(enc.output()).toHaveLength(7);
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
    expect(range.toDigit?.(-2)).toBe(0);
    expect(range.toDigit?.(5)).toBe(7);
    expect(() => range.toDigit?.(6)).toThrow(new RangeError('Value 6 is above the maximum 5'));
    expect(() => range.toDigit?.(-3, () => 'Item')).toThrow(
      new RangeError('Item is below the minimum -2')
    );
    expect(() => range.toDigit?.(0.5)).toThrow(new TypeError('Value 0.5 is not an integer'));
    for (const other of [
      new IndexRange('r'),
      new IndexRange('r', 0),
      new IndexRange('r', undefined, 0),
      new IndexRange('r', 0, 3, [1, 1, 1, 1]),
      new IndexRange('r', 0, Number.MAX_SAFE_INTEGER),
      new IndexRange('r', 0, 3, undefined, adaptation),
    ]) {
      expect(other.radix).toBeUndefined();
      expect(other.fromDigit).toBeUndefined();
      expect(other.toDigit).toBeUndefined();
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
    ['adaptation', new IndexRange('r', -2, 5, undefined, adaptation), [-2, 5, 0, 0, 0]],
    ['adaptive weights', new IndexRange('r', 1, 3, [1, 2, 5], adaptation), [1, 2, 3, 3]],
    ['a lone adaptive value', new IndexRange('r', 4, 4, undefined, adaptation), [4, 4]],
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
    ['adaptation', new IndexRange('r', 0, 2, undefined, adaptation)],
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
      new IndexRange('r', 1, 3, undefined, undefined, show),
      new IndexRange('r', 1, 3, [1, 1, 1], undefined, show),
      new IndexRange('r', 1, 3, undefined, adaptation, show),
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

  it('takes an adaptation with weights only between two bounds and over a limited span', () => {
    expect(() => new IndexRange('r', undefined, 0, [1], adaptation)).toThrow(
      new TypeError('r weights requires both bounds')
    );
    expect(() => new IndexRange('r', 0, 3, (v) => v, adaptation)).toThrow(
      new TypeError('r adapt takes weights, not a cdf')
    );
    expect(
      () =>
        new IndexRange('r', 1, MAX_COMPRESS_MEMBERS + 1, ones(MAX_COMPRESS_MEMBERS + 1), adaptation)
    ).toThrow(new RangeError('r learned prior spans 65537 values, above the limit 65536'));
    const widest = new IndexRange('r', 1, MAX_COMPRESS_MEMBERS, undefined, {});
    expect(widest.learning).toEqual({});
    expect(widest.prior).toBeUndefined();
    expect(roundTrip(widest, [1, MAX_COMPRESS_MEMBERS])).toEqual([1, MAX_COMPRESS_MEMBERS]);
    expect(() => new IndexRange('r', 0, 2, [1, 1], adaptation)).toThrow(
      new TypeError('r weights must list one weight per value: expected 3, got 2')
    );
    expect(() => new IndexRange('r', 0, 1, [2 ** 50, 1], adaptation)).toThrow(
      new RangeError(
        `r adaptive prior 4 and window 1024 overflow with weights totalling ${2 ** 50 + 1}`
      )
    );
    expect(new IndexRange('r', 0, 1).learning).toBeUndefined();
    expect(() => new IndexRange('r', 0, 1, undefined, { window: 1.5 })).toThrow(
      new TypeError('r learning window must be a positive integer, got 1.5')
    );
    expect(() => lengthRange({ max: 1 }, 'w', 'count', { window: 0 })).toThrow(
      new RangeError('w learning window must be a positive integer, got 0')
    );
    expect(roundTrip(new IndexRange('r', 0, 1, undefined, {}), [1, 1, 0])).toEqual([1, 1, 0]);
  });

  it('reports the declared prior in every mode', () => {
    const weights = [1, 2, 3];
    const cdf = (v: number) => v;
    expect(new IndexRange('r', 0, 2, weights, adaptation).declared).toBe(weights);
    expect(new IndexRange('r', 0, 2, undefined, adaptation).declared).toBeUndefined();
    expect(new IndexRange('r', 0, 2, weights).declared).toBe(weights);
    expect(new IndexRange('r', 0, 2, cdf).declared).toBe(cdf);
    expect(new IndexRange('r', 0, 2).declared).toBeUndefined();
  });

  it('writes an adaptive range as the same AdaptivePrior over its offsets', () => {
    const random = mulberry32(11);
    const weights = [3, 1, 1, 1, 2, 1, 1, 1, 1, 4];
    const indices = Array.from({ length: 400 }, () =>
      random() < 0.7 ? -3 : -5 + Math.floor(random() * 10)
    );
    const range = new IndexRange('r', -5, 4, weights, adaptation);
    const model = new AdaptivePrior([weights], weights.length, adaptation.window, 'r');
    const enc = new Encoder();
    for (const index of indices) {
      model.write(enc, index + 5);
      model.learn(enc, index + 5);
    }
    const bytes = enc.output();
    const ranged = new Encoder();
    for (const index of indices) {
      range.write(ranged, index);
      range.learn(ranged, index);
    }
    expect(ranged.output()).toEqual(bytes);
    // The skew makes the adaptive spelling the cheaper one; its selector
    // follows the first, static, value.
    const dec = new Decoder(bytes);
    expect(readTable(dec, model.bases[0])).toBe(indices[0] + 5);
    const rungs = model.rungs.length;
    expect(
      readTable(dec, buildWeights([rungs, ...Array<number>(rungs).fill(1)], 1 + rungs, 'w'))
    ).toBeGreaterThan(0);
    expect(roundTrip(range, indices)).toEqual(indices);
  });

  it('learns over the widest adaptive range', () => {
    const random = mulberry32(12);
    const indices = Array.from({ length: 500 }, () =>
      random() < 0.9 ? 40000 + Math.floor(random() * 4) : Math.floor(random() * 65536)
    );
    const range = new IndexRange('r', 0, MAX_COMPRESS_MEMBERS - 1, undefined, {});
    const plain = new IndexRange('r', 0, MAX_COMPRESS_MEMBERS - 1);
    const write = (into: IndexRange): Uint8Array => {
      const enc = new Encoder();
      for (const index of indices) {
        into.write(enc, index);
        into.learn(enc, index);
      }
      return enc.output();
    };
    // 500 uniform values of 16 bits take 1000 bytes.
    expect(write(plain)).toHaveLength(1000);
    expect(write(range).length).toBeLessThan(750);
    expect(roundTrip(range, indices)).toEqual(indices);
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

  it('takes an adaptation, passing it through, and learns without a max from the min', () => {
    const open = lengthRange({ min: 1 }, 'w', 'length', adaptation);
    expect([open.lo, open.hi, open.learning]).toEqual([1, undefined, adaptation]);
    expect(roundTrip(open, [1, 2, 900, 2])).toEqual([1, 2, 900, 2]);
    expect(() => lengthRange({ prior: [1] }, 'w', 'count', adaptation)).toThrow(
      new TypeError('w weights requires a max count')
    );
    const range = lengthRange({ min: 1, max: 3, prior: [1, 2, 3] }, 'w', 'count', adaptation);
    expect([range.lo, range.hi, range.radix, range.learning]).toEqual([
      1,
      3,
      undefined,
      adaptation,
    ]);
    expect(roundTrip(range, [3, 3, 1, 2])).toEqual([3, 3, 1, 2]);
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

describe('IndexRange offsets', () => {
  it.each([
    ['both bounds', new IndexRange('r', -3, 4), -3, 0, 7],
    ['a min', new IndexRange('r', 5), 5, 0, MAX_SAFE],
    ['a max', new IndexRange('r', undefined, 5), 5, -MAX_SAFE, 0],
    ['no bounds', new IndexRange('r'), 0, -MAX_SAFE, MAX_SAFE],
  ])('count from the min, else the max, else 0, under %s', (_name, range, origin, low, high) => {
    expect([range.origin, range.low, range.high]).toEqual([origin, low, high]);
  });

  it('offsets an index within the exact reach of the origin, -0 as 0', () => {
    const range = new IndexRange('r', 10);
    expect(range.offset(13)).toBe(3);
    expect(Object.is(new IndexRange('r').offset(-0), 0)).toBe(true);
    expect(Object.is(new IndexRange('r', -0).offset(0), 0)).toBe(true);
    expect(range.reaches(10 + MAX_SAFE)).toBe(true);
    expect(range.reaches(2 ** 60)).toBe(false);
    expect(() => range.offset(2 ** 60)).toThrow(
      new RangeError(`Value ${2 ** 60} is too far from 10 to encode exactly`)
    );
    expect(() => range.offset(2 ** 60, () => 'Item')).toThrow(
      new RangeError('Item is too far from 10 to encode exactly')
    );
    expect(() => range.offset(9)).toThrow(new RangeError('Value 9 is below the minimum 10'));
    expect(() => range.offset(10.5)).toThrow(new TypeError('Value 10.5 is not an integer'));
  });

  it('adds an offset back to its index, refusing one that rounds as corrupt', () => {
    expect(new IndexRange('r', -4).fromOffset(6)).toBe(2);
    const far = new IndexRange('r', 2 ** 60, 2 ** 60 + 2 ** 20);
    expect(far.fromOffset(256)).toBe(2 ** 60 + 256);
    expect(() => far.fromOffset(1)).toThrow(CorruptInputError);
  });
});

describe('IndexRange learned spelling', () => {
  /** A message of `offsets` priced, then written, by `learned`, and read back by the same method. */
  const learnedTrip = (range: IndexRange, indices: number[]): number[] => roundTrip(range, indices);

  it('learns a wide or unbounded range on the magnitude scale from its origin', () => {
    const cases: [IndexRange, LearnedMagnitude, number, number, number[]][] = [
      [
        new IndexRange('r', 3, 3 + 2 ** 20, undefined, {}),
        new LearnedMagnitude(false, {}, 'r'),
        0,
        2 ** 20,
        [3, 5, 3 + 2 ** 20, 3],
      ],
      [
        new IndexRange('r', 3, undefined, undefined, {}),
        new LearnedMagnitude(false, {}, 'r'),
        0,
        MAX_SAFE,
        [3, 2 ** 40, 7, 3 + MAX_SAFE],
      ],
      [
        new IndexRange('r', undefined, 3, undefined, {}),
        new LearnedMagnitude(true, {}, 'r'),
        -MAX_SAFE,
        0,
        [3, -(2 ** 40), 0, 3 - MAX_SAFE],
      ],
      [
        new IndexRange('r', undefined, undefined, undefined, {}),
        new LearnedMagnitude(true, {}, 'r'),
        -MAX_SAFE,
        MAX_SAFE,
        [0, -1, 1, MAX_SAFE, -MAX_SAFE],
      ],
    ];
    for (const [range, model, low, high, indices] of cases) {
      expect(learnedTrip(range, indices)).toEqual(indices);
      const enc = new Encoder();
      for (const index of indices) {
        model.write(enc, index - range.origin, 0, low, high);
        model.learn(enc, index - range.origin, 0, low, high);
      }
      const ours = new Encoder();
      for (const index of indices) {
        range.write(ours, index);
        range.learn(ours, index);
      }
      expect(ours.output()).toEqual(enc.output());
    }
  });

  it("refuses an index out of the origin's exact reach", () => {
    expect(() =>
      new IndexRange('r', undefined, undefined, undefined, {}).write(new Encoder(), 2 ** 60)
    ).toThrow(new RangeError(`Value ${2 ** 60} is too far from 0 to encode exactly`));
  });

  it('reads an index that does not add back to its origin as corrupt', () => {
    const range = new IndexRange('r', 2 ** 60, 2 ** 60 + 2 ** 20, undefined, {});
    const enc = new Encoder();
    new LearnedMagnitude(false, {}, 'r').write(enc, 1, 0, 0, 2 ** 20);
    expect(() => range.read(new Decoder(enc.output()))).toThrow(CorruptInputError);
  });

  it.each([
    ['members', new IndexRange('r', 0, 9, undefined, {}), -1, 10],
    ['offsets', new IndexRange('r', 0, 2 ** 20, undefined, {}), -1, 2 ** 20 + 1],
  ])('writes and learns only offsets in reach, as %s', (_name, range, below, above) => {
    const learned = range.learned;
    if (learned === undefined) {
      throw new Error('not learned');
    }
    const enc = new Encoder();
    // The first value is spelled by the static weights, the later ones by
    // what the message taught.
    learned.write(enc, 5);
    for (const offset of [below, above, 0.5]) {
      const mark = enc.mark();
      expect(() => learned.write(enc, offset)).toThrow();
      enc.rollback(mark);
      expect(() => learned.learn(enc, offset)).toThrow();
    }
    const cost = (): number => {
      const mark = enc.mark();
      learned.write(enc, 3);
      const bits = enc.bitsSince(mark);
      enc.rollback(mark);
      return bits;
    };
    const one = cost();
    // Learning a value makes it cheaper.
    for (let i = 0; i < 20; i++) {
      learned.learn(enc, 3);
    }
    expect(cost()).toBeLessThan(one);
    // The decoder learns too, and reads what the encoder wrote after it.
    learned.write(enc, 3);
    const dec = new Decoder(enc.output());
    expect(learned.read(dec)).toBe(5);
    for (let i = 0; i < 20; i++) {
      learned.learn(dec, 3);
    }
    expect(learned.read(dec)).toBe(3);
  });

  it('keeps a narrow range under weights on the adaptive prior', () => {
    expect(() => new IndexRange('r', 0, 2 ** 20, ones(2 ** 20 + 1), {})).toThrow(
      `r learned prior spans ${2 ** 20 + 1} values, above the limit 65536`
    );
  });
});

describe('IndexRange writeValue and readValue', () => {
  /** A message of `indices` written value by value, and read back the same way. */
  const valueTrip = (range: IndexRange, indices: number[]) => {
    const enc = new Encoder();
    for (const index of indices) {
      range.writeValue(enc, index);
    }
    const bytes = enc.output();
    const dec = new Decoder(bytes);
    const back = indices.map(() => range.readValue(dec));
    dec.finalize();
    return { bytes, back };
  };

  it('spells a plain range as write and read do', () => {
    const range = new IndexRange('r', 0, 9);
    const indices = [3, 3, 9, 0];
    const { bytes, back } = valueTrip(range, indices);
    expect(back).toEqual(indices);
    const enc = new Encoder();
    for (const index of indices) {
      range.write(enc, index);
    }
    expect(bytes).toEqual(enc.output());
  });

  it.each([
    ['narrow', () => new IndexRange('r', 0, 9, undefined, {}), [4, 4, 4, 9, 0, 4]],
    ['narrow under weights', () => new IndexRange('r', 0, 2, [1, 5, 1], {}), [1, 1, 2, 0, 1]],
    ['wide', () => new IndexRange('r', 3, 3 + 2 ** 20, undefined, {}), [3, 5, 3 + 2 ** 20, 5]],
    [
      'unbounded',
      () => new IndexRange('r', undefined, undefined, undefined, {}),
      [0, -5, 2 ** 40, -5],
    ],
    ['lone max', () => new IndexRange('r', undefined, 7, undefined, {}), [7, -(2 ** 30), 7]],
  ])('learns each value it writes or reads, %s', (_name, build, indices) => {
    const { back } = valueTrip(build(), indices);
    expect(back).toEqual(indices);
  });

  it('prices a repeated value lower as it learns it', () => {
    const indices = Array<number>(100).fill(4);
    for (const range of [
      new IndexRange('r', 0, 9, undefined, {}),
      new IndexRange('r', 0, 2 ** 20, undefined, {}),
    ]) {
      const plain = new Encoder();
      for (const index of indices) {
        range.write(plain, index);
      }
      expect(valueTrip(range, indices).bytes.length).toBeLessThan(plain.output().length);
    }
  });

  it('refuses an index outside the range or its origin reach before writing anything', () => {
    const narrow = new IndexRange('r', 0, 9, undefined, {});
    const enc = new Encoder();
    expect(() => narrow.writeValue(enc, 10)).toThrow(
      new RangeError('Value 10 is above the maximum 9')
    );
    expect(() => narrow.writeValue(enc, -1, () => 'Item')).toThrow(
      new RangeError('Item is below the minimum 0')
    );
    expect(() =>
      new IndexRange('r', undefined, undefined, undefined, {}).writeValue(enc, 2 ** 60)
    ).toThrow(new RangeError(`Value ${2 ** 60} is too far from 0 to encode exactly`));
  });

  it('keeps a plain range from refusing what it never refused', () => {
    expect(() => new IndexRange('r', 0, 9).writeValue(new Encoder(), 10)).toThrow(
      new RangeError('Value 10 is above the maximum 9')
    );
  });
});
