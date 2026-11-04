/**
 * The integer arithmetic of the predictor: the generated tables against Math.*, and every helper
 * against BigInt on random operands inside its stated domain and on the edges of that domain.
 */

import {
  E_MIN,
  EXP2_TABLE,
  HB,
  LOG2_TABLE,
  ONE,
  PB,
  POW2,
  RB,
  SB,
  TABLES_DIGEST,
  bitlen,
  clampi,
  div,
  exp2Fix,
  log2Fix,
  mulDiv,
  mulShr,
  round,
  scaleDown,
  shl,
  shr,
} from '../../predictor/arith';
import { mulberry32 } from '../support';

const SAMPLES = 20000;

/** A uniform BigInt in [0, bound), from 96 random bits. */
const randBelow = (rand: () => number, bound: bigint): bigint => {
  let bits = 0n;
  for (let i = 0; i < 3; i++) {
    bits = (bits << 32n) | BigInt(Math.floor(rand() * 4294967296));
  }
  return bits % bound;
};

const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
};

/** A random integer below 2^bits where bits itself is random, so every magnitude occurs. */
const randMagnitude = (rand: () => number, maxBits: number): bigint =>
  randBelow(rand, 1n << BigInt(1 + Math.floor(rand() * maxBits)));

/**
 * The general formulas behind the 32-bit and small-product paths: floors of exact multiplications
 * by powers of two, without any shift operator.
 */
const reference = {
  log2Fix(x: number): number {
    const k = bitlen(x) - 1;
    const frac = k >= 12 ? Math.floor(x / POW2[k - 12]) - 4096 : x * POW2[12 - k] - 4096;
    return k * ONE + LOG2_TABLE[frac];
  },
  exp2Fix(e: number): number {
    if (e < E_MIN) {
      return 0;
    }
    const q = Math.floor(e / ONE);
    const m = EXP2_TABLE[Math.floor((e - q * ONE) / 4096)];
    if (q >= 24) {
      return m * POW2[q - 24];
    }
    const s = 24 - q;
    return s > 52 ? 0 : Math.floor(m / POW2[s]);
  },
  mulShr(a: number, b: number, k: number): number {
    const a1 = Math.floor(a / 2 ** 26);
    const a0 = a - a1 * 2 ** 26;
    const x = a1 * b;
    const y = a0 * b;
    if (k < 26) {
      return x * POW2[26 - k] + Math.floor(y / POW2[k]);
    }
    const s = POW2[k - 26];
    const q1 = Math.floor(x / s);
    return q1 + Math.floor(((x - q1 * s) * 2 ** 26 + y) / POW2[k]);
  },
};

describe('constants and tables', () => {
  it('fixes the numeric conventions', () => {
    expect([RB, SB, HB, PB]).toEqual([24, 36, 30, 16]);
    expect(ONE).toBe(2 ** 24);
    expect(E_MIN).toBe(-48 * 2 ** 24);
  });

  it('holds exact powers of two', () => {
    expect(POW2.length).toBe(53);
    for (let i = 0; i < POW2.length; i++) {
      expect(BigInt(POW2[i])).toBe(1n << BigInt(i));
    }
  });

  it('matches the tables regenerated with Math', () => {
    expect(LOG2_TABLE).toBeInstanceOf(Int32Array);
    expect(EXP2_TABLE).toBeInstanceOf(Int32Array);
    expect(LOG2_TABLE.length).toBe(4096);
    expect(EXP2_TABLE.length).toBe(4096);
    for (let i = 0; i < 4096; i++) {
      expect(LOG2_TABLE[i]).toBe(Math.floor(Math.log2(1 + i / 4096) * 2 ** 24));
      expect(EXP2_TABLE[i]).toBe(Math.floor(2 ** (i / 4096) * 2 ** 24));
    }
  });

  it('digests the tables with 32-bit FNV-1a over their little-endian bytes', () => {
    const bytes = Buffer.alloc(8192 * 4);
    [...LOG2_TABLE, ...EXP2_TABLE].forEach((v, i) => bytes.writeInt32LE(v, 4 * i));
    let h = 0x811c9dc5n;
    for (const byte of bytes) {
      h = ((h ^ BigInt(byte)) * 0x01000193n) & 0xffffffffn;
    }
    expect(TABLES_DIGEST).toMatch(/^[0-9a-f]{8}$/);
    expect(TABLES_DIGEST).toBe(h.toString(16).padStart(8, '0'));
  });
});

