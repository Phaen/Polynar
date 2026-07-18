/**
 * Schema date node (`p.date()`) — timestamps with optional bucketing by interval.
 */

import { p } from '../../index';
import { trip } from '../support';

describe('Schema date', () => {
  it('date is lossless at the default ms interval', () => {
    const d = new Date('2026-06-24T12:30:45.123Z');
    expect(trip(p.date(), d).getTime()).toBe(d.getTime());
    const before1970 = new Date('1955-11-05T06:00:00.000Z');
    expect(trip(p.date(), before1970).getTime()).toBe(before1970.getTime());
  });

  it('date round-trips with bounds and a coarse interval', () => {
    const node = p.date().min(new Date('2020-01-01Z')).max(new Date('2021-01-01Z')).interval('day');
    const d = new Date('2020-06-15T00:00:00Z');
    expect(trip(node, d).getTime()).toBe(d.getTime());
  });

  it('date enforces its bounds and rejects non-dates', () => {
    const node = p.date().min(new Date('2020-01-01Z')).max(new Date('2021-01-01Z'));
    expect(() => node.encode(new Date('2019-12-31Z'))).toThrow('before the minimum bound');
    expect(() => node.encode(new Date('2021-01-02Z'))).toThrow('after the maximum bound');
    expect(() => node.encode(new Date(NaN))).toThrow(TypeError);
    expect(() => p.date().encode('2020-01-01' as never)).toThrow(TypeError);
  });

  it('date rejects an unknown interval name and swapped bounds at construction', () => {
    expect(() => p.date().interval('fortnight' as never)).toThrow('Invalid date interval');
    expect(() => p.date().min(new Date('2021-01-01Z')).max(new Date('2020-01-01Z'))).toThrow(
      RangeError
    );
  });

  it('rejects zero/negative divisors at construction instead of hanging', () => {
    expect(() => p.date().interval(0)).toThrow(TypeError);
    expect(() => p.date().interval(-1000)).toThrow(TypeError);
  });

  it('a date with a non-interval-aligned min never decodes below that min', () => {
    const min = new Date('2020-06-15T12:00:00Z'); // noon — not day-aligned
    const max = new Date('2021-01-01T00:00:00Z');
    const node = p.date().min(min).max(max).interval('day');
    const decoded = node.decode(node.encode(new Date('2020-06-15T13:00:00Z')));
    expect(decoded.getTime()).toBeGreaterThanOrEqual(min.getTime());
  });

  it('date quantization refuses drift instead of shifting a millisecond', () => {
    // An odd millisecond offset past 2^53 has no exact float representation;
    // the reconstruction check turns the drift into an error, per value.
    const extreme = p.date().min(new Date(-8.6e15));
    expect(() => extreme.encode(new Date(8.6e15 + 1))).toThrow('quantize exactly');
    // The same spread is fine at a coarser interval, in any refinement order.
    // The min is day-aligned, so a midnight date sits on the anchored grid.
    const daily = p.date().min(new Date(-8.64e15)).max(new Date(8.64e15)).interval('day');
    const d = new Date('2020-06-15T00:00:00Z');
    expect(daily.decode(daily.encode(d)).getTime()).toBe(d.getTime());
  });
});
