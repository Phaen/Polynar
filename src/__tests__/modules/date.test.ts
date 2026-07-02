/**
 * Date module — full feature & bounds coverage.
 *
 * Features: the default lossless 1ms interval, numeric and named intervals
 * (lossy quantisation to interval units), Date and numeric (ms) bounds, bound
 * enforcement against the raw timestamp, string-date parsing, and validator
 * rejections.
 */

import { Encoder, Decoder } from '../../polynar';
import type { DateOptions } from '../../types';

const roundTrip = (value: Date | string, options: DateOptions): Date => {
  const encoder = new Encoder();
  encoder.write(value, options);
  const decoder = new Decoder(encoder.toString());
  return decoder.read(options) as Date;
};

describe('Date module', () => {
  describe('default 1ms interval (lossless)', () => {
    it('round-trips a timestamp exactly, sub-second included', () => {
      const d = new Date('2026-06-24T12:30:45.123Z');
      expect(roundTrip(d, { type: 'date' }).getTime()).toBe(d.getTime());
    });

    it('round-trips the unix epoch', () => {
      const d = new Date(0);
      expect(roundTrip(d, { type: 'date' }).getTime()).toBe(0);
    });
  });

  describe('numeric intervals (lossy)', () => {
    it('quantises to the given interval but stays within tolerance', () => {
      const d = new Date('2024-01-15T12:30:45.678Z');
      const out = roundTrip(d, { type: 'date', interval: 1000 });
      expect(out).toBeInstanceOf(Date);
      expect(Math.abs(out.getTime() - d.getTime())).toBeLessThan(1000);
    });
  });

  describe('named intervals', () => {
    it.each([
      ['second', 1000],
      ['minute', 60_000],
      ['hour', 3_600_000],
      ['day', 86_400_000],
      ['week', 604_800_000],
    ])('round-trips within tolerance for %s', (interval, toleranceMs) => {
      const d = new Date('2024-03-10T08:15:30Z');
      const out = roundTrip(d, { type: 'date', interval });
      expect(Math.abs(out.getTime() - d.getTime())).toBeLessThan(toleranceMs);
    });

    it('accepts the coarse month and year intervals', () => {
      const d = new Date('2024-06-15T00:00:00Z');
      const month = roundTrip(d, { type: 'date', interval: 'month' });
      const year = roundTrip(d, { type: 'date', interval: 'year' });
      expect(month).toBeInstanceOf(Date);
      expect(year).toBeInstanceOf(Date);
    });
  });

  describe('bounds', () => {
    const lo = new Date('2020-01-01T00:00:00Z');
    const hi = new Date('2021-01-01T00:00:00Z');

    it('round-trips an in-range date with Date bounds', () => {
      const d = new Date('2020-06-15T00:00:00Z');
      const out = roundTrip(d, { type: 'date', min: lo, max: hi });
      expect(out.getTime()).toBe(d.getTime());
    });

    it('accepts numeric (ms) bounds', () => {
      const d = new Date('2020-06-15T00:00:00Z');
      const out = roundTrip(d, { type: 'date', min: lo.getTime(), max: hi.getTime() });
      expect(out.getTime()).toBe(d.getTime());
    });

    it('rejects a date before the minimum', () => {
      const opts: DateOptions = { type: 'date', min: lo, max: hi };
      expect(() => roundTrip(new Date('2019-12-31T23:00:00Z'), opts)).toThrow(/before the minimum/);
    });

    it('rejects a date after the maximum', () => {
      const opts: DateOptions = { type: 'date', min: lo, max: hi };
      expect(() => roundTrip(new Date('2021-01-02T00:00:00Z'), opts)).toThrow(/after the maximum/);
    });

    it('enforces the raw timestamp even when it floors into the boundary bucket', () => {
      const dayHi = new Date('2020-12-31T12:00:00Z');
      const opts: DateOptions = { type: 'date', min: lo, max: dayHi, interval: 'day' };
      // 23:00 is after the noon max but in the same day bucket — must still throw.
      expect(() => roundTrip(new Date('2020-12-31T23:00:00Z'), opts)).toThrow(/after the maximum/);
    });

    it('never decodes below a non-interval-aligned minimum', () => {
      // min is noon (not day-aligned); quantization is anchored at min, so the
      // decoded date stays within [min, max] rather than flooring below min.
      const noon = new Date('2020-06-15T12:00:00Z');
      const opts: DateOptions = { type: 'date', min: noon, max: hi, interval: 'day' };
      const out = roundTrip(new Date('2020-06-15T13:00:00Z'), opts);
      expect(out.getTime()).toBeGreaterThanOrEqual(noon.getTime());
    });
  });

  describe('string parsing', () => {
    it('parses valid string dates', () => {
      const out = roundTrip('2024-01-15T00:00:00Z', { type: 'date' });
      expect(out).toBeInstanceOf(Date);
      expect(out.getTime()).toBe(new Date('2024-01-15T00:00:00Z').getTime());
    });

    it('throws on an unparseable date', () => {
      const encoder = new Encoder();
      expect(() => encoder.write('not a date', { type: 'date' })).toThrow(TypeError);
    });
  });

  describe('validator rejections', () => {
    const enc = new Encoder();
    it('rejects an unknown named interval', () => {
      expect(() => enc.write(new Date(), { type: 'date', interval: 'fortnight' })).toThrow(
        TypeError
      );
    });

    it('rejects a fractional ms bound', () => {
      expect(() => enc.write(new Date(), { type: 'date', min: 1.5 })).toThrow(TypeError);
    });

    it('rejects a zero or negative interval (would divide by zero)', () => {
      expect(() => enc.write(new Date(), { type: 'date', interval: 0 })).toThrow(TypeError);
      expect(() => enc.write(new Date(), { type: 'date', interval: -1000 })).toThrow(TypeError);
    });

    it('rejects a minimum bound after the maximum', () => {
      // A silent swap would accept dates before the declared minimum.
      expect(() =>
        enc.write(new Date('2020-06-15T00:00:00Z'), {
          type: 'date',
          min: new Date('2021-01-01T00:00:00Z'),
          max: new Date('2020-01-01T00:00:00Z'),
        })
      ).toThrow('Range minimum exceeds maximum');
    });
  });
});
