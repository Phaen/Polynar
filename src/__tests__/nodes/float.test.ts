/**
 * `p.float()`: IEEE 754 doubles, the significand spelled as the cheapest of
 * a flat mantissa, the simplest fraction or the simplest dyadic in the
 * double's rounding interval, or that dyadic times a power of five, so a
 * value's cost tracks its arithmetic complexity. A weighted selector names
 * the spelling, and zero is a selector state of its own.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import {
  simplestInInterval,
  simplestDyadic,
  termRunStates,
  zigNonzero,
  unzigNonzero,
  fiveShiftCandidate,
  roundingWindow,
  canonicalSignificand,
  roundToSignificand,
  doubleFrom,
  DEFAULT_FLOAT_WEIGHTS,
} from '../../nodes/float';
import { buildWeights, writeTable } from '../../nodes/weights';
import { mulberry32 } from '../support';

const SIG_FLAT = 0;
const SIG_FRACTION = 1;
const SIG_DYADIC = 2;
const SIG_DYADIC5 = 3;

/** The default form weights in selector order. */
const FORM_WEIGHTS = [
  DEFAULT_FLOAT_WEIGHTS.other,
  DEFAULT_FLOAT_WEIGHTS.fraction,
  DEFAULT_FLOAT_WEIGHTS.integer,
  DEFAULT_FLOAT_WEIGHTS.decimal,
];
/** The selector at the bias exponent, where the zero state lives. */
const FORMS_AT_BIAS = buildWeights([...FORM_WEIGHTS, DEFAULT_FLOAT_WEIGHTS.zero], 5, 'p.float');

/** Sign, the exponent at the bias, the selector, then the given significand spelling. */
const spelled = (sel: number, significand: (enc: Encoder) => void): Uint8Array => {
  const enc = new Encoder();
  enc.compose(0, 2);
  enc.composeTerm(0);
  writeTable(enc, FORMS_AT_BIAS, sel);
  significand(enc);
  return enc.output();
};

