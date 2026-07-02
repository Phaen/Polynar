/**
 * Number module — full feature & bounds coverage.
 *
 * Features: bounded ranges, single-bounded (min:false / max:false), fully
 * unbounded (signed), step quantisation, and validation (out-of-range,
 * step-misaligned, non-number, and validator rejections — all throw).
 */

import { Encoder, Decoder } from '../../polynar';
import type { NumberOptions } from '../../types';

const roundTrip = (value: number | number[], options: NumberOptions) => {
  const encoder = new Encoder();
  encoder.write(value, options);
  const decoder = new Decoder(encoder.toString());
  return decoder.read(options, Array.isArray(value) ? value.length : 1);
};

describe('Number module', () => {
  describe('bounded ranges [min, max]', () => {
    it('round-trips values across the range, including the bounds', () => {
      const opts: NumberOptions = { type: 'number', min: 0, max: 100 };
      expect(roundTrip(0, opts)).toBe(0);
      expect(roundTrip(42, opts)).toBe(42);
      expect(roundTrip(100, opts)).toBe(100);
    });

    it('round-trips negative ranges', () => {
      const opts: NumberOptions = { type: 'number', min: -50, max: -10 };
      expect(roundTrip(-50, opts)).toBe(-50);
      expect(roundTrip(-30, opts)).toBe(-30);
      expect(roundTrip(-10, opts)).toBe(-10);
    });

    it('round-trips ranges spanning zero', () => {
      const opts: NumberOptions = { type: 'number', min: -100, max: 100 };
      expect(roundTrip([-100, -1, 0, 1, 100], opts)).toEqual([-100, -1, 0, 1, 100]);
    });

    it('round-trips multiple values in one buffer', () => {
      const opts: NumberOptions = { type: 'number', min: 0, max: 1000 };
      expect(roundTrip([10, 20, 30], opts)).toEqual([10, 20, 30]);
    });

    it('treats a swapped min/max as the same range', () => {
      expect(roundTrip(42, { type: 'number', min: 100, max: 0 })).toBe(42);
    });

    it('defaults min and max to 0 (single representable value)', () => {
      expect(roundTrip(0, { type: 'number' } as NumberOptions)).toBe(0);
    });
  });

  describe('step quantisation', () => {
    it('round-trips fractional steps', () => {
      const opts: NumberOptions = { type: 'number', min: 0, max: 10, step: 0.5 };
      expect(roundTrip(2.5, opts)).toBe(2.5);
      expect(roundTrip([0, 0.5, 9.5, 10], opts)).toEqual([0, 0.5, 9.5, 10]);
    });

    it('round-trips step-aligned values despite floating-point division error', () => {
      // 0.3 / 0.1 === 2.9999999999999996; the bucket must snap to 3, not reject.
      const opts: NumberOptions = { type: 'number', min: 0, max: 10, step: 0.1 };
      expect(roundTrip(0.3, opts)).toBeCloseTo(0.3, 10);
      expect(roundTrip(0.7, opts)).toBeCloseTo(0.7, 10);
    });

    it('round-trips integer steps > 1', () => {
      const opts: NumberOptions = { type: 'number', min: 0, max: 100, step: 5 };
      expect(roundTrip([0, 25, 100], opts)).toEqual([0, 25, 100]);
    });

    it('works with steps on single-bounded ranges', () => {
      expect(roundTrip(20, { type: 'number', min: 0, max: false, step: 4 })).toBe(20);
    });
  });

  describe('single-bounded ranges', () => {
    it('lower-bounded (max:false) round-trips arbitrarily large values', () => {
      const opts: NumberOptions = { type: 'number', min: 5, max: false };
      expect(roundTrip([5, 7, 1000, 1_000_000], opts)).toEqual([5, 7, 1000, 1_000_000]);
    });

    it('upper-bounded (min:false) round-trips values up to and below the max', () => {
      const opts: NumberOptions = { type: 'number', min: false, max: 10 };
      expect(roundTrip([10, 9, 0, -25], opts)).toEqual([10, 9, 0, -25]);
    });
  });

  describe('fully unbounded (signed)', () => {
    it('round-trips positive, negative and zero', () => {
      const opts: NumberOptions = { type: 'number', min: false, max: false };
      expect(roundTrip([0, 100, -50, -1, 1], opts)).toEqual([0, 100, -50, -1, 1]);
    });

    it('round-trips large magnitudes', () => {
      const opts: NumberOptions = { type: 'number', min: false, max: false };
      expect(roundTrip([123456789, -987654321], opts)).toEqual([123456789, -987654321]);
    });
  });

  describe('validation', () => {
    it('throws on values outside a bounded range', () => {
      expect(() => roundTrip(150, { type: 'number', min: 0, max: 100 })).toThrow(RangeError);
      expect(() => roundTrip(-1, { type: 'number', min: 0, max: 100 })).toThrow(RangeError);
    });

    it('throws on values below a lower bound (max:false)', () => {
      expect(() => roundTrip(3, { type: 'number', min: 5, max: false })).toThrow(RangeError);
    });

    it('throws on values not aligned to the step', () => {
      expect(() => roundTrip(2.3, { type: 'number', min: 0, max: 10, step: 0.5 })).toThrow(
        RangeError
      );
    });

    it('throws on a step-misaligned value in a single-bounded range', () => {
      expect(() => roundTrip(21, { type: 'number', min: 0, max: false, step: 4 })).toThrow(
        RangeError
      );
    });

    it('rejects a genuinely off-step value at large magnitude rather than snapping', () => {
      // The step tolerance stays tight enough that an off-step value never rounds
      // into an adjacent bucket, even where one ULP is comparatively large.
      expect(() =>
        roundTrip(999_999_999.5, { type: 'number', min: 0, max: 2_000_000_000, step: 1 })
      ).toThrow(RangeError);
    });

    it('throws on non-number input', () => {
      expect(() =>
        roundTrip('nope' as unknown as number, { type: 'number', min: 0, max: 10 })
      ).toThrow(TypeError);
    });
  });

  describe('validator rejections', () => {
    const enc = new Encoder();
    it('rejects a negative step', () => {
      expect(() => enc.write(1, { type: 'number', min: 0, max: 10, step: -1 })).toThrow(TypeError);
    });

    it('rejects a zero step (would divide by zero)', () => {
      expect(() => enc.write(1, { type: 'number', min: 0, max: false, step: 0 })).toThrow(
        TypeError
      );
    });

    it('rejects a range not divisible by the step', () => {
      expect(() => enc.write(1, { type: 'number', min: 0, max: 10, step: 3 })).toThrow(TypeError);
    });

    it('rejects an invalid range bound', () => {
      expect(() => enc.write(1, { type: 'number', min: 'x' as never, max: 10 })).toThrow(TypeError);
    });
  });
});
