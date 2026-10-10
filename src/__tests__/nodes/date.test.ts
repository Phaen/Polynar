/**
 * `p.date()`: timestamps, optionally floored to UTC calendar buckets.
 */

import { p, type DateUnit } from '../../index';
import { trip } from '../support';

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