describe('div, shr, shl', () => {
  it('floors like BigInt on random operands, negative ones included', () => {
    const rand = mulberry32(1);
    for (let i = 0; i < SAMPLES; i++) {
      const a = randMagnitude(rand, 53) * (rand() < 0.5 ? -1n : 1n);
      const b = randMagnitude(rand, 52) + 1n;
      expect(BigInt(div(Number(a), Number(b)))).toBe(floorDiv(a, b));
    }
  });

  it('handles the edges', () => {
    const top = 2 ** 53 - 1;
    expect(div(top, 1)).toBe(top);
    expect(div(-top, 1)).toBe(-top);
    expect(div(top, top)).toBe(1);
    expect(div(-top, top)).toBe(-1);
    expect(div(-1, top)).toBe(-1);
    expect(div(0, 7)).toBe(0);
    expect(div(-7, 7)).toBe(-1);
    expect(div(-8, 7)).toBe(-2);
    expect(div(6, 7)).toBe(0);
  });

  it('shifts right with floor and left by multiplication', () => {
    const rand = mulberry32(2);
    for (let i = 0; i < SAMPLES; i++) {
      const a = randMagnitude(rand, 53) * (rand() < 0.5 ? -1n : 1n);
      const k = Math.floor(rand() * 53);
      expect(BigInt(shr(Number(a), k))).toBe(floorDiv(a, 1n << BigInt(k)));
    }
    expect(shr(-1, 52)).toBe(-1);
    expect(shr(2 ** 53 - 1, 52)).toBe(1);
    expect(shl(3, 0)).toBe(3);
    expect(shl(3, 50)).toBe(3 * 2 ** 50);
    expect(shl(-3, 10)).toBe(-3072);
  });
});

describe('mulShr and mulDiv', () => {
  const check = (a: number, b: number, k: number): void => {
    const exact = (BigInt(a) * BigInt(b)) >> BigInt(k);
    expect(exact < 1n << 53n).toBe(true);
    expect(BigInt(mulShr(a, b, k))).toBe(exact);
  };

  it('matches BigInt on random operands inside the domain', () => {
    const rand = mulberry32(3);
    for (let i = 0; i < SAMPLES; i++) {
      const b = Number(randMagnitude(rand, 26));
      const k = Math.floor(rand() * 53);
      let limit = 1n << 52n;
      if (k < 26 && b > 0) {
        // Keeps the result below 2^53, the domain for k < 26.
        const room = (1n << BigInt(53 + k)) / BigInt(b);
        limit = room < limit ? room : limit;
      }
      check(Number(randMagnitude(rand, 53) % limit), b, k);
    }
  });

  it('handles the edges of the domain', () => {
    const a = 2 ** 52 - 1;
    const b = 2 ** 26 - 1;
    for (const k of [26, 27, 40, 51, 52]) {
      check(a, b, k);
      check(0, b, k);
      check(a, 0, k);
      check(a, 1, k);
    }
    check(a, 1, 0);
    check(a, 2, 1);
    check(2 ** 27 - 1, b, 0);
    check(2 ** 26 - 1, b, 0);
    check(2 ** 26, b, 0);
    check(a, b, 26);
    check(2 ** 26, 2 ** 26 - 1, 26);
    check(0, 0, 0);
    expect(mulShr(a, b, 52)).toBe(2 ** 26 - 2);
  });

  it('matches the general formula below, around and above a product of 2^53', () => {
    const cmp = (a: number, b: number, k: number): void => {
      if (mulShr(a, b, k) !== reference.mulShr(a, b, k)) {
        expect([a, b, k, mulShr(a, b, k)]).toEqual([a, b, k, reference.mulShr(a, b, k)]);
      }
    };
    const rand = mulberry32(11);
    for (let i = 0; i < 300000; i++) {
      const b = Number(randMagnitude(rand, 26));
      const k = 26 + Math.floor(rand() * 27);
      // Small a, a product near 2^53, and any a in the domain.
      cmp(Number(randMagnitude(rand, 26)), b, k);
      if (b > 0) {
        const near = Math.floor(2 ** 53 / b) + Math.floor(rand() * 64) - 32;
        if (near >= 0 && near < 2 ** 52) {
          cmp(near, b, k);
        }
      }
      cmp(Number(randMagnitude(rand, 52)), b, k);
    }
    for (const k of [0, 16, 24, 26, 52]) {
      cmp(2 ** 27, 2 ** 26 - 1, Math.max(k, 1));
      cmp(2 ** 28, 2 ** 25, 26);
      cmp(2 ** 28 - 1, 2 ** 25, 26);
      cmp(2 ** 28 + 1, 2 ** 25, 26);
    }
    // 3 * 3002399751580331 is 2^53 + 1, which rounds to 2^53 in a double.
    check(3002399751580331, 3, 26);
    check(3002399751580330, 3, 26);
  });

  it('multiplies then divides', () => {
    const rand = mulberry32(4);
    for (let i = 0; i < SAMPLES; i++) {
      const a = Number(randMagnitude(rand, 27));
      const b = Number(randMagnitude(rand, 26));
      const c = Number(randMagnitude(rand, 52)) + 1;
      expect(BigInt(mulDiv(a, b, c))).toBe((BigInt(a) * BigInt(b)) / BigInt(c));
    }
    expect(mulDiv(2 ** 27 - 1, 2 ** 26 - 1, 1)).toBe((2 ** 27 - 1) * (2 ** 26 - 1));
    expect(mulDiv(0, 5, 3)).toBe(0);
  });
});

