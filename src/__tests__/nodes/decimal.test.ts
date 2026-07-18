/**
 * Schema decimal node (`p.decimal()`) — fixed-step decimal values.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import { trip } from '../support';

describe('Schema decimal', () => {
  it('decimal round-trips grid values bit-exact, including the float traps', () => {
    const cents = p.decimal(0.01).min(0).max(100);
    // 0.07, 0.29 and 3.14 are classic drift cases under raw float division
    // (0.29/0.01 = 28.999...); the scaled-integer path must return them
    // identically, not as a close neighbour.
    for (const value of [0, 0.07, 0.29, 3.14, 99.99, 100]) {
      expect(trip(cents, value)).toBe(value);
    }
    expect(trip(p.decimal(0.1), 0.3)).toBe(0.3);
    expect(trip(p.decimal(0.1), -12.7)).toBe(-12.7);
  });

  it('decimal accepts coarse and integer steps', () => {
    expect(trip(p.decimal(0.5).min(-2).max(2), -1.5)).toBe(-1.5);
    expect(trip(p.decimal(5).min(0).max(100), 35)).toBe(35);
  });

  it('decimal spends only what the step and bounds allow', () => {
    // 0..100 in cents is 10001 states — 2 bytes. Declared constraints still
    // beat p.float's per-value fraction search, which cannot see the bounds.
    expect(p.decimal(0.01).min(0).max(100).encode(3.14)).toHaveLength(2);
    expect(p.float().encode(3.14)).toHaveLength(4);
  });

  it('decimal rejects off-grid values instead of snapping', () => {
    expect(() => p.decimal(0.01).encode(0.005)).toThrow('not a multiple of step');
    expect(() => p.decimal(0.01).encode(0.123)).toThrow('not a multiple of step');
    expect(() => p.decimal(0.1).encode(0.35)).toThrow('not a multiple of step');
  });

  it('decimal enforces bounds and rounds off-grid bounds inward', () => {
    expect(() => p.decimal(0.01).min(0).max(100).encode(100.01)).toThrow(RangeError);
    // Bounds of [0.3, 2.2] on a 0.5 step admit only 0.5..2.0; the bounds
    // themselves are off-grid and must not become encodable.
    const node = p.decimal(0.5).min(0.3).max(2.2);
    expect(trip(node, 0.5)).toBe(0.5);
    expect(trip(node, 2)).toBe(2);
    expect(() => node.encode(0.3)).toThrow('not a multiple of step');
    expect(() => node.encode(2.2)).toThrow('not a multiple of step');
  });

  it('decimal rejects invalid steps and empty ranges at construction', () => {
    expect(() => p.decimal(0)).toThrow(TypeError);
    expect(() => p.decimal(-0.1)).toThrow(TypeError);
    // 1/3 has no finite decimal form, so no value could ever sit on its grid.
    expect(() => p.decimal(1 / 3)).toThrow(TypeError);
    // No multiple of 0.5 lies in [0.6, 0.9].
    expect(() => p.decimal(0.5).min(0.6).max(0.9)).toThrow(RangeError);
  });

  it('rejects a step multiple that cannot reconstruct exactly', () => {
    // The multiple itself is a valid term, but scaled by the step it rounds
    // past 2^53, so dividing it back out would decode a neighbouring value
    // the encoder rejects.
    const enc = new Encoder();
    enc.compose(0, 2);
    enc.composeTerm(2 ** 60);
    expect(() => p.decimal(0.01).decode(enc.toUint8Array())).toThrow(CorruptInputError);
  });
});
