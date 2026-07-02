/**
 * Fraction module — full feature & bounds coverage.
 *
 * Fractions encode a number as a continued-fraction numerator/denominator pair
 * (sign + two terms). Coverage: positive/negative/zero, integers, the precision
 * option (accuracy vs size), and rejection of non-numbers.
 */

import { Encoder, Decoder } from '../../polynar';
import type { FractionOptions } from '../../types';

const roundTrip = (value: number | number[], options: FractionOptions = { type: 'fraction' }) => {
  const encoder = new Encoder();
  encoder.write(value, options);
  const decoder = new Decoder(encoder.toString());
  return decoder.read(options, Array.isArray(value) ? value.length : 1);
};

describe('Fraction module', () => {
  it('round-trips simple fractions', () => {
    const out = roundTrip([0.5, 1.5, 2.75]) as number[];
    expect(out[0]).toBeCloseTo(0.5, 10);
    expect(out[1]).toBeCloseTo(1.5, 10);
    expect(out[2]).toBeCloseTo(2.75, 10);
  });

  it('round-trips negative fractions', () => {
    const out = roundTrip([-0.5, -1.25]) as number[];
    expect(out[0]).toBeCloseTo(-0.5, 10);
    expect(out[1]).toBeCloseTo(-1.25, 10);
  });

  it('round-trips integers and zero exactly', () => {
    expect(roundTrip([0, 1, -1, 42, -1000])).toEqual([0, 1, -1, 42, -1000]);
  });

  it('approximates irrationals within the default precision', () => {
    expect(roundTrip(Math.PI)).toBeCloseTo(Math.PI, 10);
    expect(roundTrip(Math.E)).toBeCloseTo(Math.E, 10);
  });

  describe('precision option', () => {
    it('honours a coarser precision', () => {
      expect(roundTrip(Math.PI, { type: 'fraction', precision: 1e-10 })).toBeCloseTo(Math.PI, 9);
    });

    it('rejects a negative precision', () => {
      const enc = new Encoder();
      expect(() => enc.write(1, { type: 'fraction', precision: -1 })).toThrow(TypeError);
    });

    it('rejects a zero precision (would never converge)', () => {
      const enc = new Encoder();
      expect(() => enc.write(Math.PI, { type: 'fraction', precision: 0 })).toThrow(TypeError);
    });
  });

  it('throws on non-numbers', () => {
    const encoder = new Encoder();
    expect(() => encoder.write('nope' as unknown as number, { type: 'fraction' })).toThrow(
      TypeError
    );
  });

  it('throws on non-finite numbers (would hang)', () => {
    const encoder = new Encoder();
    expect(() => encoder.write(Infinity, { type: 'fraction' })).toThrow(TypeError);
    expect(() => encoder.write(NaN, { type: 'fraction' })).toThrow(TypeError);
  });
});