describe('Schema float', () => {
  it.each([
    [0, 1],
    [-0, 1],
    [1, 1],
    [1.5, 2],
    [1 / 3, 3],
    [0.1, 2],
    [3.14, 4],
    [Math.PI, 8],
    // Float noise is genuine entropy: one addition forfeits the cheap name.
    [0.1 + 0.2, 8],
    // The five realm carries the decimal exponent's 5-adic half, so a typed
    // decimal never pays for the fives its binary exponent cannot absorb.
    [1e-300, 5],
    [6.02e23, 5],
    [8.17e-285, 7],
    // An integer's denominator is a power of two, spelled by its exponent
    // alone, so its cost grows with its bits, not with its denominator.
    [65535, 5],
    [123456789, 6],
    [2 ** 30, 2],
    [998.3, 5],
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

  it.each([0, -0])('round-trips %p as the zero state at the bias exponent', (value) => {
    const enc = new Encoder();
    enc.compose(Object.is(value, -0) ? 1 : 0, 2);
    enc.composeTerm(0);
    writeTable(enc, FORMS_AT_BIAS, 4);
    expect(p.float().encode(value)).toEqual(enc.output());
    expect(Object.is(p.float().decode(enc.output()), value)).toBe(true);
  });

  it.each([5e-324, -3 * 2 ** -1074, 2 ** -1023])(
    'round-trips the subnormal %p through the flat mantissa',
    (value) => {
      expect(Object.is(p.float().decode(p.float().encode(value)), value)).toBe(true);
    }
  );

  it('round-trips a mixed sample under any weights', () => {
    const rand = mulberry32(0x7a);
    const sample = [0, -0, 1, -2, 0.5, 0.1, 1 / 3, 65535, 998.3, Math.PI, 1e-300, 5e-324];
    for (let i = 0; i < 50; i++) {
      const node = p.float().weights({
        zero: 1 + Math.floor(rand() * 100),
        integer: 1 + Math.floor(rand() * 100),
        decimal: 1 + Math.floor(rand() * 100),
        fraction: 1 + Math.floor(rand() * 100),
        other: 1 + Math.floor(rand() * 100),
      });
      for (const value of sample) {
        expect(Object.is(node.decode(node.encode(value)), value)).toBe(true);
      }
    }
  });

  describe('weights', () => {
    it('makes the weighted kind cheaper', () => {
      const zeros = Array<number>(100).fill(0);
      const plain = p.array(p.float()).encode(zeros);
      const weighted = p.array(p.float().weights({ zero: 50 })).encode(zeros);
      expect(weighted.length).toBeLessThan(plain.length);
      expect(p.array(p.float().weights({ zero: 50 })).decode(weighted)).toEqual(zeros);
    });

    it('keeps the weights of the keys left out', () => {
      const values = [0, 1, 0.1, 1 / 3, Math.PI];
      const chained = p.array(p.float().weights({ zero: 9 }).weights({ integer: 2 }));
      const atOnce = p.array(p.float().weights({ zero: 9, integer: 2 }));
      expect(chained.encode(values)).toEqual(atOnce.encode(values));
      expect(chained.encode(values)).not.toEqual(
        p.array(p.float().weights({ integer: 2 })).encode(values)
      );
    });

    it('treats an undefined weight as left out', () => {
      expect(p.float().weights({ zero: undefined }).encode(0)).toEqual(p.float().encode(0));
    });

    it.each([0, -1, 1.5, NaN])('rejects the weight %p', (weight) => {
      expect(() => p.float().weights({ decimal: weight })).toThrow(
        new TypeError(`p.float weights must be positive integers, got ${weight}`)
      );
      expect(() => p.float().weights({ zero: weight })).toThrow(
        new TypeError(`p.float weights must be positive integers, got ${weight}`)
      );
    });
  });

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

  it('reads a NaN with the sign bit set, which the encoder never writes, as NaN', () => {
    const enc = new Encoder();
    enc.compose(1, 2);
    enc.composeTerm(2048);
    expect(p.float().decode(enc.output())).toBeNaN();
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
      'a reducible fraction: 6/4',
      SIG_FRACTION,
      (enc: Encoder) => {
        enc.composeTerm(3); // denominator 4
        enc.compose(2, 4); // numerator 6
      },
    ],
    [
      'a flat mantissa',
      SIG_FLAT,
      (enc: Encoder) => {
        enc.compose(2 ** 51, 2 ** 52);
      },
    ],
    [
      'a fraction 3/2',
      SIG_FRACTION,
      (enc: Encoder) => {
        enc.composeTerm(1); // denominator 2
        enc.compose(1, 2); // numerator 3
      },
    ],
    [
      'a five-realm spelling: 15/8 · 5^-1',
      SIG_DYADIC5,
      (enc: Encoder) => {
        enc.composeTerm(1); // shift -1
        enc.composeTerm(3); // denominator 8
        enc.compose(7, 8); // numerator 15
      },
    ],
  ])(
    'reads 1.5 spelled as %s, which the encoder writes as the dyadic 3/2',
    (_name, sel, significand) => {
      expect(p.float().decode(spelled(sel, significand))).toBe(1.5);
    }
  );

  it.each([
    [
      'a fraction denominator past the mantissa grid',
      SIG_FRACTION,
      (enc: Encoder) => {
        enc.composeTerm(2 ** 52); // denominator 2^52 + 1
      },
      'Fraction denominator is past the mantissa grid',
    ],
    [
      'a dyadic denominator past the mantissa grid',
      SIG_DYADIC,
      (enc: Encoder) => {
        enc.composeTerm(53);
      },
      'Dyadic denominator is past the mantissa grid',
    ],
    [
      'a shift past the range any double needs',
      SIG_DYADIC5,
      (enc: Encoder) => {
        enc.composeTerm(2 * 501);
      },
      'Five-realm shift is outside the range of doubles',
    ],
  ])('rejects %s', (_name, sel, significand, message) => {
    expect(() => p.float().decode(spelled(sel, significand))).toThrow(
      new CorruptInputError(message)
    );
  });
});

describe('simplestDyadic', () => {
  it.each([
    [
      [1n, 3n, 1n, 2n],
      [3n, 3],
    ],
    [
      [1n, 2n, 5n, 2n],
      [1n, 0],
    ],
    [
      [-3n, 2n, -1n, 2n],
      [-1n, 0],
    ],
    [
      [-1n, 3n, 1n, 3n],
      [0n, 0],
    ],
    [
      [-1n, 2n, -1n, 3n],
      [-3n, 3],
    ],
    [
      [0n, 1n, 1n, 1000n],
      [1n, 10],
    ],
  ])('finds the simplest dyadic in %p', (args, expected) => {
    const [a, b, c, d] = args;
    expect(simplestDyadic(a, b, c, d)).toEqual(expected);
  });

  it('agrees with a brute-force search over small intervals', () => {
    const rand = mulberry32(0x3d);
    const brute = (a: bigint, b: bigint, c: bigint, d: bigint): [bigint, number] => {
      for (let j = 0; ; j++) {
        const q = 1n << BigInt(j);
        let n = (a * q) / b - 1n;
        while (n * b <= a * q) n++;
        if (n * d < c * q) return [n, j];
      }
    };
    for (let i = 0; i < 2000; i++) {
      const b = BigInt(1 + Math.floor(rand() * 40));
      const d = BigInt(1 + Math.floor(rand() * 40));
      const a = BigInt(Math.floor(rand() * 200) - 100);
      const c = (a * d) / b + 1n + BigInt(Math.floor(rand() * 20));
      expect(simplestDyadic(a, b, c, d)).toEqual(brute(a, b, c, d));
    }
  });

  it.each([
    [1n, 0n, 1n, 1n],
    [1n, 1n, 2n, 0n],
  ])('rejects the denominators of (%p/%p, %p/%p)', (a, b, c, d) => {
    expect(() => simplestDyadic(a, b, c, d)).toThrow(
      new RangeError(`simplestDyadic needs positive denominators, got ${b} and ${d}`)
    );
  });

  it.each([
    [1n, 2n, 2n, 4n],
    [2n, 1n, 1n, 1n],
  ])('rejects the empty interval (%p/%p, %p/%p)', (a, b, c, d) => {
    expect(() => simplestDyadic(a, b, c, d)).toThrow(
      new RangeError(`simplestDyadic got the empty interval (${a}/${b}, ${c}/${d})`)
    );
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

describe('roundingWindow', () => {
  it('opens half an ulp around the significand, a quarter below the binade floor', () => {
    expect(roundingWindow(ONE, 0)).toEqual([
      (ONE << 2n) - 1n,
      ONE << 2n,
      (ONE << 1n) + 1n,
      ONE << 1n,
    ]);
    expect(roundingWindow(ONE + 1n, 0)).toEqual([
      ((ONE + 1n) << 1n) - 1n,
      ONE << 1n,
      ((ONE + 1n) << 1n) + 1n,
      ONE << 1n,
    ]);
  });

  it.each([500, -500, 1, -1])('normalizes the top into (1, 2] under shift %p', (shift) => {
    for (const significand of [ONE, ONE + 12345n, END - 1n]) {
      const [loN, loD, hiN, hiD] = roundingWindow(significand, shift);
      expect(loN * hiD < hiN * loD).toBe(true);
      expect(hiN > hiD && hiN <= 2n * hiD).toBe(true);
    }
  });

  it.each([ONE - 1n, END, 0n, -1n])('rejects the significand %p', (significand) => {
    expect(() => roundingWindow(significand, 0)).toThrow(
      new RangeError(`roundingWindow expected a significand in [2^52, 2^53), got ${significand}`)
    );
  });

  it.each([0.5, NaN, Infinity])('rejects the shift %p', (shift) => {
    expect(() => roundingWindow(ONE, shift)).toThrow(
      new TypeError(`roundingWindow expected an integer shift, got ${shift}`)
    );
  });

  it.each([501, -501])('rejects the shift %p past the five-realm bound', (shift) => {
    expect(() => roundingWindow(ONE, shift)).toThrow(
      new RangeError(`roundingWindow shift ${shift} is outside ±500`)
    );
  });
});

describe('the simplest fraction in a rounding window', () => {
  const windowFraction = (significand: bigint, shift: number): [bigint, bigint] =>
    simplestInInterval(...roundingWindow(significand, shift));

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
});

describe('the simplest dyadic in a rounding window', () => {
  const windowDyadic = (significand: bigint, shift: number): [bigint, number] =>
    simplestDyadic(...roundingWindow(significand, shift));

  it.each([
    [ONE, 0, [1n, 0]],
    [3n << 51n, 0, [3n, 1]],
    [ONE + 1n, 0, [ONE + 1n, 52]],
    // Under shift 0 the dyadic is the significand with its trailing zeros dropped.
    [END - 1n, 0, [END - 1n, 52]],
    // 0.1's significand, 1.6, is 2^3 · 5^-1 · 2^-2: in the five realm it is 1.
    [0x1999999999999an, -1, [1n, 0]],
  ])('spells %p under shift %p', (significand, shift, expected) => {
    expect(windowDyadic(significand, shift)).toEqual(expected);
  });

  it.each([500, -500, 1, -1])('keeps p odd in [2^j, 2^(j+1)) under shift %p', (shift) => {
    for (const significand of [ONE, ONE + 12345n, END - 1n]) {
      const [p, j] = windowDyadic(significand, shift);
      const q = 1n << BigInt(j);
      expect(p >= q && p < 2n * q).toBe(true);
      expect(j === 0 || p % 2n === 1n).toBe(true);
    }
  });
});

describe('canonicalSignificand', () => {
  it.each([
    [1, { sel: SIG_DYADIC, f: 0, p: 1n, q: 1n }],
    [1.5, { sel: SIG_DYADIC, f: 0, p: 3n, q: 2n }],
    [-1.5, { sel: SIG_DYADIC, f: 0, p: 3n, q: 2n }],
    [1 / 3, { sel: SIG_FRACTION, f: 0, p: 4n, q: 3n }],
    [0.1, { sel: SIG_DYADIC5, f: -1, p: 1n, q: 1n }],
    [25, { sel: SIG_DYADIC5, f: 2, p: 1n, q: 1n }],
    [2.5, { sel: SIG_DYADIC5, f: 1, p: 1n, q: 1n }],
    [3.14, { sel: SIG_DYADIC5, f: -2, p: 157n, q: 128n }],
    [65535, { sel: SIG_DYADIC, f: 0, p: 65535n, q: 32768n }],
    [Math.PI, { sel: SIG_FLAT, f: 0, p: 0n, q: 0n }],
    [2 ** -1022, { sel: SIG_DYADIC, f: 0, p: 1n, q: 1n }],
    [Number.MAX_VALUE, { sel: SIG_FLAT, f: 0, p: 0n, q: 0n }],
  ])('spells %p canonically', (value, form) => {
    expect(canonicalSignificand(value, FORM_WEIGHTS)).toEqual(form);
  });

  it('weighs the forms: a heavy fraction weight makes 3/2 a fraction', () => {
    expect(canonicalSignificand(1.5, [1, 100, 1, 1])).toEqual({
      sel: SIG_FRACTION,
      f: 0,
      p: 3n,
      q: 2n,
    });
  });

  it('ties go to the earlier selector', () => {
    expect(canonicalSignificand(1.5, [1, 1, 1, 1]).sel).toBe(SIG_FRACTION);
  });

  it.each([0, -0, 5e-324, 2 ** -1023])('rejects the non-normal %p', (value) => {
    expect(() => canonicalSignificand(value, FORM_WEIGHTS)).toThrow(
      new RangeError(`canonicalSignificand expected a normal double, got ${value}`)
    );
  });

  it.each([NaN, Infinity, -Infinity])('rejects %p', (value) => {
    expect(() => canonicalSignificand(value, FORM_WEIGHTS)).toThrow(
      new TypeError(`canonicalSignificand expected a finite number, got ${value}`)
    );
  });

  it('rejects a weight list of the wrong length', () => {
    expect(() => canonicalSignificand(1, [1, 2])).toThrow(
      new TypeError('canonicalSignificand expected 4 form weights, got 2')
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
