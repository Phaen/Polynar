/**
 * Boolean module — full feature coverage.
 *
 * Booleans have no options; coverage is single/multiple values plus rejection
 * of non-booleans.
 */

import { Encoder, Decoder } from '../../polynar';
import type { BooleanOptions } from '../../types';

const OPTS: BooleanOptions = { type: 'boolean' };

const roundTrip = (value: boolean | boolean[]) => {
  const encoder = new Encoder();
  encoder.write(value, OPTS);
  const decoder = new Decoder(encoder.toString());
  return decoder.read(OPTS, Array.isArray(value) ? value.length : 1);
};

describe('Boolean module', () => {
  it('round-trips true and false', () => {
    expect(roundTrip(true)).toBe(true);
    expect(roundTrip(false)).toBe(false);
  });

  it('round-trips a sequence of booleans', () => {
    expect(roundTrip([true, false, true, true, false])).toEqual([true, false, true, true, false]);
  });

  it('throws on non-booleans', () => {
    const encoder = new Encoder();
    expect(() => encoder.write(1 as unknown as boolean, OPTS)).toThrow(TypeError);
  });
});
