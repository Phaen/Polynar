/**
 * The magnitude scale: an integer relative to an origin as its side, the
 * bit-length class of its distance and the tail within the class, static
 * or learned, exact up to the edges of its interval and across the whole
 * safe range.
 */

import { Encoder, Decoder } from '../../packer';
import { AdaptivePrior } from '../../nodes/adaptive';
import { Exclusion } from '../../nodes/excluded';
import {
  DIRECT,
  GAMMA_MAGNITUDE,
  LearnedMagnitude,
  MAX_CLASS,
  SIDE_SYMBOLS,
  STATIC_MAGNITUDE,
  classOf,
  gammaWeights,
  magnitude,
  sideWeights,
  type Magnitude,
} from '../../nodes/magnitude';
import { mulberry32 } from '../support';

const MAX = Number.MAX_SAFE_INTEGER;
const TWO_53 = 2 ** 53;

/** One value under `[origin, lo, hi]`. */
type Case = readonly [value: number, origin: number, lo: number, hi: number];

/** Writes every case through `make()` into one message and reads them back through a second `make()`. */
const tripAll = (make: () => Magnitude, cases: readonly Case[]) => {
  const writer = make();
  const enc = new Encoder();
  for (const [value, origin, lo, hi] of cases) writer.write(enc, value, origin, lo, hi);
  const bytes = enc.output();
  const reader = make();
  const dec = new Decoder(bytes);
  const back = cases.map(([, origin, lo, hi]) => reader.read(dec, origin, lo, hi));
  dec.finalize();
  return { bytes, back };
};

/** The output of `composes`, each a digit and its radix. */
const digits = (...composes: [number, number][]): Uint8Array => {
  const enc = new Encoder();
  for (const [digit, radix] of composes) enc.compose(digit, radix);
  return enc.output();
};

/** Every case on small intervals around the origin: each interval, origin and value. */
const small: Case[] = [];
for (let lo = -9; lo <= 0; lo += 3) {
  for (let hi = 0; hi <= 70; hi += 7) {
    for (let origin = lo; origin <= hi; origin += 2) {
      for (let value = lo; value <= hi; value++) small.push([value, origin, lo, hi]);
    }
  }
}

/** Values across the safe range against origins across it, with every edge. */
const wide: Case[] = [];
{
  const rand = mulberry32(0x3a9);
  const edges = [-MAX, -MAX + 1, -TWO_53 / 2, -1, 0, 1, TWO_53 / 2, MAX - 1, MAX];
  const any = (): number => Math.round((rand() * 2 - 1) * MAX);
  for (const origin of [...edges, any(), any()]) {
    for (const value of [...edges, any(), any(), origin, origin + (origin < MAX ? 1 : -1)]) {
      wide.push([value, origin, -MAX, MAX]);
    }
  }
}

describe('classOf', () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 2],
    [63, 6],
    [64, 7],
    [2 ** 32 - 1, 32],
    [2 ** 32, 33],
    [MAX, 53],
    [TWO_53, 54],
    [2 ** 54, 54],
  ])('puts %d in class %d', (distance, cls) => {
    expect(classOf(distance)).toBe(cls);
  });

  it('ends at class 54, the distances past the safe integers', () => {
    expect(MAX_CLASS).toBe(54);
  });
});

describe.each([
  ['static', () => STATIC_MAGNITUDE],
  ['learned', () => new LearnedMagnitude(true, {}, 'test')],
])('%s magnitude', (_name, make) => {
  it('refuses arguments that are not safe integers, an origin outside, a value outside', () => {
    const scale = make();
    const enc = new Encoder();
    const dec = new Decoder(new Uint8Array(0));
    for (const bad of [1.5, NaN, Infinity, TWO_53]) {
      expect(() => scale.write(enc, bad, 0, -5, 5)).toThrow(TypeError);
      expect(() => scale.write(enc, 0, 0, bad, 5)).toThrow(TypeError);
      expect(() => scale.read(dec, bad, -5, 5)).toThrow(TypeError);
      expect(() => scale.learn(enc, 0, bad, -5, 5)).toThrow(TypeError);
    }
    expect(() => scale.write(enc, 0, 6, -5, 5)).toThrow(
      new RangeError('Magnitude origin 6 is outside [-5, 5]')
    );
    expect(() => scale.read(dec, -6, -5, 5)).toThrow(RangeError);
    expect(() => scale.write(enc, 6, 0, -5, 5)).toThrow(
      new RangeError('Magnitude value 6 is outside [-5, 5]')
    );
    expect(() => scale.learn(dec, -6, 0, -5, 5)).toThrow(RangeError);
  });

  it('round-trips every value of small intervals from every origin', () => {
    expect(tripAll(make, small).back).toEqual(small.map(([value]) => value));
  });

  it('round-trips values across the whole safe range, exactly', () => {
    expect(tripAll(make, wide).back).toEqual(wide.map(([value]) => value));
  });

  it('writes nothing for an interval of one value', () => {
    expect(tripAll(make, [[4, 4, 4, 4]]).bytes).toEqual(new Uint8Array(0));
  });

  it('reads a value at an origin of -0 as 0', () => {
    const [back] = tripAll(make, [[0, -0, -3, 3]]).back;
    expect(Object.is(back, 0)).toBe(true);
  });

  it('keeps encoder and decoder in step through learn', () => {
    const writer = make();
    const reader = make();
    const enc = new Encoder();
    for (let i = 0; i < 20; i++) writer.learn(enc, 3, 0, -100, 100);
    writer.write(enc, 3, 0, -100, 100);
    writer.write(enc, -77, 0, -100, 100);
    const dec = new Decoder(enc.output());
    for (let i = 0; i < 20; i++) reader.learn(dec, 3, 0, -100, 100);
    expect([reader.read(dec, 0, -100, 100), reader.read(dec, 0, -100, 100)]).toEqual([3, -77]);
    dec.finalize();
  });
});

