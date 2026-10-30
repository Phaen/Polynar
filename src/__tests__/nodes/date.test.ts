/**
 * `p.date()`: timestamps, optionally floored to UTC calendar buckets.
 */

import { p, type DateUnit } from '../../index';
import { mulberry32, trip } from '../support';
import { STRUCT } from '../../predictor/types';
import { calendar, checkInRange, iso, utcMonthStart } from '../../nodes/date';

describe('Schema date', () => {
  it.each([
    ['day', 1, '2026-03-14T13:45:00Z', '2026-03-14T00:00:00.000Z'],
    // 2026-03-14 is a Saturday; weeks start on Monday.
    ['week', 1, '2026-03-14T13:45:00Z', '2026-03-09T00:00:00.000Z'],
    ['month', 1, '2026-03-14T13:45:00Z', '2026-03-01T00:00:00.000Z'],
    ['month', 3, '2026-05-20T00:00:00Z', '2026-04-01T00:00:00.000Z'],
    ['year', 1, '2026-03-14T13:45:00Z', '2026-01-01T00:00:00.000Z'],
    ['year', 10, '2026-03-14T13:45:00Z', '2020-01-01T00:00:00.000Z'],
    ['minute', 15, '2026-03-14T13:52:30Z', '2026-03-14T13:45:00.000Z'],
    ['hour', 6, '2026-03-14T13:00:00Z', '2026-03-14T12:00:00.000Z'],
    ['second', 1, '2026-03-14T13:00:01.999Z', '2026-03-14T13:00:01.000Z'],
    ['day', 1, '1969-12-31T23:00:00Z', '1969-12-31T00:00:00.000Z'],
    ['year', 1, '0050-06-15T12:00:00Z', '0050-01-01T00:00:00.000Z'],
    ['month', 1, '-000500-07-04T12:00:00Z', '-000500-07-01T00:00:00.000Z'],
    ['year', 3, '-000500-07-04T12:00:00Z', '-000501-01-01T00:00:00.000Z'],
  ] as [DateUnit, number, string, string][])(
    'floors to the start of a %s bucket of %i: %s',
    (unit, step, iso, start) => {
      expect(trip(p.date().precision(unit, step), new Date(iso)).toISOString()).toBe(start);
    }
  );

  it.each([
    'millisecond',
    'second',
    'minute',
    'hour',
    'day',
    'week',
    'month',
    'year',
  ] as DateUnit[])('re-encodes a %s bucket identically from unfloored input', (unit) => {
    for (const step of [1, 7]) {
      const node = p.date().precision(unit, step);
      for (const v of [new Date('2026-03-14T13:45:12.345Z'), new Date('1912-04-15T02:20:00Z')]) {
        const bytes = node.encode(v);
        expect(node.encode(node.decode(bytes))).toEqual(bytes);
      }
    }
  });

  it('packs a bounded month range as one slot', () => {
    const node = p
      .date()
      .min(new Date('2026-01-01Z'))
      .max(new Date('2026-12-31Z'))
      .precision('month');
    expect(node.encode(new Date('2026-08-17T09:00:00Z')).length).toBe(1);
  });

  it('admits whole buckets, so a mid-bucket min decodes before itself', () => {
    const node = p.date().min(new Date('2026-03-14T13:00:00Z')).precision('day');
    const midnight = new Date('2026-03-14T00:00:00Z');
    expect(trip(node, new Date('2026-03-14T18:00:00Z')).getTime()).toBe(midnight.getTime());
    expect(trip(node, new Date('2026-03-14T12:00:00Z')).getTime()).toBe(midnight.getTime());
    expect(trip(node, midnight).getTime()).toBe(midnight.getTime());
    expect(() => node.encode(new Date('2026-03-13T23:59:59Z'))).toThrow(
      'Date 2026-03-13T23:59:59.000Z is below the minimum 2026-03-14T00:00:00.000Z'
    );
  });

  it('names the bound a date breaks and rejects invalid dates', () => {
    const node = p.date().min(new Date('2020-01-01Z')).max(new Date('2021-01-01Z'));
    expect(() => node.encode(new Date('2019-12-31Z'))).toThrow(
      new RangeError('Date 2019-12-31T00:00:00.000Z is below the minimum 2020-01-01T00:00:00.000Z')
    );
    expect(() => node.encode(new Date('2021-01-02Z'))).toThrow(
      new RangeError('Date 2021-01-02T00:00:00.000Z is above the maximum 2021-01-01T00:00:00.000Z')
    );
    // A bound whose bucket starts before the earliest Date shows as that start's timestamp.
    expect(() => p.date().max(-8.64e15).precision('week').encode(new Date(0))).toThrow(
      'Date 1970-01-01T00:00:00.000Z is above the maximum -8640000086400000'
    );
    expect(() => node.encode(new Date(NaN))).toThrow(
      new TypeError('p.date expected a valid Date, got Invalid Date')
    );
  });

  it('rejects swapped bounds at construction, unless they share a bucket', () => {
    const oneDay = p
      .date()
      .precision('day')
      .min(new Date('2020-01-01T12:00:00Z'))
      .max(new Date('2020-01-01T06:00:00Z'));
    expect(trip(oneDay, new Date('2020-01-01T09:00:00Z'))).toEqual(new Date('2020-01-01Z'));
    expect(() => p.date().min(new Date('2021-01-01Z')).max(new Date('2020-01-01Z'))).toThrow(
      new RangeError(
        'p.date range is empty: min 2021-01-01T00:00:00.000Z exceeds max 2020-01-01T00:00:00.000Z'
      )
    );
  });

  it('refuses a bound outside the Date range at construction', () => {
    expect(() => p.date().min(-8.64e15 - 1)).toThrow(
      new RangeError('p.date min -8640000000000001 is outside the Date range ±8640000000000000')
    );
    expect(() => p.date().max(9e15)).toThrow(
      new RangeError('p.date max 9000000000000000 is outside the Date range ±8640000000000000')
    );
  });

  it('spans the whole Date range at a coarse precision, in any refinement order', () => {
    const daily = p.date().precision('day').min(new Date(-8.64e15)).max(new Date(8.64e15));
    const d = new Date('2020-06-15T00:00:00Z');
    expect(trip(daily, d).getTime()).toBe(d.getTime());
  });

  it('rejects a step that is not a positive integer and fractional timestamp bounds', () => {
    expect(() => p.date().precision('day', 0)).toThrow(RangeError);
    expect(() => p.date().precision('day', 1.5)).toThrow(
      new RangeError('p.date precision step must be a positive integer, got 1.5')
    );
    expect(() => p.date().min(1.5)).toThrow('bounds must be Dates or integer timestamps');
  });

  it('reads the bucket that starts before the earliest Date as the earliest Date', () => {
    // The first representable instant is mid-April of year -271821.
    const earliest = new Date(-8.64e15);
    for (const unit of ['week', 'month', 'year'] as const) {
      expect(trip(p.date().precision(unit), earliest)).toEqual(earliest);
      expect(trip(p.date().precision(unit), new Date(-8.64e15 + 1e6))).toEqual(earliest);
      expect(trip(p.date().precision(unit).min(earliest).max(0), earliest)).toEqual(earliest);
    }
    expect(trip(p.date().precision('day'), earliest)).toEqual(earliest);
  });

  it('reads a bucket past the Date range as corrupt input', () => {
    // A min-only date reads its bucket like a min-only int, so an int can
    // forge a bucket the encoder never could.
    const late = p.date().min(new Date(8.64e15)).precision('day');
    expect(() => late.decode(p.int().min(0).encode(1))).toThrow('representable time range');
  });
});

