/**
 * `p.float()`: IEEE 754 doubles, the significand spelled as the cheapest of
 * a flat mantissa, the simplest fraction in the double's rounding interval,
 * or that fraction times a power of five, so a value's cost tracks its
 * arithmetic complexity.
 */

import { p, Encoder, CorruptInputError } from '../../index';

/** Sign, then the exponent at the bias, then the given significand spelling. */
const spelled = (significand: (enc: Encoder) => void): Uint8Array => {
  const enc = new Encoder();
  enc.compose(0, 2);
  enc.composeTerm(0);
  significand(enc);
  return enc.output();
};

describe('Schema float', () => {
  it.each([
    [1.5, 2],
    [1 / 3, 2],
    [0.1, 2],
    [3.14, 4],
    [Math.PI, 8],
    // Float noise is genuine entropy: one addition forfeits the cheap name.
    [0.1 + 0.2, 8],
    // The five realm carries the decimal exponent's 5-adic half, so a typed
    // decimal never pays for the fives its binary exponent cannot absorb.
    [1e-300, 5],
    [6.02e23, 6],
    [8.17e-285, 8],
  ])('packs %p into %i bytes', (value, bytes) => {
    expect(p.float().encode(value)).toHaveLength(bytes);
  });

  it.each([Infinity, -Infinity, NaN])('rejects %p', (value) => {
    expect(() => p.float().encode(value)).toThrow(TypeError);
  });

  it('rejects an exponent past the finite range', () => {
    // The exponent zigzag tops out at the last finite exponent; the next term
    // value would be Infinity's slot, which the encoder never emits.
    const enc = new Encoder();
    enc.compose(0, 2);
    enc.composeTerm(2047);
    expect(() => p.float().decode(enc.output())).toThrow(CorruptInputError);
  });

  it.each([
    [
      'a reducible fraction: 6/4 names the same value as 3/2',
      (enc: Encoder) => {
        enc.compose(1, 3); // fraction selector
        enc.composeTerm(3); // denominator 4
        enc.compose(2, 4); // numerator 6
      },
      'not the canonical form',
    ],
    [
      'a flat mantissa for 1.5, whose canonical form is 3/2',
      (enc: Encoder) => {
        enc.compose(0, 3); // flat selector
        enc.compose(2 ** 51, 2 ** 52);
      },
      'not the canonical form',
    ],
    [
      'a denominator whose term outweighs the flat mantissa',
      (enc: Encoder) => {
        enc.compose(1, 3);
        enc.composeTerm(3 ** 20);
      },
      'dearer than the flat mantissa',
    ],
    [
      'a five-realm spelling of a plain fraction: 6/5 · 5 names 1.5',
      (enc: Encoder) => {
        enc.compose(2, 3); // five-realm selector
        enc.composeTerm(0); // shift +1
        enc.composeTerm(4); // denominator 5
        enc.compose(1, 5); // numerator 6
      },
      'not the canonical form',
    ],
    [
      'a shift past the range any shortest-decimal form produces',
      (enc: Encoder) => {
        enc.compose(2, 3);
        enc.composeTerm(2 * 501);
      },
      'outside the canonical range',
    ],
  ])('rejects %s', (_name, significand, message) => {
    expect(() => p.float().decode(spelled(significand))).toThrow(message);
  });
});
