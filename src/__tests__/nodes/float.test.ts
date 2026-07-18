/**
 * Schema float node (`p.float()`) — IEEE 754 doubles with fraction/mantissa packing.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import { trip } from '../support';

describe('Schema float', () => {
  it('float round-trips every finite double bit-exact', () => {
    for (const value of [Math.PI, 0.1 + 0.2, -2.5, 7, 1e300, Number.EPSILON]) {
      expect(trip(p.float(), value)).toBe(value);
    }
  });

  it('float round-trips the edges of the double space', () => {
    expect(trip(p.float(), Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    expect(trip(p.float(), Number.MIN_VALUE)).toBe(Number.MIN_VALUE); // subnormal
    expect(Object.is(trip(p.float(), -0), -0)).toBe(true); // sign bit survives
  });

  it('float packs simple values as fractions and full-entropy values flat', () => {
    // The significand travels as the cheapest of three spellings: flat
    // mantissa, simplest fraction in the double's rounding interval, or that
    // fraction times a power of five. A value's cost tracks its arithmetic
    // complexity, not the worst case.
    expect(p.float().encode(1.5)).toHaveLength(2);
    expect(p.float().encode(1 / 3)).toHaveLength(2);
    expect(p.float().encode(0.1)).toHaveLength(2);
    expect(p.float().encode(3.14)).toHaveLength(4);
    expect(p.float().encode(Math.PI)).toHaveLength(8);
    // Float noise is genuine entropy: one addition forfeits the cheap name.
    expect(p.float().encode(0.1 + 0.2)).toHaveLength(8);
  });

  it('float keeps decimal values cheap at any magnitude', () => {
    // The five realm carries the decimal exponent's 5-adic half, so a typed
    // decimal never pays for the fives its binary exponent cannot absorb.
    expect(p.float().encode(1e-300)).toHaveLength(5);
    expect(p.float().encode(6.02e23)).toHaveLength(6);
    expect(p.float().encode(8.17e-285)).toHaveLength(8);
  });

  it('float round-trips fraction-packed values bit-exact', () => {
    for (const value of [0.1, 1 / 3, -2 / 7, 1.5, 21.57, 0.5, 2, Number.EPSILON]) {
      expect(trip(p.float(), value)).toBe(value);
    }
  });

  it('rejects a float exponent past the finite range', () => {
    // The exponent zigzag tops out at the last finite exponent; the next term
    // value would be Infinity's slot, which the encoder never emits.
    const enc = new Encoder();
    enc.compose(0, 2);
    enc.composeTerm(2047);
    expect(() => p.float().decode(enc.toUint8Array())).toThrow(CorruptInputError);
  });

  it('rejects float significand spellings that are not the canonical one', () => {
    // 6/4 names the same value as 3/2, so only the simplest form decodes.
    const reducible = new Encoder();
    reducible.compose(0, 2); // sign
    reducible.composeTerm(0); // exponent at the bias
    reducible.compose(1, 3); // fraction selector
    reducible.composeTerm(3); // denominator 4
    reducible.compose(2, 4); // numerator 6
    expect(() => p.float().decode(reducible.toUint8Array())).toThrow('not the canonical form');

    // A flat mantissa spelling of 1.5, whose canonical form is 3/2.
    const flat = new Encoder();
    flat.compose(0, 2);
    flat.composeTerm(0);
    flat.compose(0, 3); // flat selector
    flat.compose(2 ** 51, 2 ** 52);
    expect(() => p.float().decode(flat.toUint8Array())).toThrow('not the canonical form');

    // A denominator whose term already outweighs the flat mantissa could
    // never have won the cost rule.
    const dear = new Encoder();
    dear.compose(0, 2);
    dear.composeTerm(0);
    dear.compose(1, 3);
    dear.composeTerm(3 ** 20);
    expect(() => p.float().decode(dear.toUint8Array())).toThrow('dearer than the flat mantissa');

    // A five-realm spelling of a value whose canonical home is the plain
    // fraction branch: 6/5 times 5^1 names 1.5, but 1.5's canonical form
    // is the fraction 3/2 with no shift.
    const shifted = new Encoder();
    shifted.compose(0, 2);
    shifted.composeTerm(0);
    shifted.compose(2, 3); // five-realm selector
    shifted.composeTerm(0); // shift +1
    shifted.composeTerm(4); // denominator 5
    shifted.compose(1, 5); // numerator 6
    expect(() => p.float().decode(shifted.toUint8Array())).toThrow('not the canonical form');

    // A shift past the range any shortest-decimal form can produce.
    const wild = new Encoder();
    wild.compose(0, 2);
    wild.composeTerm(0);
    wild.compose(2, 3);
    wild.composeTerm(2 * 501);
    expect(() => p.float().decode(wild.toUint8Array())).toThrow('outside the canonical range');
  });
});