describe('calendar', () => {
  it.each([0, -1, 1.5, NaN, Infinity])('refuses step %p', (step) => {
    expect(() => calendar('day', step)).toThrow(
      new RangeError(`p.date precision step must be a positive integer, got ${step}`)
    );
  });

  it('puts the epoch in bucket 0 for every unit', () => {
    const units: DateUnit[] = ['millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month'];
    for (const unit of [...units, 'year' as const]) {
      for (const step of [1, 3]) {
        const cal = calendar(unit, step);
        expect(cal.index(0)).toBe(0);
        expect(cal.start(0)).toBeLessThanOrEqual(0);
        expect(cal.index(cal.start(1))).toBe(1);
        expect(cal.index(cal.start(1) - 1)).toBe(0);
      }
    }
    expect(calendar('week', 1).start(0)).toBe(Date.UTC(1969, 11, 29));
    expect(calendar('month', 7).start(0)).toBe(Date.UTC(1969, 11, 1));
    expect(calendar('year', 10).start(0)).toBe(Date.UTC(1970, 0, 1));
  });

  it('starts a bucket past the Date range outside it', () => {
    expect(calendar('day', 1).start(1e8 + 1)).toBe(8.64e15 + 86_400_000);
    expect(calendar('month', 1).start(4e6)).toBeNaN();
    expect(calendar('year', 1).start(-3e5)).toBeNaN();
  });
});