describe('static magnitude', () => {
  it('names the origin and each class the interval reaches with one digit, then the tail', () => {
    // [-10, 100] from 0: the origin, 7 classes above, 4 below.
    const at = (value: number) => tripAll(() => STATIC_MAGNITUDE, [[value, 0, -10, 100]]).bytes;
    expect(at(0)).toEqual(digits([0, 12]));
    expect(at(1)).toEqual(digits([1, 12]));
    expect(at(5)).toEqual(digits([3, 12], [1, 4]));
    expect(at(-1)).toEqual(digits([8, 12]));
    expect(at(-9)).toEqual(digits([11, 12], [1, 3]));
    // Class 7 is cut at 100: 37 tails, not 64.
    expect(at(100)).toEqual(digits([7, 12], [36, 37]));
    // Below, class 4 is cut at 10: 3 tails, not 8.
    expect(at(-10)).toEqual(digits([11, 12], [2, 3]));
  });

  it('spends nothing on a side the interval does not reach', () => {
    const bytes = tripAll(() => STATIC_MAGNITUDE, [[6, 0, 0, 7]]).bytes;
    expect(bytes).toEqual(digits([3, 4], [2, 4]));
  });

  it('cuts class 54 at the edge of the safe range', () => {
    const case_: Case = [MAX, -MAX, -MAX, MAX];
    // The distance 2^54 - 2 is class 54, its tail 2^53 - 2 of 2^53 - 1.
    expect(tripAll(() => STATIC_MAGNITUDE, [case_]).bytes).toEqual(
      digits([54, 55], [TWO_53 - 2, MAX])
    );
    const down: Case = [-MAX, MAX - 1, -MAX, MAX];
    expect(tripAll(() => STATIC_MAGNITUDE, [down]).bytes).toEqual(
      digits([55, 56], [TWO_53 - 3, TWO_53 - 2])
    );
  });
});

describe.each([
  ['gamma', () => GAMMA_MAGNITUDE],
  ['learned at gamma prices', () => new LearnedMagnitude(false, {}, 'Gamma', 'gamma')],
])('%s magnitude, above its origin', (_name, make) => {
  const up = (cases: readonly Case[]): Case[] =>
    cases.filter(([value, origin, lo]) => lo === origin && value >= origin);

  it('round-trips every value of small intervals and across the safe range', () => {
    const cases = [...up(small), ...up(wide), [MAX, 0, 0, MAX], [MAX, -MAX, -MAX, MAX]] as Case[];
    expect(tripAll(make, cases).back).toEqual(cases.map(([value]) => value));
  });

  it('writes nothing for an interval of one value, and reads -0 as 0', () => {
    expect(tripAll(make, [[4, 4, 4, 4]]).bytes).toEqual(new Uint8Array(0));
    const [back] = tripAll(make, [[0, -0, -0, 3]]).back;
    expect(Object.is(back, 0)).toBe(true);
  });

  it('refuses an interval reaching below the origin, and arguments outside it', () => {
    const scale = make();
    const enc = new Encoder();
    const dec = new Decoder(new Uint8Array(0));
    const below = new RangeError('Gamma magnitude reaches below its origin 2 to 1');
    expect(() => scale.write(enc, 3, 2, 1, 5)).toThrow(below);
    expect(() => scale.read(dec, 2, 1, 5)).toThrow(below);
    expect(() => scale.learn(enc, 3, 2, 1, 5)).toThrow(below);
    expect(() => scale.write(enc, 6, 0, 0, 5)).toThrow(
      new RangeError('Magnitude value 6 is outside [0, 5]')
    );
    expect(() => scale.learn(enc, 1.5, 0, 0, 5)).toThrow(TypeError);
  });
});