describe('bitlen', () => {
  it('counts the bits', () => {
    expect(bitlen(0)).toBe(0);
    expect(bitlen(1)).toBe(1);
    expect(bitlen(2)).toBe(2);
    expect(bitlen(3)).toBe(2);
    expect(bitlen(2 ** 32 - 1)).toBe(32);
    expect(bitlen(2 ** 32)).toBe(33);
    expect(bitlen(2 ** 52)).toBe(53);
    expect(bitlen(2 ** 53 - 1)).toBe(53);
  });

  it('agrees with BigInt on random values', () => {
    const rand = mulberry32(5);
    for (let i = 0; i < SAMPLES; i++) {
      const x = randMagnitude(rand, 53);
      expect(bitlen(Number(x))).toBe(x === 0n ? 0 : x.toString(2).length);
    }
  });
});

describe('log2Fix', () => {
  it('is 0 at 1 and exact at powers of two', () => {
    expect(log2Fix(1)).toBe(0);
    for (let k = 0; k <= 52; k++) {
      expect(log2Fix(POW2[k])).toBe(k * ONE);
    }
  });

  it('follows the table for small and large x', () => {
    // k < 12: the mantissa is scaled up; k >= 12: it is cut down.
    expect(log2Fix(3)).toBe(ONE + LOG2_TABLE[2048]);
    expect(log2Fix(4095)).toBe(11 * ONE + LOG2_TABLE[4094]);
    expect(log2Fix(4096)).toBe(12 * ONE);
    expect(log2Fix(4097)).toBe(12 * ONE + LOG2_TABLE[1]);
    expect(log2Fix(8191)).toBe(12 * ONE + LOG2_TABLE[4095]);
    expect(log2Fix(2 ** 53 - 1)).toBe(52 * ONE + LOG2_TABLE[4095]);
  });

  it('is monotone and within 2^-11 of log2', () => {
    const rand = mulberry32(6);
    const xs: number[] = [];
    for (let i = 0; i < 10000; i++) {
      xs.push(Number(randMagnitude(rand, 53)) + 1);
    }
    xs.sort((a, b) => a - b);
    let previous = -1;
    for (const x of xs) {
      const y = log2Fix(x);
      expect(y).toBeGreaterThanOrEqual(previous);
      expect(Math.abs(y / ONE - Math.log2(x))).toBeLessThan(2 ** -11);
      previous = y;
    }
  });

  it('is monotone over the first 20000 integers', () => {
    let previous = -1;
    for (let x = 1; x <= 20000; x++) {
      const y = log2Fix(x);
      expect(y).toBeGreaterThanOrEqual(previous);
      previous = y;
    }
  });

  it('matches the general formula on both sides of 2^32', () => {
    const rand = mulberry32(9);
    for (let i = 0; i < 1000000; i++) {
      const x = Number(randMagnitude(rand, 53)) + 1;
      if (log2Fix(x) !== reference.log2Fix(x)) {
        expect([x, log2Fix(x)]).toEqual([x, reference.log2Fix(x)]);
      }
    }
    for (let k = 0; k <= 52; k++) {
      for (const x of [POW2[k] - 1, POW2[k], POW2[k] + 1, 2 * POW2[k] - 1]) {
        if (x >= 1 && x < 2 ** 53) {
          expect(log2Fix(x)).toBe(reference.log2Fix(x));
        }
      }
    }
    expect(log2Fix(2 ** 31 - 1)).toBe(30 * ONE + LOG2_TABLE[4095]);
    expect(log2Fix(2 ** 31)).toBe(31 * ONE);
    expect(log2Fix(2 ** 32 - 1)).toBe(31 * ONE + LOG2_TABLE[4095]);
  });
});