describe('utcMonthStart', () => {
  it('keeps years 0-99 literal', () => {
    expect(utcMonthStart(1970, 0)).toBe(0);
    expect(utcMonthStart(99, 0)).toBe(new Date('0099-01-01T00:00:00Z').getTime());
    expect(utcMonthStart(0, 1)).toBe(new Date('0000-02-01T00:00:00Z').getTime());
    expect(utcMonthStart(-1, 11)).toBe(new Date('-000001-12-01T00:00:00Z').getTime());
  });

  it('rolls a month outside 0-11 into a neighbouring year and truncates fractions', () => {
    expect(utcMonthStart(1970, 12)).toBe(Date.UTC(1971, 0, 1));
    expect(utcMonthStart(1970, -1)).toBe(Date.UTC(1969, 11, 1));
    expect(utcMonthStart(1970.9, 1.7)).toBe(Date.UTC(1970, 1, 1));
  });

  it('is NaN outside the Date range', () => {
    expect(utcMonthStart(275761, 0)).toBeNaN();
    expect(utcMonthStart(NaN, 0)).toBeNaN();
    expect(utcMonthStart(1970, Infinity)).toBeNaN();
  });
});

describe('iso', () => {
  it('spells a valid timestamp as ISO and anything else as the number', () => {
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(iso(-8.64e15)).toBe('-271821-04-20T00:00:00.000Z');
    expect(iso(8.64e15 + 1)).toBe('8640000000000001');
    expect(iso(NaN)).toBe('NaN');
    expect(iso(-Infinity)).toBe('-Infinity');
  });
});

describe('checkInRange', () => {
  it('passes a bound within the Date range or none', () => {
    for (const bound of [undefined, 0, 8.64e15, -8.64e15]) {
      expect(() => checkInRange(bound, 'min')).not.toThrow();
    }
  });

  it.each([8.64e15 + 1, -8.64e15 - 1, Infinity, NaN])('refuses %p', (bound) => {
    expect(() => checkInRange(bound, 'max')).toThrow(
      new RangeError(`p.date max ${bound} is outside the Date range ±8640000000000000`)
    );
  });
});

describe('Digit reads', () => {
  it('map a digit only with both bounds and no prior', () => {
    const day = new Date('2020-01-01Z');
    const bounded = p.date().min(day).max(new Date('2020-01-03Z')).precision('day');
    expect(bounded._fromDigit?.(2)).toEqual(new Date('2020-01-03Z'));
    expect(p.date()._fromDigit).toBeUndefined();
    expect(p.date().min(day)._fromDigit).toBeUndefined();
    expect(bounded.weights([1, 1, 1])._fromDigit).toBeUndefined();
  });

  it('map a value to its digit only with both bounds and no prior, throwing as a write does', () => {
    const day = new Date('2020-01-01Z');
    const bounded = p.date().min(day).max(new Date('2020-01-03Z')).precision('day');
    expect(bounded._toDigit?.(new Date('2020-01-02T18:00Z'))).toBe(1);
    expect(() => bounded._toDigit?.(new Date(NaN))).toThrow(
      new TypeError('p.date expected a valid Date, got Invalid Date')
    );
    expect(() => bounded._toDigit?.(new Date('2020-01-04Z'))).toThrow(
      new RangeError('Date 2020-01-04T00:00:00.000Z is above the maximum 2020-01-03T00:00:00.000Z')
    );
    expect(p.date()._toDigit).toBeUndefined();
    expect(bounded.weights([1, 1, 1])._toDigit).toBeUndefined();
    const earliest = p.date().min(-8.64e15).max(-8.6e15).precision('week');
    expect(earliest._fromDigit?.(0)).toEqual(new Date(-8.64e15));
  });
});

