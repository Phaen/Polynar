/**
 * `p.float()`: IEEE 754 doubles, the significand spelled as the cheapest of
 * a flat mantissa, the simplest fraction in the double's rounding interval,
 * or that fraction times a power of five, so a value's cost tracks its
 * arithmetic complexity.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import {
  simplestInInterval,
  termRunStates,
  zigNonzero,
  unzigNonzero,
  fiveShiftCandidate,
  windowFraction,
  canonicalSignificand,
  roundToSignificand,
  doubleFrom,
} from '../../nodes/float';
import { mulberry32 } from '../support';

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

  it('round-trips a value whose shifted window ends exactly on 2', () => {
    // Significand (5^23 - 1) / 2 under five-realm shift 23: the window's top,
    // 5^23 · 2^-53, scales by 5^-23 to a power of two and normalizes to
    // exactly 2, so the simplest-fraction search meets an integer endpoint.
    const value = 23841857910156250;
    const bytes = p.float().encode(value);
    expect(bytes).toHaveLength(9);
    expect(p.float().decode(bytes)).toBe(value);
  });

  it.each([0.1, -25, 1e-300, 6.02e23])('round-trips the five-realm value %p', (value) => {
    expect(p.float().decode(p.float().encode(value))).toBe(value);
  });

  it.each([0, -0, 5e-324, -3 * 2 ** -1074, 2 ** -1023])(
    'round-trips the zero or subnormal %p through the flat mantissa',
    (value) => {
      expect(Object.is(p.float().decode(p.float().encode(value)), value)).toBe(true);
    }
  );

  it.each([
    [Infinity, 0, 2047],
    [-Infinity, 1, 2047],
    [NaN, 0, 2048],
  ])(
    'round-trips %p as sign bit %p and the exponent zigzag %p past the finite ones',
    (value, sign, zigzag) => {
      const enc = new Encoder();
      enc.compose(sign, 2);
      enc.composeTerm(zigzag);
      expect(p.float().encode(value)).toEqual(enc.output());
      expect(p.float().decode(enc.output())).toBe(value);
    }
  );

  it.each([null, undefined, '1', 1n])('rejects the non-number %p', (value) => {
    expect(() => p.float().encode(value as never)).toThrow(/^p\.float expected a number, got /);
  });

  it('reads every NaN as the standard NaN, its payload and sign dropped', () => {
    const standard = new BigUint64Array(Float64Array.of(NaN).buffer)[0];
    for (const bits of [0x7ff8000000000001n, 0xfff8000000000000n, 0x7ff0000000000123n]) {
      const nan = new Float64Array(new BigUint64Array([bits]).buffer)[0];
      expect(p.float().encode(nan)).toEqual(p.float().encode(NaN));
      const back = p.float().decode(p.float().encode(nan));
      expect(new BigUint64Array(Float64Array.of(back).buffer)[0]).toBe(standard);
    }
  });

  it('rejects a NaN with the sign bit set, which the encoder never writes', () => {
    const enc = new Encoder();
    enc.compose(1, 2);
    enc.composeTerm(2048);
    expect(() => p.float().decode(enc.output())).toThrow(
      new CorruptInputError('Non-canonical negative NaN')
    );
  });

  it('rejects an exponent past NaN', () => {
    const enc = new Encoder();
    enc.compose(0, 2);
    enc.composeTerm(2049);
    expect(() => p.float().decode(enc.output())).toThrow(
      new CorruptInputError('Float exponent is outside the range of doubles')
    );
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

const ONE = 1n << 52n;
const END = 1n << 53n;

describe('simplestInInterval', () => {
  it.each([
    [
      [1n, 3n, 1n, 2n],
      [2n, 5n],
    ],
    [
      [1n, 2n, 5n, 2n],
      [1n, 1n],
    ],
    // Open on an integer: 3/2 sits on the edge, so 4/3 is the simplest.
    [
      [1n, 1n, 3n, 2n],
      [4n, 3n],
    ],
    [
      [-3n, 2n, -1n, 2n],
      [-1n, 1n],
    ],
    [
      [-1n, 3n, 1n, 3n],
      [0n, 1n],
    ],
    [
      [-1n, 2n, -1n, 3n],
      [-2n, 5n],
    ],
    [
      [0n, 1n, 1n, 1000n],
      [1n, 1001n],
    ],
  ])('finds the simplest rational in %p', (args, expected) => {
    const [a, b, c, d] = args;
    expect(simplestInInterval(a, b, c, d)).toEqual(expected);
  });

  it('agrees with a brute-force search over small intervals', () => {
    const rand = mulberry32(0x5b);
    const brute = (a: bigint, b: bigint, c: bigint, d: bigint): [bigint, bigint] => {
      for (let q = 1n; ; q++) {
        // The smallest p with p/q above a/b, kept if it stays below c/d.
        let p = (a * q) / b - 1n;
        while (p * b <= a * q) p++;
        if (p * d < c * q) return [p, q];
      }
    };
    for (let i = 0; i < 2000; i++) {
      const b = BigInt(1 + Math.floor(rand() * 40));
      const d = BigInt(1 + Math.floor(rand() * 40));
      const a = BigInt(Math.floor(rand() * 200) - 100);
      const c = (a * d) / b + 1n + BigInt(Math.floor(rand() * 20));
      expect(simplestInInterval(a, b, c, d)).toEqual(brute(a, b, c, d));
    }
  });

  it.each([
    [1n, 0n, 1n, 1n],
    [1n, 1n, 2n, 0n],
    [-1n, -2n, 1n, 1n],
    [1n, 1n, 2n, -1n],
  ])('rejects the denominators of (%p/%p, %p/%p)', (a, b, c, d) => {
    expect(() => simplestInInterval(a, b, c, d)).toThrow(
      new RangeError(`simplestInInterval needs positive denominators, got ${b} and ${d}`)
    );
  });

  it.each([
    [1n, 2n, 2n, 4n],
    [2n, 1n, 1n, 1n],
  ])('rejects the empty interval (%p/%p, %p/%p)', (a, b, c, d) => {
    expect(() => simplestInInterval(a, b, c, d)).toThrow(
      new RangeError(`simplestInInterval got the empty interval (${a}/${b}, ${c}/${d})`)
    );
  });
});

describe('termRunStates', () => {
  it.each([
    [0n, 5n],
    [1n, 20n],
    [2n, 20n],
    [3n, 80n],
    // The last inline value: 21 base-3 digits.
    [3n ** 21n - 1n, 5n * 4n ** 21n],
    // The first escaped value: escape, an empty count run, 12 base-8 digits.
    [3n ** 21n, 20n * 8n ** 11n * 7n],
    // 13 base-8 digits: the count run carries one digit.
    [8n ** 12n, 80n * 8n ** 12n * 7n],
  ])('counts the states of term %p as %p', (n, states) => {
    expect(termRunStates(n)).toBe(states);
  });

  it('matches what the encoder spends', () => {
    // A lone term fills one block, so its states set the output length.
    for (const n of [0n, 7n, 3n ** 21n - 1n, 3n ** 21n, 8n ** 12n, 2n ** 52n]) {
      const enc = new Encoder();
      enc.composeTerm(Number(n));
      expect(enc.output()).toHaveLength(Math.ceil(Math.log2(Number(termRunStates(n))) / 8));
    }
  });

  it('rejects a negative term', () => {
    expect(() => termRunStates(-1n)).toThrow(
      new RangeError('termRunStates got the negative term -1')
    );
  });
});

describe('zigNonzero', () => {
  it('maps +1, -1, +2, -2 onto 0, 1, 2, 3 and back', () => {
    expect([1, -1, 2, -2].map(zigNonzero)).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map(unzigNonzero)).toEqual([1, -1, 2, -2]);
  });

  it('round-trips at the edges of the safe range', () => {
    expect(zigNonzero(2 ** 52)).toBe(2 ** 53 - 2);
    expect(zigNonzero(-(2 ** 52))).toBe(2 ** 53 - 1);
    expect(unzigNonzero(2 ** 53 - 2)).toBe(2 ** 52);
    expect(unzigNonzero(2 ** 53 - 1)).toBe(-(2 ** 52));
  });

  it.each([0, 2 ** 52 + 1, -(2 ** 52) - 1])('rejects %p', (f) => {
    expect(() => zigNonzero(f)).toThrow(
      new RangeError(`zigNonzero expected a nonzero integer within ±2^52, got ${f}`)
    );
  });

  it.each([0.5, NaN, Infinity, -Infinity])('rejects the non-integer %p', (f) => {
    expect(() => zigNonzero(f)).toThrow(new TypeError(`zigNonzero expected an integer, got ${f}`));
  });

  it('rejects a negative code', () => {
    expect(() => unzigNonzero(-1)).toThrow(
      new RangeError('unzigNonzero expected a non-negative code, got -1')
    );
  });

  it.each([0.5, NaN, Infinity, 2 ** 53])('rejects the code %p', (z) => {
    expect(() => unzigNonzero(z)).toThrow(
      new TypeError(`unzigNonzero expected a safe integer, got ${z}`)
    );
  });
});

describe('fiveShiftCandidate', () => {
  it.each([
    [0, 0],
    [-0, 0],
    [1, 0],
    [1.5, 0],
    [0.1, -1],
    [25, 2],
    [-25, 2],
    [120, 1],
    [250, 3],
    [1e21, 21],
    [1e-300, -300],
    [5e-324, -323],
  ])('derives the shift of %p as %p', (value, shift) => {
    expect(fiveShiftCandidate(value)).toBe(shift);
  });

  it.each([NaN, Infinity, -Infinity])('rejects %p', (value) => {
    expect(() => fiveShiftCandidate(value)).toThrow(
      new TypeError(`fiveShiftCandidate expected a finite number, got ${value}`)
    );
  });
});

describe('windowFraction', () => {
  it.each([
    [ONE, 0, [1n, 1n]],
    [3n << 51n, 0, [3n, 2n]],
    // The top of the grid has no simple neighbour: a fine fraction just below 2.
    [END - 1n, 0, [6004799503160661n, 3002399751580331n]],
  ])('spells %p under shift %p', (significand, shift, expected) => {
    expect(windowFraction(significand, shift)).toEqual(expected);
  });

  it.each([500, -500, 1, -1])('keeps p in [q, 2q) under shift %p', (shift) => {
    for (const significand of [ONE, ONE + 12345n, END - 1n]) {
      const [p, q] = windowFraction(significand, shift);
      expect(p >= q && p < 2n * q).toBe(true);
    }
  });

  it.each([ONE - 1n, END, 0n, -1n])('rejects the significand %p', (significand) => {
    expect(() => windowFraction(significand, 0)).toThrow(
      new RangeError(`windowFraction expected a significand in [2^52, 2^53), got ${significand}`)
    );
  });

  it.each([0.5, NaN, Infinity])('rejects the shift %p', (shift) => {
    expect(() => windowFraction(ONE, shift)).toThrow(
      new TypeError(`windowFraction expected an integer shift, got ${shift}`)
    );
  });

  it.each([501, -501])('rejects the shift %p past the five-realm bound', (shift) => {
    expect(() => windowFraction(ONE, shift)).toThrow(
      new RangeError(`windowFraction shift ${shift} is outside ±500`)
    );
  });
});

describe('canonicalSignificand', () => {
  it.each([
    [1, { sel: 1, f: 0, p: 1n, q: 1n }],
    [1.5, { sel: 1, f: 0, p: 3n, q: 2n }],
    [-1.5, { sel: 1, f: 0, p: 3n, q: 2n }],
    [0.1, { sel: 2, f: -1, p: 1n, q: 1n }],
    [25, { sel: 2, f: 2, p: 1n, q: 1n }],
    [Math.PI, { sel: 0, f: 0, p: 0n, q: 0n }],
    [2 ** -1022, { sel: 1, f: 0, p: 1n, q: 1n }],
    [Number.MAX_VALUE, { sel: 0, f: 0, p: 0n, q: 0n }],
  ])('spells %p canonically', (value, form) => {
    expect(canonicalSignificand(value)).toEqual(form);
  });

  it.each([0, -0, 5e-324, 2 ** -1023])('rejects the non-normal %p', (value) => {
    expect(() => canonicalSignificand(value)).toThrow(
      new RangeError(`canonicalSignificand expected a normal double, got ${value}`)
    );
  });

  it.each([NaN, Infinity, -Infinity])('rejects %p', (value) => {
    expect(() => canonicalSignificand(value)).toThrow(
      new TypeError(`canonicalSignificand expected a finite number, got ${value}`)
    );
  });
});

describe('roundToSignificand', () => {
  it.each([
    [1n, 1n, ONE],
    [3n, 2n, 3n << 51n],
    [1n, 3n, 6004799503160661n],
    [2n ** 200n, 3n, 6004799503160661n],
    // 2^52 + 1/2 and 2^52 + 3/2 tie down; 2^52 + 7/4 rounds up.
    [2n ** 53n + 1n, 2n, ONE],
    [2n ** 53n + 3n, 2n, ONE + 1n],
    [2n ** 54n + 7n, 4n, ONE + 2n],
    // 2^53 - 1/4 rounds up to 2^53, which carries into the scale.
    [2n ** 55n - 1n, 4n, ONE],
  ])('rounds %p/%p onto the grid as %p', (num, den, expected) => {
    expect(roundToSignificand(num, den)).toBe(expected);
  });

  it.each([
    [0n, 1n],
    [-1n, 1n],
    [1n, 0n],
    [1n, -1n],
  ])('rejects %p/%p', (num, den) => {
    expect(() => roundToSignificand(num, den)).toThrow(
      new RangeError(`roundToSignificand expected a positive fraction, got ${num}/${den}`)
    );
  });
});

describe('doubleFrom', () => {
  it.each([
    [1023, 0n, 1],
    [1023, 1n << 51n, 1.5],
    [0, 0n, 0],
    [0, 1n, 5e-324],
    [2046, ONE - 1n, Number.MAX_VALUE],
  ])('assembles exponent %p and mantissa %p into %p', (exponent, mantissa, value) => {
    expect(doubleFrom(exponent, mantissa)).toBe(value);
  });

  it.each([-1, 2047])('rejects the exponent %p', (exponent) => {
    expect(() => doubleFrom(exponent, 0n)).toThrow(
      new RangeError(`doubleFrom exponent ${exponent} is outside [0, 2046]`)
    );
  });

  it.each([0.5, NaN, Infinity])('rejects the exponent %p', (exponent) => {
    expect(() => doubleFrom(exponent, 0n)).toThrow(
      new TypeError(`doubleFrom expected an integer exponent, got ${exponent}`)
    );
  });

  it.each([-1n, ONE])('rejects the mantissa %p', (mantissa) => {
    expect(() => doubleFrom(1023, mantissa)).toThrow(
      new RangeError(`doubleFrom mantissa ${mantissa} is outside [0, 2^52)`)
    );
  });
});
