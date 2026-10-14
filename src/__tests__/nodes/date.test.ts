/**
 * `p.date()`: timestamps, optionally floored to UTC calendar buckets.
 */

import { p, type DateUnit } from '../../index';
import { mulberry32, trip } from '../support';
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

  it('rejects swapped bounds at construction, even within one bucket', () => {
    expect(() =>
      p
        .date()
        .precision('day')
        .min(new Date('2020-01-01T12:00:00Z'))
        .max(new Date('2020-01-01T06:00:00Z'))
    ).toThrow(
      new RangeError(
        'p.date range is empty: min 2020-01-01T12:00:00.000Z exceeds max 2020-01-01T06:00:00.000Z'
      )
    );
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

  it('rejects a date whose bucket starts before the earliest Date', () => {
    // The first representable instant is mid-April of year -271821.
    expect(() => p.date().precision('month').encode(new Date(-8.64e15))).toThrow(
      'starts before the earliest Date'
    );
    expect(trip(p.date().precision('day'), new Date(-8.64e15))).toEqual(new Date(-8.64e15));
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
});

describe('p.date adaptive', () => {
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
    for (const node of [plain.adaptive(), plain.weights(weights).adaptive({ window: 16 })]) {
      expect(node._radix).toBeUndefined();
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(node, values[0])).toEqual(values[0]);
    }
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).adaptive({ window: 64 })).encode(values)).toEqual(
      p.array(plain.adaptive({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('learns a skew, at most a byte over the static prior of it', () => {
    const values = run(2000, 3);
    const size = (node: typeof plain) => p.array(node).encode(values).length;
    expect(size(plain.adaptive())).toBeLessThan(size(plain));
    expect(size(plain.weights(weights).adaptive())).toBeLessThanOrEqual(
      size(plain.weights(weights)) + 1
    );
  });

  it('written once, spends the bytes of its static form', () => {
    for (const value of run(20, 4)) {
      expect(plain.adaptive().encode(value)).toEqual(plain.encode(value));
      expect(plain.weights(weights).adaptive().encode(value)).toEqual(
        plain.weights(weights).encode(value)
      );
    }
  });

  it('refuses bad options', () => {
    expect(() => plain.adaptive({ window: 0 })).toThrow(
      new RangeError('p.date adaptive window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.date adaptive window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(15).fill(1)]).adaptive()).toThrow(
      new RangeError(
        'p.date adaptive prior 32 and window 1024 overflow with weights totalling 35184372088847'
      )
    );
    expect(() => p.date().min(new Date(0)).adaptive()).toThrow(
      new TypeError('p.date adaptive requires both bounds')
    );
    const cdf = new TypeError('p.date adaptive takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).adaptive()).toThrow(cdf);
    expect(() => plain.adaptive().cdf((v) => v)).toThrow(cdf);
  });
});