describe('p.date().compress()', () => {
  const start = Date.UTC(2024, 0, 1);
  const random = (length: number, seed: number, lo: number, hi: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => new Date((lo + Math.floor(rnd() * (hi - lo + 1))) * 1000));
  };
  const constant = Array.from({ length: 200 }, () => new Date(start));
  const counter = Array.from({ length: 200 }, (_, i) => new Date(start + i * 1000));
  const seconds = p.date().precision('second');

  it.each([
    ['unbounded', p.date().compress(), random(200, 1, -1e12, 1e12)],
    ['to the second', seconds.compress(), random(200, 2, -1e9, 1e9)],
    [
      'bounded',
      seconds
        .min(new Date(start - 1e9))
        .max(new Date(start + 1e9))
        .compress(),
      random(200, 3, start / 1000 - 1e6, start / 1000 + 1e6),
    ],
    [
      'min-only',
      seconds.min(new Date(start - 1e9)).compress(),
      random(200, 4, start / 1000 - 1e6, 1e10),
    ],
    [
      'max-only',
      seconds.max(new Date(start + 1e9)).compress(),
      random(200, 5, -1e10, start / 1000 + 1e6),
    ],
    [
      'weighted',
      seconds
        .min(new Date(start - 1e6))
        .max(new Date(start + 1e6))
        .weights(Array.from({ length: 2001 }, (_, i) => 1 + (i % 7)))
        .compress(),
      random(200, 6, start / 1000 - 1000, start / 1000 + 1000),
    ],
    [
      'under a cdf',
      seconds
        .min(new Date(start - 1e6))
        .max(new Date(start + 1e6))
        .cdf((b) => (b - start / 1000 + 1000) * 2)
        .compress(),
      random(200, 7, start / 1000 - 1000, start / 1000 + 1000),
    ],
  ])('round-trips a constant, a counter and random dates, %s', (_name, node, values) => {
    for (const run of [constant, counter, values]) {
      expect(trip(p.array(node), run)).toEqual(run);
    }
    expect(trip(node, values[0])).toEqual(values[0]);
  });

  it('floors a date to its precision', () => {
    expect(trip(seconds.compress(), new Date(start + 1999))).toEqual(new Date(start + 1000));
  });

  it('learns what repeats', () => {
    const size = (values: Date[]) => p.array(seconds.compress()).encode(values).length;
    expect(size(constant)).toBeLessThan(40);
    expect(size(counter)).toBeLessThan(size(random(200, 8, start / 1000, start / 1000 + 199)));
  });

  it('round-trips inside an object', () => {
    const node = p.array(p.object({ at: seconds.compress(), sent: seconds.compress() }));
    const values = counter.map((at, i) => ({ at, sent: new Date(at.getTime() + (i % 3) * 1000) }));
    expect(trip(node, values)).toEqual(values);
  });

  it('round-trips one node reused in two fields', () => {
    const node = seconds.compress();
    const values = [
      { a: new Date(start), b: new Date(start) },
      { a: new Date(start + 5000), b: new Date(0) },
    ];
    expect(trip(p.array(p.object({ a: node, b: node })), values)).toEqual(values);
  });

  it('keeps its options through a rebuild', () => {
    const declared = p.array(seconds.min(new Date(start)).compress({ history: 2 }));
    expect(
      p
        .array(p.date().compress({ history: 2 }).min(new Date(start)).precision('second'))
        .encode(counter)
    ).toEqual(declared.encode(counter));
  });

  it('maps no digit with both bounds', () => {
    const node = p
      .date()
      .min(new Date(start))
      .max(new Date(start + 2 * 86_400_000))
      .precision('day')
      .compress();
    expect(node._radix).toBeUndefined();
    expect(node._fromDigit).toBeUndefined();
    expect(node._toDigit).toBeUndefined();
  });

  it('refuses options out of range, not an object, set twice or beside adapt', () => {
    expect(() => p.date().compress({ history: 0 })).toThrow(
      new RangeError('p.date: compress history must be in 1..4096, got 0')
    );
    expect(() => p.date().compress(null as never)).toThrow(
      new TypeError('p.date: compress options must be an object')
    );
    expect(() => p.date().compress().compress()).toThrow(
      new TypeError('p.date compress is already set')
    );
    const both = new TypeError('p.date adapt and compress cannot both be set');
    expect(() => p.date().adapt().compress()).toThrow(both);
    expect(() => p.date().compress().adapt()).toThrow(both);
  });

  it('refuses a date the plain node refuses, before learning from it', () => {
    const bounded = p.date().min(new Date(0)).max(new Date(1000)).compress();
    expect(() => bounded.encode(new Date(1001))).toThrow(
      new RangeError('Date 1970-01-01T00:00:01.001Z is above the maximum 1970-01-01T00:00:01.000Z')
    );
    expect(() => p.date().compress().encode(new Date(NaN))).toThrow(
      new TypeError('p.date expected a valid Date, got Invalid Date')
    );
    const day = p
      .date()
      .min(new Date('2020-01-01Z'))
      .max(new Date('2020-01-03Z'))
      .precision('day')
      .cdf((d) => (d - 18262 <= 1 ? 0 : 10))
      .compress();
    expect(() => day.encode(new Date('2020-01-01T12:00:00Z'))).toThrow(
      new RangeError('Date 2020-01-01T12:00:00.000Z has zero weight under the declared cdf')
    );
    expect(() =>
      p
        .date()
        .min(new Date(-8.6e15))
        .compress()
        .encode(new Date(8.6e15 + 1))
    ).toThrow(
      new RangeError(
        'Value +274493-02-24T00:53:20.001Z is too far from its bound -270554-11-06T23:06:40.000Z to encode exactly'
      )
    );
    expect(() =>
      p
        .date()
        .max(new Date(8.6e15))
        .compress()
        .encode(new Date(-8.6e15 - 1))
    ).toThrow(
      new RangeError(
        'Value -270554-11-06T23:06:39.999Z is too far from its bound +274493-02-24T00:53:20.000Z to encode exactly'
      )
    );
  });
});

