/**
 * The bound rules every lattice-backed node shares: int, decimal and date
 * values, and string, binary and array lengths. Bounds are set once, length
 * bounds are non-negative integers, a range must be non-empty and span at
 * most 2^53 values, and a value on a lone bound must sit within exact reach
 * of it. IndexRange and the length helpers are also tested directly.
 */

import { p, Encoder, Decoder, CorruptInputError } from '../../index';
import {
  Delta,
  IndexMethods,
  IndexRange,
  checkUnset,
  lengthBound,
  lengthRange,
} from '../../nodes/lattice';
import { LearnedMagnitude, STATIC_MAGNITUDE } from '../../nodes/magnitude';
import { ModeChoice } from '../../nodes/methods';
import { Recall } from '../../nodes/recall';
import { AdaptivePrior, MAX_ADAPTIVE_MEMBERS, withoutRecall } from '../../nodes/adaptive';
import type { PNode } from '../../nodes/base';
import { mulberry32, trip } from '../support';
import { buildWeights, readTable } from '../../nodes/weights';

const adaptation = { window: 1024 };
/** Adaptation with the node's own recall closed, for methods modelled without it. */
const closed = withoutRecall({});
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
      new TypeError('r adaptive takes weights, not a cdf')
    );
    expect(
      () =>
        new IndexRange('r', 1, MAX_ADAPTIVE_MEMBERS + 1, ones(MAX_ADAPTIVE_MEMBERS + 1), adaptation)
    ).toThrow(new RangeError('r adaptive prior spans 65537 values, above the limit 65536'));
    const widest = new IndexRange('r', 1, MAX_ADAPTIVE_MEMBERS, undefined, {});
    expect(widest.adaptive).toEqual({});
    expect(widest.prior).toBeUndefined();
    expect(roundTrip(widest, [1, MAX_ADAPTIVE_MEMBERS])).toEqual([1, MAX_ADAPTIVE_MEMBERS]);
    expect(() => new IndexRange('r', 0, 2, [1, 1], adaptation)).toThrow(
      new TypeError('r weights must list one weight per value: expected 3, got 2')
    );
    expect(() => new IndexRange('r', 0, 1, [2 ** 50, 1], adaptation)).toThrow(
      new RangeError(
        `r adaptive prior 4 and window 1024 overflow with weights totalling ${2 ** 50 + 1}`
      )
    );
    expect(new IndexRange('r', 0, 1).adaptive).toBeUndefined();
    expect(() => new IndexRange('r', 0, 1, undefined, { window: 1.5 })).toThrow(
      new TypeError('r adaptive window must be a positive integer, got 1.5')
    );
    expect(() => lengthRange({ max: 1, adaptive: { window: 0 } }, 'w', 'count')).toThrow(
      new RangeError('w adaptive window must be a positive integer, got 0')
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
    }
    const bytes = enc.output();
    const ranged = new Encoder();
    for (const index of indices) {
      range.write(ranged, index);
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
    const range = new IndexRange('r', 0, MAX_ADAPTIVE_MEMBERS - 1, undefined, {});
    const plain = new IndexRange('r', 0, MAX_ADAPTIVE_MEMBERS - 1);
    const write = (into: IndexRange): Uint8Array => {
      const enc = new Encoder();
      for (const index of indices) {
        into.write(enc, index);
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
    const open = lengthRange({ min: 1, adaptive: adaptation }, 'w', 'length');
    expect([open.lo, open.hi, open.adaptive]).toEqual([1, undefined, adaptation]);
    expect(roundTrip(open, [1, 2, 900, 2])).toEqual([1, 2, 900, 2]);
    expect(() => lengthRange({ prior: [1], adaptive: adaptation }, 'w', 'count')).toThrow(
      new TypeError('w weights requires a max count')
    );
    const range = lengthRange(
      { min: 1, max: 3, prior: [1, 2, 3], adaptive: adaptation },
      'w',
      'count'
    );
    expect([range.lo, range.hi, range.radix, range.adaptive]).toEqual([
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
      }
      const ours = new Encoder();
      for (const index of indices) {
        range.write(ours, index);
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
    expect(learned.available(enc)).toBe(true);
    // The first value is spelled by the static weights, the later ones by
    // what the message taught.
    learned.write(enc, 5);
    for (const offset of [below, above, 0.5]) {
      const mark = enc.mark();
      expect(() => learned.write(enc, offset)).toThrow();
      enc.rollback(mark);
      learned.learn(enc, offset);
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
      `r adaptive prior spans ${2 ** 20 + 1} values, above the limit 65536`
    );
  });
});

/** A message of `indices` written by `methods`, and read back by the same node's methods. */
const methodsTrip = (methods: IndexMethods, indices: readonly number[]) => {
  const enc = new Encoder();
  for (const index of indices) {
    methods.write(enc, index);
  }
  const bytes = enc.output();
  const dec = new Decoder(bytes);
  const back = indices.map(() => methods.read(dec));
  dec.finalize();
  return { bytes, back };
};

describe('IndexMethods', () => {
  const random = mulberry32(5);
  const walk = (length: number, lo: number, hi: number): number[] => {
    let at = Math.floor((lo + hi) / 2);
    return Array.from({ length }, () => {
      const r = random();
      at =
        r < 0.3
          ? at
          : r < 0.9
            ? at + Math.floor(random() * 9) - 3
            : lo + Math.floor(random() * (hi - lo + 1));
      at = Math.min(hi, Math.max(lo, at));
      return at;
    });
  };

  it('spells as the range does with no method declared', () => {
    for (const range of [
      new IndexRange('r', 0, 9),
      new IndexRange('r'),
      new IndexRange('r', 0, 2, [1, 2, 3]),
    ]) {
      const methods = new IndexMethods(range, {}, 'r');
      expect(methods.plain).toBe(true);
      const indices = [2, 0, 1, 1];
      const enc = new Encoder();
      for (const index of indices) {
        range.write(enc, index);
      }
      expect(methodsTrip(methods, indices)).toEqual({ bytes: enc.output(), back: indices });
    }
  });

  it('spells a declared difference on the static scale after the first value', () => {
    const range = new IndexRange('r', -5, 100);
    const methods = new IndexMethods(range, { delta: true }, 'r');
    expect(methods.plain).toBe(false);
    const indices = [7, 8, 8, -5, 100, 99];
    const model = new Encoder();
    range.write(model, 7);
    for (let i = 1; i < indices.length; i++) {
      STATIC_MAGNITUDE.write(model, indices[i] + 5, indices[i - 1] + 5, 0, 105);
    }
    expect(methodsTrip(methods, indices)).toEqual({ bytes: model.output(), back: indices });
  });

  it('spells a declared difference on the learned scale under adaptation, the first value learned plain', () => {
    const range = new IndexRange('r', undefined, undefined, undefined, closed);
    const methods = new IndexMethods(range, { delta: true }, 'r');
    const indices = [1000, 1001, 1003, 1002, -7];
    const model = new Encoder();
    const scale = new LearnedMagnitude(true, {}, 'r');
    new IndexRange('r', undefined, undefined, undefined, {}).write(model, 1000);
    for (let i = 1; i < indices.length; i++) {
      scale.write(model, indices[i], indices[i - 1], -MAX_SAFE, MAX_SAFE);
    }
    expect(methodsTrip(methods, indices)).toEqual({ bytes: model.output(), back: indices });
  });

  it('refuses a difference under weights or a cdf', () => {
    expect(() => new IndexMethods(new IndexRange('r', 0, 1, [1, 1]), { delta: true }, 'r')).toThrow(
      new TypeError('r delta takes no weights')
    );
    expect(
      () => new IndexMethods(new IndexRange('r', 0, 1, (v) => v), { delta: true }, 'r')
    ).toThrow(new TypeError('r delta takes no cdf'));
    expect(
      () => new IndexMethods(new IndexRange('r', 0, 1, [1, 1], {}), { delta: true }, 'r')
    ).toThrow(new TypeError('r delta takes no weights'));
  });

  it('picks per value between plain and the difference under adaptation, as a ModeChoice over the same methods', () => {
    const indices = walk(400, 0, 999);
    const range = new IndexRange('r', 0, 999, undefined, closed);
    const { bytes, back } = methodsTrip(new IndexMethods(range, {}, 'r'), indices);
    expect(back).toEqual(indices);
    // The same mode and methods, built by hand: plain the range's learned
    // spelling, the difference its offset from the previous one.
    const twin = new IndexRange('r', 0, 999, undefined, {});
    const scale = new LearnedMagnitude(true, {}, 'r');
    const previous = { offset: undefined as number | undefined };
    const plainMethod = twin.learned;
    if (plainMethod === undefined) {
      throw new Error('not learned');
    }
    const delta = {
      available: () => previous.offset !== undefined,
      write: (enc: Encoder, offset: number) =>
        scale.write(enc, offset, previous.offset as number, 0, 999),
      read: () => 0,
      learn: (enc: Encoder | Decoder, offset: number) =>
        scale.learn(enc, offset, previous.offset as number, 0, 999),
    };
    const mode = new ModeChoice([plainMethod, delta], {}, 'r');
    const model = new Encoder();
    for (const index of indices) {
      mode.write(model, index);
      previous.offset = index;
    }
    expect(bytes).toEqual(model.output());
    // The plain spelling over a run of differences is dearer.
    expect(bytes.length).toBeLessThan(
      methodsTrip(new IndexMethods(new IndexRange('r', 0, 999), {}, 'r'), indices).bytes.length
    );
  });

  it('spends nothing on a mode for a single value', () => {
    for (const [lo, hi] of [
      [0, 999],
      [0, undefined],
      [undefined, undefined],
    ] as const) {
      const range = new IndexRange('r', lo, hi, undefined, {});
      const enc = new Encoder();
      range.write(enc, 7);
      expect(
        methodsTrip(new IndexMethods(new IndexRange('r', lo, hi, undefined, {}), {}, 'r'), [7])
          .bytes
      ).toEqual(enc.output());
    }
  });

  it.each([
    ['plain', new IndexRange('r', 0, 99), {}],
    ['a difference', new IndexRange('r'), { delta: true as const }],
    ['wide adaptation', new IndexRange('r', 0, 2 ** 20, undefined, closed), {}],
    [
      'a learned difference',
      new IndexRange('r', -50, undefined, undefined, closed),
      { delta: true as const },
    ],
    ['weights', new IndexRange('r', 0, 99, ones(100)), {}],
  ])('recalls a value already written before %s', (_name, range, spelling) => {
    // A few values far apart, each coming back often.
    const picks = [3, 97, 41, 66, 12];
    const indices = Array.from({ length: 400 }, () => picks[Math.floor(random() * picks.length)]);
    const recalled = new IndexMethods(range, { ...spelling, recall: true }, 'r');
    const { bytes, back } = methodsTrip(recalled, indices);
    expect(back).toEqual(indices);
    expect(bytes.length).toBeLessThan(
      methodsTrip(new IndexMethods(range, spelling, 'r'), indices).bytes.length
    );
  });

  it('measures the difference from a recalled value', () => {
    const range = new IndexRange('r', 0, 1000);
    const methods = new IndexMethods(range, { delta: true, recall: true }, 'r');
    const indices = [500, 900, 500, 501];
    const model = new Encoder();
    range.write(model, 500);
    model.compose(0, 2);
    STATIC_MAGNITUDE.write(model, 900, 500, 0, 1000);
    model.compose(1, 3);
    model.compose(0, 3);
    STATIC_MAGNITUDE.write(model, 501, 500, 0, 1000);
    expect(methodsTrip(methods, indices)).toEqual({ bytes: model.output(), back: indices });
  });

  it('teaches a recalled value to the methods that could have spelled it', () => {
    const indices = [100, 103, 100, 104];
    const methods = new IndexMethods(
      new IndexRange('r', undefined, undefined, undefined, {}),
      { delta: true, recall: true },
      'r'
    );
    const model = new Encoder();
    const recall = new Recall<number>(true);
    const scale = new LearnedMagnitude(true, {}, 'r');
    const plain = new IndexRange('r', undefined, undefined, undefined, {});
    recall.write(model, '100', () => plain.write(model, 100));
    recall.write(model, '103', () => scale.write(model, 103, 100, -MAX_SAFE, MAX_SAFE));
    recall.write(model, '100', () => undefined);
    scale.learn(model, 100, 103, -MAX_SAFE, MAX_SAFE);
    recall.write(model, '104', () => scale.write(model, 104, 100, -MAX_SAFE, MAX_SAFE));
    expect(methodsTrip(methods, indices)).toEqual({ bytes: model.output(), back: indices });
    // Under the mode, plain learns it as well; both sides agree.
    const random = mulberry32(8);
    const many = Array.from({ length: 300 }, () => [5, 900, 40000][Math.floor(random() * 3)]);
    const moded = new IndexMethods(
      new IndexRange('r', 0, 2 ** 20, undefined, {}),
      { recall: true },
      'r'
    );
    expect(methodsTrip(moded, many).back).toEqual(many);
  });

  it('matches -0 to 0 and refuses what the range refuses', () => {
    const methods = new IndexMethods(new IndexRange('r', -1, 1), { recall: true }, 'r');
    const { back } = methodsTrip(methods, [-0, 0]);
    expect(back.map((v) => Object.is(v, 0))).toEqual([true, true]);
    expect(() => methods.write(new Encoder(), 2, () => 'Item')).toThrow(
      new RangeError('Item is above the maximum 1')
    );
    expect(() =>
      new IndexMethods(new IndexRange('r', 0), { delta: true }, 'r').write(new Encoder(), 2 ** 60)
    ).toThrow(new RangeError(`Value ${2 ** 60} is too far from 0 to encode exactly`));
  });

  it("reads a first value out of the origin's exact reach as corrupt", () => {
    const bytes = new Encoder();
    new IndexRange('r', 0).write(bytes, 2 ** 60);
    const methods = new IndexMethods(new IndexRange('r', 0), { delta: true }, 'r');
    expect(() => methods.read(new Decoder(bytes.output()))).toThrow(
      new CorruptInputError('Index is outside the exact range of its origin')
    );
  });

  it('round-trips random walks under every combination of methods', () => {
    const ranges: [number | undefined, number | undefined][] = [
      [0, 50],
      [-20, undefined],
      [undefined, 70],
      [undefined, undefined],
      [0, 100000],
    ];
    for (const [lo, hi] of ranges) {
      for (const adaptive of [undefined, {}]) {
        for (const spelling of [
          {},
          { delta: true as const },
          { recall: true as const },
          { delta: true as const, recall: true as const },
        ]) {
          const indices = walk(150, 0, 50);
          const methods = new IndexMethods(
            new IndexRange('r', lo, hi, undefined, adaptive),
            spelling,
            'r'
          );
          expect(methodsTrip(methods, indices).back).toEqual(indices);
        }
      }
    }
  });
});

describe('Delta', () => {
  it('is available once it follows a previous offset, on each side apart', () => {
    const delta = new Delta(STATIC_MAGNITUDE, 0, 10);
    const enc = new Encoder();
    const dec = new Decoder(new Uint8Array());
    expect([delta.available(enc), delta.available(dec)]).toEqual([false, false]);
    delta.follow(enc, 4);
    expect([delta.available(enc), delta.available(dec)]).toEqual([true, false]);
  });

  it('writes the static scale from the previous offset, and throws on what it cannot spell', () => {
    const delta = new Delta(STATIC_MAGNITUDE, 0, 10);
    const enc = new Encoder();
    expect(() => delta.write(enc, 5)).toThrow(TypeError);
    delta.follow(enc, 4);
    for (const offset of [-1, 11, 4.5]) {
      expect(() => delta.write(enc, offset)).toThrow();
    }
    delta.write(enc, 7);
    const model = new Encoder();
    STATIC_MAGNITUDE.write(model, 7, 4, 0, 10);
    expect(enc.output()).toEqual(model.output());
  });

  it('writes, reads and learns on the learned scale from the previous offset', () => {
    const delta = new Delta(new LearnedMagnitude(true, {}, 'r'), -100, 100);
    const model = new LearnedMagnitude(true, {}, 'r');
    const enc = new Encoder();
    const twin = new Encoder();
    // Nothing to learn from before a previous offset, nor out of reach.
    delta.learn(enc, 3);
    delta.follow(enc, 0);
    delta.learn(enc, 101);
    for (let i = 0; i < 10; i++) {
      delta.learn(enc, 2);
      model.learn(twin, 2, 0, -100, 100);
    }
    delta.write(enc, 2);
    model.write(twin, 2, 0, -100, 100);
    const bytes = enc.output();
    expect(bytes).toEqual(twin.output());
    const dec = new Decoder(bytes);
    delta.follow(dec, 0);
    for (let i = 0; i < 10; i++) {
      delta.learn(dec, 2);
    }
    expect(delta.read(dec)).toBe(2);
  });
});