describe('exp2Fix', () => {
  it('is exact at integer exponents', () => {
    for (let k = 0; k <= 52; k++) {
      expect(exp2Fix(k * ONE)).toBe(2 ** k);
    }
    expect(exp2Fix(-1)).toBe(0);
    expect(exp2Fix(-ONE)).toBe(0);
  });

  it('is 0 below E_MIN and when the result floors to 0', () => {
    expect(exp2Fix(E_MIN - 1)).toBe(0);
    expect(exp2Fix(E_MIN)).toBe(0);
    expect(exp2Fix(-30 * ONE)).toBe(0);
    expect(exp2Fix(-ONE * 0.5)).toBe(0);
  });

  it('keeps the top of the range', () => {
    expect(exp2Fix(53 * ONE - 1)).toBe(EXP2_TABLE[4095] * 2 ** 28);
    expect(() => exp2Fix(53 * ONE)).toThrow(RangeError);
    expect(() => exp2Fix(60 * ONE)).toThrow('exceeds 52');
    expect(() => exp2Fix(2 ** 40)).toThrow('exponent 65536 exceeds 52');
  });

  it('matches the general formula over the whole domain', () => {
    const check = (e: number): void => {
      if (exp2Fix(e) !== reference.exp2Fix(e)) {
        expect([e, exp2Fix(e)]).toEqual([e, reference.exp2Fix(e)]);
      }
    };
    const rand = mulberry32(10);
    const span = 53 * ONE - E_MIN;
    for (let i = 0; i < 1000000; i++) {
      check(E_MIN + Math.floor(rand() * span));
    }
    for (let i = 0; i < 100000; i++) {
      check(E_MIN - 1 - Math.floor(rand() * 2 ** 40));
    }
    for (let q = -49; q <= 52; q++) {
      for (const d of [0, 1, 4095, 4096, 4097, ONE / 2, ONE - 4096, ONE - 1]) {
        check(q * ONE + d);
      }
    }
    for (const edge of [E_MIN, 0, 53 * ONE]) {
      for (let e = edge - 2 ** 20; e < edge + 2 ** 20; e += 4096) {
        if (e < 53 * ONE) {
          check(e);
          check(e - 1);
        }
      }
    }
  });

  it('is monotone and within 2^-11 relative error (plus the floor)', () => {
    const rand = mulberry32(7);
    const es: number[] = [];
    for (let i = 0; i < 10000; i++) {
      es.push(Math.floor(-40 * ONE + rand() * 92 * ONE));
    }
    es.sort((a, b) => a - b);
    let previous = -1;
    for (const e of es) {
      const y = exp2Fix(e);
      const exact = 2 ** (e / ONE);
      expect(y).toBeGreaterThanOrEqual(previous);
      expect(y).toBeLessThanOrEqual(exact);
      expect(exact - y).toBeLessThan(exact * 2 ** -11 + 1);
      previous = y;
    }
  });

  it('is monotone over a dense sweep of the fractional bits', () => {
    let previous = -1;
    for (let e = 10 * ONE; e < 11 * ONE; e += 4099) {
      const y = exp2Fix(e);
      expect(y).toBeGreaterThanOrEqual(previous);
      previous = y;
    }
  });
});

describe('round, scaleDown, clampi', () => {
  it('rounds to nearest with ties upward, also below zero', () => {
    expect(round(0, 1)).toBe(0);
    expect(round(1, 1)).toBe(1);
    expect(round(3, 2)).toBe(1);
    expect(round(2, 2)).toBe(1);
    expect(round(1, 2)).toBe(0);
    expect(round(-1, 2)).toBe(0);
    expect(round(-2, 2)).toBe(0);
    expect(round(-3, 2)).toBe(-1);
    expect(round(2 ** 40 + 2 ** 23, 24)).toBe(2 ** 16 + 1);
    const rand = mulberry32(8);
    for (let i = 0; i < SAMPLES; i++) {
      const x = randMagnitude(rand, 51) * (rand() < 0.5 ? -1n : 1n);
      const k = 1 + Math.floor(rand() * 52);
      const half = 1n << BigInt(k - 1);
      expect(BigInt(round(Number(x), k))).toBe(floorDiv(x + half, half * 2n));
    }
  });

  it('shifts the first n values together and returns the shift', () => {
    const values = Float64Array.of(2 ** 40 + 5, 7, 2 ** 35, 2 ** 52 - 1);
    expect(scaleDown(values, 3, 30)).toBe(11);
    expect(Array.from(values)).toEqual([2 ** 29, 0, 2 ** 24, 2 ** 52 - 1]);
  });

  it('leaves values that already fit', () => {
    const values = Float64Array.of(2 ** 30 - 1, 5, 0);
    expect(scaleDown(values, 3, 30)).toBe(0);
    expect(Array.from(values)).toEqual([2 ** 30 - 1, 5, 0]);
    expect(scaleDown(values, 0, 4)).toBe(0);
    expect(scaleDown(new Float64Array(2), 2, 4)).toBe(0);
  });

  it('limits to a range', () => {
    expect(clampi(5, 0, 10)).toBe(5);
    expect(clampi(-5, 0, 10)).toBe(0);
    expect(clampi(15, 0, 10)).toBe(10);
    expect(clampi(0, 0, 10)).toBe(0);
    expect(clampi(10, 0, 10)).toBe(10);
  });
});