describe('gamma magnitude', () => {
  it('names the class in unary, stopping short of the farthest, then the tail', () => {
    const at = (value: number) => tripAll(() => GAMMA_MAGNITUDE, [[value, 0, 0, 100]]).bytes;
    expect(at(0)).toEqual(digits([0, 2]));
    expect(at(1)).toEqual(digits([1, 2], [0, 2]));
    expect(at(5)).toEqual(digits([1, 2], [1, 2], [1, 2], [0, 2], [1, 4]));
    // Class 7 is the farthest [0, 100] reaches: no stop, and cut at 100.
    const top: [number, number][] = new Array(7).fill([1, 2]);
    expect(at(100)).toEqual(digits(...top, [36, 37]));
  });
});

describe('learned magnitude', () => {
  it('starts at the gamma prices when asked, each class half the one before', () => {
    const side = gammaWeights(0);
    expect(side).toHaveLength(SIDE_SYMBOLS);
    expect(side.slice(0, 8)).toEqual([2048, 1024, 256, 256, 64, 64, 64, 64]);
    expect(side.slice(DIRECT, DIRECT + 3)).toEqual([16, 8, 4]);
    expect(side.slice(-20)).toEqual(new Array<number>(20).fill(1));
    expect(gammaWeights(1).slice(0, 3)).toEqual([1024, 512, 128]);
    const signed: Case[] = [-70, -1, 0, 3, 70].map((n) => [n, 0, -100, 100]);
    expect(tripAll(() => new LearnedMagnitude(true, {}, 'test', 'gamma'), signed).back).toEqual(
      signed.map(([n]) => n)
    );
  });

  it('starts at the term code prices, ported exactly', () => {
    const side = sideWeights(0);
    expect(side).toHaveLength(SIDE_SYMBOLS);
    expect(SIDE_SYMBOLS).toBe(112);
    expect(side.slice(0, 10)).toEqual([819, 205, 205, 51, 51, 51, 51, 51, 51, 13]);
    expect(side.slice(DIRECT, DIRECT + 4)).toEqual([92, 95, 51, 58]);
    expect(side.slice(-20)).toEqual(new Array<number>(20).fill(1));
    expect(sideWeights(1).slice(0, 3)).toEqual([410, 102, 102]);
  });

  it('codes a symbol under the adaptive prior, the unreached ruled out, then the tail', () => {
    const scale = new LearnedMagnitude(true, { window: 256 }, 'test');
    const cases: Case[] = [
      [70, 0, -3, 100],
      [-2, 0, -3, 100],
      [5, 0, -3, 100],
    ];
    const { bytes } = tripAll(() => new LearnedMagnitude(true, { window: 256 }, 'test'), cases);
    const enc = new Encoder();
    for (const [value, origin, lo, hi] of cases) scale.write(enc, value, origin, lo, hi);
    expect(enc.output()).toEqual(bytes);

    const side = sideWeights(1);
    const prior = new AdaptivePrior([[...side, ...side.slice(1)]], 223, 256, 'test');
    const exclusion = new Exclusion(223);
    // Above: 0..63 and class 7 reach 100; below: 1..3.
    for (let s = DIRECT + 1; s < SIDE_SYMBOLS; s++) exclusion.add(s);
    for (let s = 4; s < SIDE_SYMBOLS; s++) exclusion.add(SIDE_SYMBOLS - 1 + s);
    const model = new Encoder();
    prior.write(model, DIRECT, 0, exclusion);
    model.compose(70 - 64, 37);
    prior.write(model, SIDE_SYMBOLS - 1 + 2, 0, exclusion);
    prior.write(model, 5, 0, exclusion);
    expect(bytes).toEqual(model.output());
  });

  it('refuses an interval below the origin when unsigned', () => {
    const scale = new LearnedMagnitude(false, {}, 'lengths');
    expect(() => scale.write(new Encoder(), 3, 2, 1, 5)).toThrow(
      new RangeError('lengths magnitude reaches below its origin 2 to 1')
    );
    const lengths: Case[] = [0, 1, 63, 64, 1000, MAX].map((n) => [n, 0, 0, MAX]);
    expect(tripAll(() => new LearnedMagnitude(false, {}, 'lengths'), lengths).back).toEqual(
      lengths.map(([n]) => n)
    );
  });

  it('refuses invalid adaptive options', () => {
    expect(() => new LearnedMagnitude(true, { window: 0 }, 'test')).toThrow(RangeError);
  });
});

describe('magnitude', () => {
  it('is static without adaptive options and learned with them', () => {
    expect(magnitude(undefined, true, 'test')).toBe(STATIC_MAGNITUDE);
    const learned = magnitude({ window: 99 }, false, 'test');
    expect(learned).toBeInstanceOf(LearnedMagnitude);
    expect((learned as LearnedMagnitude).signed).toBe(false);
  });
});
