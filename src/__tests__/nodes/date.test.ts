/**
 * Schema date node (`p.date()`) — timestamps with optional UTC calendar buckets.
 */

import { p, type DateUnit } from '../../index';
import { trip } from '../support';

const floored = (unit: DateUnit, step: number, iso: string): string =>
  trip(p.date().precision(unit, step), new Date(iso)).toISOString();

describe('Schema date', () => {
  it('date is lossless at the default precision', () => {
    const d = new Date('2026-06-24T12:30:45.123Z');
    expect(trip(p.date(), d).getTime()).toBe(d.getTime());
    const before1970 = new Date('1955-11-05T06:00:00.000Z');
    expect(trip(p.date(), before1970).getTime()).toBe(before1970.getTime());
  });

  it('p.any keeps its date wire', () => {
    expect(Array.from(p.any().encode(new Date(1700000000000)))).toEqual([
      92, 1, 105, 106, 113, 226, 5,
    ]);
  });

  it('precision floors to the start of a UTC calendar bucket', () => {
    expect(floored('day', 1, '2026-03-14T13:45:00Z')).toBe('2026-03-14T00:00:00.000Z');
    // 2026-03-14 is a Saturday; weeks start on Monday.
    expect(floored('week', 1, '2026-03-14T13:45:00Z')).toBe('2026-03-09T00:00:00.000Z');
    expect(floored('month', 1, '2026-03-14T13:45:00Z')).toBe('2026-03-01T00:00:00.000Z');
    expect(floored('month', 3, '2026-05-20T00:00:00Z')).toBe('2026-04-01T00:00:00.000Z');
    expect(floored('year', 1, '2026-03-14T13:45:00Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(floored('year', 10, '2026-03-14T13:45:00Z')).toBe('2020-01-01T00:00:00.000Z');
    expect(floored('minute', 15, '2026-03-14T13:52:30Z')).toBe('2026-03-14T13:45:00.000Z');
    expect(floored('hour', 6, '2026-03-14T13:00:00Z')).toBe('2026-03-14T12:00:00.000Z');
    expect(floored('second', 1, '2026-03-14T13:00:01.999Z')).toBe('2026-03-14T13:00:01.000Z');
  });

  it('precision floors before 1970 and in early and negative years', () => {
    expect(floored('day', 1, '1969-12-31T23:00:00Z')).toBe('1969-12-31T00:00:00.000Z');
    expect(floored('year', 1, '0050-06-15T12:00:00Z')).toBe('0050-01-01T00:00:00.000Z');
    expect(floored('month', 1, '-000500-07-04T12:00:00Z')).toBe('-000500-07-01T00:00:00.000Z');
    expect(floored('year', 3, '-000500-07-04T12:00:00Z')).toBe('-000501-01-01T00:00:00.000Z');
  });

  it('every precision decodes to a date that re-encodes identically', () => {
    const units: DateUnit[] = [
      'millisecond',
      'second',
      'minute',
      'hour',
      'day',
      'week',
      'month',
      'year',
    ];
    for (const unit of units) {
      for (const step of [1, 7]) {
        const node = p.date().precision(unit, step);
        for (const v of [new Date('2026-03-14T13:45:12.345Z'), new Date('1912-04-15T02:20:00Z')]) {
          const bytes = node.encode(v);
          expect(node.encode(node.decode(bytes))).toEqual(bytes);
        }
      }
    }
  });

  it('date round-trips with bounds and a coarse precision', () => {
    const node = p
      .date()
      .min(new Date('2020-01-01Z'))
      .max(new Date('2021-01-01Z'))
      .precision('day');
    const d = new Date('2020-06-15T00:00:00Z');
    expect(trip(node, d).getTime()).toBe(d.getTime());
  });

  it('a bounded month range packs as one slot', () => {
    const node = p
      .date()
      .min(new Date('2026-01-01Z'))
      .max(new Date('2026-12-31Z'))
      .precision('month');
    expect(node.encode(new Date('2026-08-17T09:00:00Z')).length).toBe(1);
  });

  it('bounds admit whole buckets, so a mid-bucket min decodes before itself', () => {
    const node = p.date().min(new Date('2026-03-14T13:00:00Z')).precision('day');
    const midnight = new Date('2026-03-14T00:00:00Z');
    expect(trip(node, new Date('2026-03-14T18:00:00Z')).getTime()).toBe(midnight.getTime());
    expect(trip(node, new Date('2026-03-14T12:00:00Z')).getTime()).toBe(midnight.getTime());
    expect(trip(node, midnight).getTime()).toBe(midnight.getTime());
    expect(() => node.encode(new Date('2026-03-13T23:59:59Z'))).toThrow(
      "Date '2026-03-13T23:59:59.000Z' is before the minimum 2026-03-14T13:00:00.000Z"
    );
  });

  it('date enforces its bounds and rejects invalid dates', () => {
    const node = p.date().min(new Date('2020-01-01Z')).max(new Date('2021-01-01Z'));
    expect(() => node.encode(new Date('2019-12-31Z'))).toThrow(
      new RangeError(
        "Date '2019-12-31T00:00:00.000Z' is before the minimum 2020-01-01T00:00:00.000Z"
      )
    );
    expect(() => node.encode(new Date('2021-01-02Z'))).toThrow(
      "Date '2021-01-02T00:00:00.000Z' is after the maximum 2021-01-01T00:00:00.000Z"
    );
    // A bound outside the Date range shows as its timestamp.
    expect(() => p.date().min(9e15).encode(new Date(0))).toThrow(
      "Date '1970-01-01T00:00:00.000Z' is before the minimum 9000000000000000"
    );
    expect(() => node.encode(new Date(NaN))).toThrow(TypeError);
  });

  it('date rejects swapped bounds at construction', () => {
    expect(() => p.date().min(new Date('2021-01-01Z')).max(new Date('2020-01-01Z'))).toThrow(
      new RangeError(
        'p.date minimum 2021-01-01T00:00:00.000Z is after the maximum 2020-01-01T00:00:00.000Z'
      )
    );
  });

  it('rejects a step that is not a positive integer', () => {
    expect(() => p.date().precision('day', 0)).toThrow(RangeError);
    expect(() => p.date().precision('day', 1.5)).toThrow(
      new RangeError('p.date precision step must be a positive integer, got 1.5')
    );
  });

  it('date offsets past 2^53 refuse to encode instead of shifting a millisecond', () => {
    const extreme = p.date().min(new Date(-8.6e15));
    expect(() => extreme.encode(new Date(8.6e15 + 1))).toThrow(
      "Value '+274493-02-24T00:53:20.001Z' is too far from its bound -270554-11-06T23:06:40.000Z to encode exactly"
    );
    // The same spread is fine at a coarser precision, in any refinement order.
    const daily = p.date().precision('day').min(new Date(-8.64e15)).max(new Date(8.64e15));
    const d = new Date('2020-06-15T00:00:00Z');
    expect(daily.decode(daily.encode(d)).getTime()).toBe(d.getTime());
  });

  it('a decoded bucket past the Date range is corrupt input', () => {
    // A min-only date reads its bucket like a min-only int, so an int can
    // forge a bucket the encoder never could.
    const late = p.date().min(new Date(8.64e15)).precision('day');
    expect(() => late.decode(p.int().min(0).encode(1))).toThrow('representable time range');
  });

  it('rejects fractional timestamp bounds', () => {
    expect(() => p.date().min(1.5)).toThrow('bounds must be Dates or integer timestamps');
  });

  it('rejects a date whose bucket starts before the earliest Date', () => {
    // The first representable instant is mid-April of year -271821.
    expect(() => p.date().precision('month').encode(new Date(-8.64e15))).toThrow(
      'starts before the earliest Date'
    );
    expect(
      p
        .date()
        .precision('day')
        .decode(p.date().precision('day').encode(new Date(-8.64e15)))
    ).toEqual(new Date(-8.64e15));
  });
});