describe('p.date adapt', () => {
  const DAY = 86_400_000;
  const plain = p
    .date()
    .precision('day')
    .min(new Date(0))
    .max(new Date(15 * DAY));
  const weights = Array.from({ length: 16 }, (_, i) => (i === 3 ? 61 : 1));
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => new Date((rnd() < 0.8 ? 3 : Math.floor(rnd() * 16)) * DAY));
  };

  it('round-trips a run of values, inside an array too', () => {
    const values = run(300, 1);
    for (const node of [plain.adapt(), plain.weights(weights).adapt({ window: 16 })]) {
      expect(node._radix).toBeUndefined();
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(node, values[0])).toEqual(values[0]);
    }
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).adapt({ window: 64 })).encode(values)).toEqual(
      p.array(plain.adapt({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('learns a skew, staying near the static prior of it', () => {
    const values = run(2000, 3);
    const size = (node: typeof plain) => p.array(node).encode(values).length;
    expect(size(plain.adapt())).toBeLessThan(size(plain));
    expect(size(plain.weights(weights).adapt())).toBeLessThanOrEqual(
      Math.ceil(size(plain.weights(weights)) * 1.05)
    );
  });

  it('takes its learning options, once', () => {
    const values = run(200, 4);
    expect(p.array(plain.adapt({ window: 8 })).encode(values)).not.toEqual(
      p.array(plain.adapt()).encode(values)
    );
    expect(() => plain.adapt().adapt()).toThrow(new TypeError('p.date adapt is already set'));
  });

  it('refuses bad options', () => {
    expect(() => plain.adapt({ window: 0 })).toThrow(
      new RangeError('p.date learning window must be a positive integer, got 0')
    );
    expect(() => plain.adapt({ window: 1.5 })).toThrow(
      new TypeError('p.date learning window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(15).fill(1)]).adapt()).toThrow(
      new RangeError(
        'p.date adaptive prior 32 and window 1024 overflow with weights totalling 35184372088847'
      )
    );
    const cdf = new TypeError('p.date adapt takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).adapt()).toThrow(cdf);
    expect(() => plain.adapt().cdf((v) => v)).toThrow(cdf);
  });

  it('learns on the magnitude scale over an unbounded or wide range', () => {
    const values = [new Date(0), new Date(5 * DAY), new Date(-3 * DAY), new Date(5 * DAY)];
    expect(trip(p.array(p.date().precision('day').adapt()), values)).toEqual(values);
    expect(trip(p.array(p.date().adapt()), values)).toEqual(values);
  });

  it('refuses a date outside the bounds before learning from it', () => {
    expect(() => plain.adapt().encode(new Date(16 * DAY))).toThrow(RangeError);
  });
});

describe('p.date methods', () => {
  it('refuses adapt beside compress, either order', () => {
    const both = new TypeError('p.date adapt and compress cannot both be set');
    expect(() => p.date().compress().adapt()).toThrow(both);
    expect(() => p.date().adapt().compress()).toThrow(both);
  });

  it('sets its precision once, the millisecond default not counting', () => {
    expect(() => p.date().precision('day').precision('day')).toThrow(
      new TypeError('p.date precision is already set')
    );
    expect(() => p.date().precision('day', 2).precision('second')).toThrow(
      new TypeError('p.date precision is already set')
    );
    expect(p.date().precision('millisecond').precision('day')).toBeDefined();
  });

  it('keeps a learner or a compressed node as it is under a container sugar', () => {
    const learner = p.date().adapt();
    const compress = p.date().compress({ window: 8 });
    expect(learner._adapted({})).toBe(learner);
    expect(compress._adapted({ window: 16 })).toBe(compress);
    const plain = p.date();
    const adapted = plain._adapted({ window: 16 });
    expect(adapted).not.toBe(plain);
    expect(adapted._compress).toEqual({ window: 16 });
  });

  it('names the date marker, its only one', () => {
    expect(p.date()._marker()).toBe(STRUCT.DATE);
    expect(p.date()._markers()).toEqual(new Set([STRUCT.DATE]));
  });
});
