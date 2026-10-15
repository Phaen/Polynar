import { Encoder, Decoder, CorruptInputError, bitLength } from '../packer';
import {
  TERM_BASE,
  TERM_ESCAPE_MIN,
  TERM_PAYLOAD_BASE,
  TERM_PAYLOAD_MIN_DIGITS,
} from '../packer/constants';
import { PNode } from './base';
import { describe } from './path';
import type { Kind } from './guards';
import { buildWeights, writeTable, readTable, type WeightTable } from './weights';
import { AdaptivePrior, checkAdaptation, lineageOf, type AdaptiveOptions } from './adaptive';
import { decimalPlaces } from './decimal';
import { Delta, IndexRange } from './lattice';
import { magnitude } from './magnitude';
import { ModeChoice, type Method } from './methods';

// Scratch views for splitting a double into its IEEE-754 fields and back.
// Both views share one buffer, so platform endianness cancels out; the wire
// carries the fields as plain integers, never raw bytes.
const FLOAT_SCRATCH = new Float64Array(1);
const FLOAT_BITS = new BigUint64Array(FLOAT_SCRATCH.buffer);
const MANTISSA_BITS = 52n;
const MANTISSA_RADIX = 2 ** 52;
// Finite doubles use exponents 0..2046. The exponent rides the term encoding
// as the zigzag of its distance from the bias (0, -1, +1, -2 -> 0, 1, 2, 3):
// real-world magnitudes cluster near 1, so the common exponents spend ~2-8
// bits where a flat radix would spend 11. Zigzag over sign-plus-magnitude
// because it is a bijection, leaving no signed-zero wire state to reject.
// Finite exponents fill the zigzags 0..2046, and the next two stand for
// Infinity, signed by the sign bit before it, and NaN, with nothing after
// either. Every NaN is the one NaN with sign bit 0: its payload is not kept.
const EXPONENT_BIAS = 1023;
const EXPONENT_FINITE_MAX = 2046;
const EXPONENT_ZIGZAG_MAX = 2046;
const ZIGZAG_INFINITY = EXPONENT_ZIGZAG_MAX + 1;
const ZIGZAG_NAN = EXPONENT_ZIGZAG_MAX + 2;
/** Full significand of 1.0: the implicit leading bit of every normal double. */
const SIGNIFICAND_ONE = 1n << MANTISSA_BITS;
/** One past the top of the significand grid [2^52, 2^53). */
const SIGNIFICAND_END = SIGNIFICAND_ONE << 1n;
const MANTISSA_MASK = SIGNIFICAND_ONE - 1n;
/** Smallest positive normal double. */
const MIN_NORMAL = 2 ** -1022;

/**
 * Simplest rational (smallest denominator, then smallest numerator) in the
 * open interval (a/b, c/d), as a reduced [numerator, denominator].
 * Stern-Brocot descent driven by the continued fractions of the endpoints,
 * so it runs in O(log max(b, d)) BigInt steps. Endpoints may be negative;
 * the denominators must be positive and the interval non-empty.
 */
export function simplestInInterval(a: bigint, b: bigint, c: bigint, d: bigint): [bigint, bigint] {
  if (b <= 0n || d <= 0n) {
    throw new RangeError(`simplestInInterval needs positive denominators, got ${b} and ${d}`);
  }
  if (a * d >= c * b) {
    throw new RangeError(`simplestInInterval got the empty interval (${a}/${b}, ${c}/${d})`);
  }
  // The answer is the continued-fraction matrix [h1 h0; k1 k0] applied to
  // the simplest value of the remaining interval: each step peels off the
  // whole part and inverts the fractional rest.
  let h1 = 1n;
  let h0 = 0n;
  let k1 = 0n;
  let k0 = 1n;
  for (;;) {
    // Floor division: only the first interval can reach below zero, every
    // later one lies above 1.
    let whole = a / b;
    let rest = a - whole * b;
    if (rest < 0n) {
      whole -= 1n;
      rest += b;
    }
    let num: bigint;
    let den: bigint;
    if ((whole + 1n) * d < c) {
      num = whole + 1n;
      den = 1n;
    } else if (rest === 0n) {
      // The interval opens exactly on the integer `whole`, so the simplest
      // interior value is whole + 1/t for the smallest t that fits below c/d.
      den = d / (c - whole * d) + 1n;
      num = whole * den + 1n;
    } else {
      [h1, h0] = [h1 * whole + h0, h1];
      [k1, k0] = [k1 * whole + k0, k1];
      [a, b, c, d] = [d, c - whole * d, b, rest];
      continue;
    }
    return [h1 * num + h0 * den, k1 * num + k0 * den];
  }
}

const TERM_ESCAPE_FROM = BigInt(TERM_ESCAPE_MIN);
const TERM_SLOT = BigInt(TERM_BASE + 1);
const TERM_DIGIT = BigInt(TERM_BASE);
const PAYLOAD_DIGIT = BigInt(TERM_PAYLOAD_BASE);

/** Wire states the term encoding of a non-negative n consumes. */
export function termRunStates(n: bigint): bigint {
  if (n < 0n) {
    throw new RangeError(`termRunStates got the negative term ${n}`);
  }
  if (n < TERM_ESCAPE_FROM) {
    // A widened first slot, then one slot per base-3 digit, the last of them
    // the terminator.
    let states = TERM_SLOT + 1n;
    for (let v = n; v > 0n; v /= TERM_DIGIT) {
      states *= TERM_SLOT;
    }
    return states;
  }
  // The escape symbol, the offset digit count as a terminated run, then the
  // base-8 digits, whose top one is never zero.
  let digits = 0;
  for (let v = n; v > 0n; v /= PAYLOAD_DIGIT) {
    digits++;
  }
  let states = (TERM_SLOT + 1n) * TERM_SLOT;
  for (
    let count = digits - TERM_PAYLOAD_MIN_DIGITS;
    count > 0;
    count = Math.floor(count / TERM_BASE)
  ) {
    states *= TERM_SLOT;
  }
  return states * PAYLOAD_DIGIT ** BigInt(digits - 1) * (PAYLOAD_DIGIT - 1n);
}

// Selector states of a normal significand's spelling: a flat mantissa, the
// simplest fraction in the rounding window, the dyadic p/2^j in the window,
// or that dyadic in the five realm (times a power of five). Zero is a fifth
// state that exists only at exponent code 0, so it rides the cheapest
// exponent spelling and no other binade pays for it. The selector is a
// weighted symbol: the weights are the node's prior over the kinds of
// number it carries.
const SIG_FLAT = 0;
const SIG_FRACTION = 1;
const SIG_DYADIC = 2;
const SIG_DYADIC5 = 3;
const SIG_ZERO = 4;
const SIG_FORMS = 4;

/** Prior over the kinds of number a `p.float` carries; see `PFloat.weights`. */
export interface FloatWeights {
  /** Exactly zero, either sign. */
  zero: number;
  /** Integers, and any value with a short binary expansion like 0.75. */
  integer: number;
  /** Short decimals like 0.1, 998.3 or 6.02e23. */
  decimal: number;
  /** Simple ratios like 1/3 or 2/7. */
  fraction: number;
  /** Everything else: arithmetic results, noise, full-precision measurements. */
  other: number;
}

export const DEFAULT_FLOAT_WEIGHTS: Readonly<FloatWeights> = {
  zero: 1,
  integer: 3,
  decimal: 3,
  fraction: 1,
  other: 2,
};

const FLOAT_WEIGHT_KEYS = Object.keys(DEFAULT_FLOAT_WEIGHTS) as (keyof FloatWeights)[];

/** The form weights in selector order. */
const formWeights = (w: FloatWeights): number[] => [w.other, w.fraction, w.integer, w.decimal];
/**
 * Bound on the five-realm shift the decoder accepts. A normal double's
 * shortest decimal has at most 17 digits, the last at a place in
 * [10^-324, 10^308], and digits below 10^17 hold at most 24 factors of
 * five, so every shift the encoder derives lies in [-324, 332].
 */
const FIVE_SHIFT_MAX = 500;

/** Largest magnitude whose nonzero zigzag stays a safe integer. */
const ZIG_MAX = 2 ** 52;

/**
 * Zigzag over the NONZERO integers (+1, -1, +2, -2 -> 0, 1, 2, 3): a zero
 * shift is the plain-fraction selector state, so it has no code here.
 * Defined for nonzero integers up to 2^52 in magnitude.
 */
export function zigNonzero(f: number): number {
  if (!Number.isInteger(f)) {
    throw new TypeError(`zigNonzero expected an integer, got ${f}`);
  }
  if (f === 0 || Math.abs(f) > ZIG_MAX) {
    throw new RangeError(`zigNonzero expected a nonzero integer within ±2^52, got ${f}`);
  }
  return f > 0 ? 2 * (f - 1) : -2 * f - 1;
}

/** Inverse of zigNonzero, over every non-negative safe integer. */
export function unzigNonzero(z: number): number {
  if (!Number.isSafeInteger(z)) {
    throw new TypeError(`unzigNonzero expected a safe integer, got ${z}`);
  }
  if (z < 0) {
    throw new RangeError(`unzigNonzero expected a non-negative code, got ${z}`);
  }
  return z % 2 === 0 ? z / 2 + 1 : -(z + 1) / 2;
}

/**
 * The five-realm shift suggested by a value's shortest round-trip decimal
 * form (`toString`, pinned by the ECMAScript spec, so encoder and decoder
 * derive the same candidate): a X.YeZ decimal names the double as
 * digits x 10^k, whose fives are digits' own times 5^k. Zero has no fives
 * and yields 0, the plain-fraction state.
 */
export function fiveShiftCandidate(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`fiveShiftCandidate expected a finite number, got ${value}`);
  }
  // A finite magnitude prints as digits with an optional fraction and an
  // optional exponent ("0", "123", "0.001", "1.5e+21", "5e-324").
  const [decimal, exponent = '0'] = Math.abs(value).toString().split('e');
  const [whole, fraction = ''] = decimal.split('.');
  let digits = whole + fraction;
  let shift = Number(exponent) - fraction.length;
  while (digits.length > 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    shift++;
  }
  for (let n = BigInt(digits); n !== 0n && n % 5n === 0n; n /= 5n) {
    shift++;
  }
  return shift;
}

/**
 * Simplest dyadic (smallest power-of-two denominator, then smallest
 * numerator) in the open interval (a/b, c/d), as [numerator, exponent]:
 * the value is numerator / 2^exponent. The numerator is odd unless the
 * exponent is 0, since an even numerator would halve into a smaller
 * exponent. Endpoints may be negative; the denominators must be positive
 * and the interval non-empty.
 */
export function simplestDyadic(a: bigint, b: bigint, c: bigint, d: bigint): [bigint, number] {
  if (b <= 0n || d <= 0n) {
    throw new RangeError(`simplestDyadic needs positive denominators, got ${b} and ${d}`);
  }
  if (a * d >= c * b) {
    throw new RangeError(`simplestDyadic got the empty interval (${a}/${b}, ${c}/${d})`);
  }
  // The interval scaled by 2^j holds an integer once it is wide enough, so
  // the climb ends; the first integer above the scaled bottom is the one.
  for (let j = 0; ; j++) {
    const lo = a << BigInt(j);
    let n = lo / b + 1n;
    if (lo < 0n && lo % b !== 0n) {
      n -= 1n;
    }
    if (n * d < c << BigInt(j)) {
      return [n, j];
    }
  }
}

/** The canonical spelling of a normal significand. */
export interface SignificandForm {
  sel: number;
  /** Five-realm shift; 0 outside SIG_DYADIC5. */
  f: number;
  /** Fraction p/q with p in [q, 2q), q a power of two in the dyadic states; 0/0 for SIG_FLAT. */
  p: bigint;
  q: bigint;
}

/**
 * The open rounding window of a significand on the grid [2^52, 2^53),
 * scaled into the five realm by a shift within ±FIVE_SHIFT_MAX and
 * 2-normalized so the window's top lies in (1, 2], as the fractions
 * (loN/loD, hiN/hiD). The simplest value of the window is then 1 or lies in
 * (1, 2), so its numerator lands in [q, 2q).
 */
export function roundingWindow(
  significand: bigint,
  shift: number
): [bigint, bigint, bigint, bigint] {
  if (significand < SIGNIFICAND_ONE || significand >= SIGNIFICAND_END) {
    throw new RangeError(
      `roundingWindow expected a significand in [2^52, 2^53), got ${significand}`
    );
  }
  if (!Number.isInteger(shift)) {
    throw new TypeError(`roundingWindow expected an integer shift, got ${shift}`);
  }
  if (Math.abs(shift) > FIVE_SHIFT_MAX) {
    throw new RangeError(`roundingWindow shift ${shift} is outside ±${FIVE_SHIFT_MAX}`);
  }
  // At the binade floor the neighbour below is in the previous binade, so
  // the gap on that side is half an ulp.
  let [loN, loD]: [bigint, bigint] =
    significand === SIGNIFICAND_ONE
      ? [4n * significand - 1n, 1n << (MANTISSA_BITS + 2n)]
      : [2n * significand - 1n, 1n << (MANTISSA_BITS + 1n)];
  let [hiN, hiD]: [bigint, bigint] = [2n * significand + 1n, 1n << (MANTISSA_BITS + 1n)];

  if (shift !== 0) {
    // The name satisfies name * 5^shift in window, so the search window
    // scales by 5^-shift; the compensating power of two is derived, never
    // encoded, so it costs nothing on the wire.
    const scale = 5n ** BigInt(Math.abs(shift));
    if (shift > 0) {
      loD *= scale;
      hiD *= scale;
    } else {
      loN *= scale;
      hiN *= scale;
    }
    const two = BigInt(bitLength(hiN) - bitLength(hiD) - 1);
    if (two > 0n) {
      loD <<= two;
      hiD <<= two;
    } else if (two < 0n) {
      loN <<= -two;
      hiN <<= -two;
    }
    if (hiN > 2n * hiD) {
      loD <<= 1n;
      hiD <<= 1n;
    }
  }

  return [loN, loD, hiN, hiD];
}

/**
 * Wire states a denominator's spelling consumes: a term of j for 2^j in the
 * dyadic states, a term of q - 1 for a fraction.
 */
const denominatorStates = (sel: number, q: bigint): bigint =>
  sel === SIG_FRACTION ? termRunStates(q - 1n) : termRunStates(BigInt(bitLength(q) - 1));

/**
 * The canonical form of a normal double's significand: flat, fraction,
 * dyadic or dyadic in the five realm — whichever is cheapest, with ties
 * going to the earlier selector. A form's cost is its wire states per
 * unit of selector weight, `weights` listing one weight per form in
 * selector order; the selector's total is the same factor for every form,
 * so it cancels. A denominator past the mantissa grid, 2^52, never wins:
 * the numerator slot must stay a safe radix. The sign plays no part.
 * Interval endpoints always carry denominators far beyond any fraction
 * that can win, so open intervals are exact here and rounding ties never
 * reach the wire format.
 */
export function canonicalSignificand(value: number, weights: readonly number[]): SignificandForm {
  if (!Number.isFinite(value)) {
    throw new TypeError(`canonicalSignificand expected a finite number, got ${value}`);
  }
  if (Math.abs(value) < MIN_NORMAL) {
    throw new RangeError(`canonicalSignificand expected a normal double, got ${value}`);
  }
  if (weights.length !== SIG_FORMS) {
    throw new TypeError(
      `canonicalSignificand expected ${SIG_FORMS} form weights, got ${weights.length}`
    );
  }
  FLOAT_SCRATCH[0] = value;
  const significand = SIGNIFICAND_ONE | (FLOAT_BITS[0] & MANTISSA_MASK);

  let best: SignificandForm = { sel: SIG_FLAT, f: 0, p: 0n, q: 0n };
  let bestStates = SIGNIFICAND_ONE;
  let bestWeight = BigInt(weights[SIG_FLAT]);
  const offer = (sel: number, f: number, [p, q]: [bigint, bigint]): void => {
    const weight = BigInt(weights[sel]);
    const states =
      (f === 0 ? 1n : termRunStates(BigInt(zigNonzero(f)))) * denominatorStates(sel, q) * q;
    if (q <= SIGNIFICAND_ONE && states * bestWeight < bestStates * weight) {
      best = { sel, f, p, q };
      bestStates = states;
      bestWeight = weight;
    }
  };

  const window = roundingWindow(significand, 0);

  offer(SIG_FRACTION, 0, simplestInInterval(...window));
  // Under shift 0 the dyadic is the significand with its trailing zero bits
  // dropped: no other dyadic on or below the grid's resolution fits the
  // open window.
  const [p, j] = simplestDyadic(...window);
  offer(SIG_DYADIC, 0, [p, 1n << BigInt(j)]);
  // The shift lies within FIVE_SHIFT_MAX (see there), so the decoder
  // accepts every form chosen here. A ratio scaled by a power of ten gets
  // no shift of its own: the candidate comes from the shortest decimal,
  // whose exponent is off by the digit count, so such values stay plain
  // fractions or go flat.
  const shift = fiveShiftCandidate(value);
  if (shift !== 0) {
    const [p5, j5] = simplestDyadic(...roundingWindow(significand, shift));
    offer(SIG_DYADIC5, shift, [p5, 1n << BigInt(j5)]);
  }

  return best;
}

/**
 * Round a positive num/den, rescaled by a power of two, to the nearest point
 * of the significand grid [2^52, 2^53), a tie going down; the power of two
 * itself is dropped. A value that rounds up to 2^53 carries into that power
 * and lands on 2^52. The encoder never names a halfway point, which lies on
 * the edge of both neighbours' open rounding windows; read from the wire it
 * rounds down like any tie.
 */
export function roundToSignificand(num: bigint, den: bigint): bigint {
  if (num <= 0n || den <= 0n) {
    throw new RangeError(`roundToSignificand expected a positive fraction, got ${num}/${den}`);
  }
  // The bit-length estimate scales num/den into (2^51, 2^53), so a result
  // below the grid is redone one bit up; doubling a rounded result would
  // round twice.
  for (let shift = 52 + bitLength(den) - bitLength(num); ; shift++) {
    let n = num;
    let d = den;
    if (shift > 0) {
      n <<= BigInt(shift);
    } else if (shift < 0) {
      d <<= BigInt(-shift);
    }
    let m = n / d;
    if (2n * (n % d) > d) {
      m += 1n;
    }
    if (m >= SIGNIFICAND_ONE) {
      return m === SIGNIFICAND_END ? SIGNIFICAND_ONE : m;
    }
  }
}

/**
 * Assemble a positive finite double from IEEE fields: a biased exponent in
 * [0, 2046] and a mantissa in [0, 2^52). toString on it drives the
 * five-realm candidate, so it must carry the true exponent.
 */
export function doubleFrom(exponent: number, mantissa: bigint): number {
  if (!Number.isInteger(exponent)) {
    throw new TypeError(`doubleFrom expected an integer exponent, got ${exponent}`);
  }
  if (exponent < 0 || exponent > EXPONENT_FINITE_MAX) {
    throw new RangeError(`doubleFrom exponent ${exponent} is outside [0, ${EXPONENT_FINITE_MAX}]`);
  }
  if (mantissa < 0n || mantissa > MANTISSA_MASK) {
    throw new RangeError(`doubleFrom mantissa ${mantissa} is outside [0, 2^52)`);
  }
  FLOAT_BITS[0] = (BigInt(exponent) << MANTISSA_BITS) | mantissa;
  return FLOAT_SCRATCH[0];
}

/** The most decimal places a value is spelled at as a decimal under `.adaptive()`. */
const MAX_PLACES = 15;
/** The places symbol of a value spelled as a double instead of a decimal. */
const AS_DOUBLE = MAX_PLACES + 1;
/** 10^places for every places symbol of a decimal, each exact. */
const POWERS = Array.from({ length: MAX_PLACES + 1 }, (_, places) => 10 ** places);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * The digits of `value` at `places` decimal places: the safe integer that,
 * divided by 10^places, gives it back exactly, if there is one.
 */
export function digitsAt(value: number, places: number): number | undefined {
  const digits = Math.round(value * POWERS[places]) + 0;
  return Math.abs(digits) <= MAX_SAFE && digits / POWERS[places] === value ? digits : undefined;
}

/**
 * The fewest decimal places `value` has digits at, or `AS_DOUBLE` when it
 * has none within `MAX_PLACES` or is -0, whose digits would read back as 0.
 */
export function placesOf(value: number): number {
  const places = Object.is(value, -0) ? null : decimalPlaces(value);
  return places === null || digitsAt(value, places) === undefined ? AS_DOUBLE : places;
}

/** A side's previous decimal of one node in the message: both undefined before its first. */
interface Previous {
  value?: number;
  /** The places it was spelled at. */
  places?: number;
}

/**
 * The spelling `.adaptive()` gives a float: a learned symbol naming its
 * decimal places, or that it is spelled as a double, then its digits as an
 * integer, by a learned mode between the plain magnitude and the difference
 * from the previous decimal, rounded to the same places.
 */
class LearnedDecimal {
  private readonly places: AdaptivePrior;
  private readonly delta: Delta;
  private readonly mode: ModeChoice<number>;

  constructor(adaptive: AdaptiveOptions, who: string) {
    const { window } = checkAdaptation(adaptive, who);
    const symbols = AS_DOUBLE + 1;
    this.places = new AdaptivePrior(
      [new Array<number>(symbols).fill(1)],
      symbols,
      window,
      who,
      lineageOf(adaptive)
    );
    const range = new IndexRange(who, undefined, undefined, undefined, adaptive);
    this.delta = new Delta(magnitude(adaptive, true, who), range.low, range.high);
    // An unbounded adaptive range always learns.
    this.mode = new ModeChoice([range.learned as Method<number>, this.delta], adaptive, who);
  }

  /** This message's previous decimal on `side`. */
  private previous(side: Encoder | Decoder): Previous {
    return side.state<Previous>(this, () => ({}));
  }

  /**
   * Points the difference at the previous decimal's digits at `places`,
   * rounded and clamped to the safe integers, once there is one. A -0 from
   * the rounding counts as 0, so no difference reads back as -0.
   */
  private aim(side: Encoder | Decoder, places: number): void {
    const { value } = this.previous(side);
    if (value !== undefined) {
      const origin = Math.round(value * POWERS[places]) + 0;
      this.delta.follow(side, Math.max(-MAX_SAFE, Math.min(MAX_SAFE, origin)));
    }
  }

  /** Makes `value` the previous decimal on `side`. */
  private remember(side: Encoder | Decoder, value: number, places: number): void {
    const previous = this.previous(side);
    const before = previous.value;
    const beforePlaces = previous.places;
    previous.value = value;
    previous.places = places;
    if (side.journal?.active === true) {
      side.journal.call(() => {
        previous.value = before;
        previous.places = beforePlaces;
      });
    }
  }

  /**
   * Writes `value`: its places symbol, then its digits, or `double` when it
   * is spelled as a double. A value with decimal places takes whichever the
   * encoder prices cheapest of its fewest, the previous decimal's when it
   * has digits there too, and the double, in that order on a tie.
   */
  write(enc: Encoder, value: number, double: () => void): void {
    const places = placesOf(value);
    if (places === AS_DOUBLE) {
      this.spell(enc, value, AS_DOUBLE, double);
      return;
    }
    const last = this.previous(enc).places;
    const symbols =
      last !== undefined && last > places && digitsAt(value, last) !== undefined
        ? [places, last, AS_DOUBLE]
        : [places, AS_DOUBLE];
    enc.decide(symbols, symbols, (symbol) => this.spell(enc, value, symbol, double));
  }

  /** Writes `value` at places symbol `symbol`, at which it has digits unless it is `AS_DOUBLE`. */
  private spell(enc: Encoder, value: number, symbol: number, double: () => void): void {
    this.places.write(enc, symbol);
    if (symbol === AS_DOUBLE) {
      double();
      return;
    }
    this.aim(enc, symbol);
    this.mode.write(enc, digitsAt(value, symbol) as number);
    this.remember(enc, value, symbol);
  }

  /** Reads a value `write` wrote, through `double` for one spelled as a double. */
  read(dec: Decoder, double: () => number): number {
    const places = this.places.read(dec);
    if (places === AS_DOUBLE) {
      return double();
    }
    this.aim(dec, places);
    const value = this.mode.read(dec) / POWERS[places];
    this.remember(dec, value, places);
    return value;
  }
}

/**
 * IEEE-754 double, bit-exact apart from NaN payloads. The significand
 * travels as the cheapest of four spellings — flat mantissa, simplest
 * fraction or simplest dyadic in the double's rounding interval, or that
 * dyadic times a power of five (the decimal realm) — so human-entered
 * values pack in a few bytes at any magnitude, and zero in one. A weighted
 * selector names the spelling; its weights are the node's prior over the
 * kinds of number it carries. `p.float`.
 */
export class PFloat extends PNode<number> {
  readonly _kinds: readonly Kind[] = ['number'];

  private readonly _declared: Readonly<FloatWeights>;
  /** One weight per form in selector order. */
  private readonly _formWeights: readonly number[];
  private readonly _forms: WeightTable;
  /** The selector at exponent code 0, where the zero state lives. */
  private readonly _formsAtBias: WeightTable;
  private readonly _adaptive?: AdaptiveOptions;
  /** Set under `.adaptive()`: the decimal spelling, which falls back on the double's. */
  private readonly _learned?: LearnedDecimal;

  constructor(
    weights?: Partial<FloatWeights>,
    base: Readonly<FloatWeights> = DEFAULT_FLOAT_WEIGHTS,
    adaptive?: AdaptiveOptions
  ) {
    super();
    this._adaptive = adaptive;
    if (adaptive !== undefined) {
      this._learned = new LearnedDecimal(adaptive, 'p.float');
    }
    const resolved = { ...base };
    for (const key of FLOAT_WEIGHT_KEYS) {
      const weight = weights?.[key];
      if (weight !== undefined) {
        resolved[key] = weight;
      }
    }
    this._declared = resolved;
    this._formWeights = formWeights(resolved);
    this._forms = buildWeights(this._formWeights, SIG_FORMS, 'p.float');
    this._formsAtBias = buildWeights(
      [...this._formWeights, resolved.zero],
      SIG_FORMS + 1,
      'p.float'
    );
  }

  /**
   * Declare how likely each kind of number is: `zero`, `integer`, `decimal`,
   * `fraction` and `other` (noise and arithmetic results, which take the
   * full mantissa). Keys left out keep their current weight. A prior, not a
   * constraint, and part of the wire format.
   */
  weights(w: Partial<FloatWeights>): PFloat {
    return new PFloat(w, this._declared, this._adaptive);
  }

  /**
   * Let the node learn the message's numbers: each value names its decimal
   * places, learned, then its digits as an integer, plainly or as the
   * difference from the previous decimal at the same places, whichever the
   * encoder prices cheaper, each on a learned magnitude scale. A value with
   * no exact decimal form within 15 places, -0, NaN and the infinities name
   * the double instead and are spelled as without. `window` is how many
   * observations the counts hold before they halve (1024 when left out).
   * Part of the wire format.
   */
  adaptive(options?: AdaptiveOptions): PFloat {
    return new PFloat(undefined, this._declared, options ?? {});
  }

  _write(enc: Encoder, value: number): void {
    if (this._learned === undefined) {
      this._double(enc, value);
    } else {
      this._learned.write(enc, value, () => this._double(enc, value));
    }
  }

  _read(dec: Decoder): number {
    return this._learned === undefined
      ? this._readDouble(dec)
      : this._learned.read(dec, () => this._readDouble(dec));
  }

  /** Writes `value` as a double. */
  private _double(enc: Encoder, value: number): void {
    if (Number.isNaN(value)) {
      enc.compose(0, 2);
      enc.composeTerm(ZIGZAG_NAN);
      return;
    }
    if (value === Infinity || value === -Infinity) {
      enc.compose(value < 0 ? 1 : 0, 2);
      enc.composeTerm(ZIGZAG_INFINITY);
      return;
    }
    // Data typed `any` can still carry something other than a number.
    if (typeof value !== 'number') {
      throw new TypeError(`p.float expected a number, got ${describe(value)}`);
    }

    FLOAT_SCRATCH[0] = value;
    const bits = FLOAT_BITS[0];
    const exponent = Number((bits >> MANTISSA_BITS) & 0x7ffn);
    const mantissa = bits & MANTISSA_MASK;
    enc.compose(Number(bits >> 63n), 2);

    // Zero rides the cheapest exponent code and its own selector state there.
    if (exponent === 0 && mantissa === 0n) {
      enc.composeTerm(0);
      writeTable(enc, this._formsAtBias, SIG_ZERO);
      return;
    }

    enc.composeTerm(
      exponent >= EXPONENT_BIAS
        ? (exponent - EXPONENT_BIAS) * 2
        : (EXPONENT_BIAS - exponent) * 2 - 1
    );

    // Subnormals have no implicit bit and no [1, 2) significand, so the
    // fraction forms are undefined there: the mantissa goes flat with no
    // selector slot.
    if (exponent === 0) {
      enc.compose(Number(mantissa), MANTISSA_RADIX);
      return;
    }

    const form = canonicalSignificand(value, this._formWeights);
    writeTable(enc, exponent === EXPONENT_BIAS ? this._formsAtBias : this._forms, form.sel);
    if (form.sel === SIG_FLAT) {
      enc.compose(Number(mantissa), MANTISSA_RADIX);
      return;
    }
    if (form.f !== 0) {
      enc.composeTerm(zigNonzero(form.f));
    }
    if (form.sel === SIG_FRACTION) {
      enc.composeTerm(Number(form.q - 1n));
    } else {
      enc.composeTerm(bitLength(form.q) - 1);
    }
    // p sits in [q, 2q) by construction: the numerator rides in an exact
    // radix-q slot as its offset from q.
    enc.compose(Number(form.p - form.q), Number(form.q));
  }

  /** Reads a double `_double` wrote. */
  private _readDouble(dec: Decoder): number {
    const sign = BigInt(dec.parse(2));
    const zigzag = dec.parseTerm();
    if (zigzag === ZIGZAG_INFINITY) {
      return sign === 0n ? Infinity : -Infinity;
    }
    if (zigzag === ZIGZAG_NAN) {
      return NaN;
    }
    // A term is open-ended where a radix is not: anything past NaN's slot is
    // a wire state the encoder cannot emit.
    if (zigzag > EXPONENT_ZIGZAG_MAX) {
      throw new CorruptInputError('Float exponent is outside the range of doubles');
    }
    const exponent =
      zigzag % 2 === 0 ? EXPONENT_BIAS + zigzag / 2 : EXPONENT_BIAS - (zigzag + 1) / 2;

    let mantissa: bigint;
    if (exponent === 0) {
      mantissa = BigInt(dec.parse(MANTISSA_RADIX));
    } else {
      const sel = readTable(dec, exponent === EXPONENT_BIAS ? this._formsAtBias : this._forms);
      if (sel === SIG_ZERO) {
        FLOAT_BITS[0] = sign << 63n;
        return FLOAT_SCRATCH[0];
      }
      let f = 0;
      let p = 0n;
      let q = 0n;
      if (sel === SIG_DYADIC5) {
        f = unzigNonzero(dec.parseTerm());
        if (Math.abs(f) > FIVE_SHIFT_MAX) {
          throw new CorruptInputError('Five-realm shift is outside the range of doubles');
        }
      }

      if (sel === SIG_FLAT) {
        mantissa = BigInt(dec.parse(MANTISSA_RADIX));
      } else {
        // Checked before the numerator slot so an absurd denominator fails as
        // corruption rather than as an oversized radix.
        if (sel === SIG_FRACTION) {
          q = BigInt(dec.parseTerm()) + 1n;
          if (q > SIGNIFICAND_ONE) {
            throw new CorruptInputError('Fraction denominator is past the mantissa grid');
          }
        } else {
          const j = dec.parseTerm();
          if (j > Number(MANTISSA_BITS)) {
            throw new CorruptInputError('Dyadic denominator is past the mantissa grid');
          }
          q = 1n << BigInt(j);
        }
        p = q + BigInt(dec.parse(Number(q)));
        // Rebuild the named significand in exact arithmetic: the name is
        // p/q shifted by 5^f, rounded onto the significand grid.
        const scale = 5n ** BigInt(Math.abs(f));
        mantissa =
          roundToSignificand(f >= 0 ? p * scale : p, f >= 0 ? q : q * scale) - SIGNIFICAND_ONE;
      }
    }

    FLOAT_BITS[0] = (sign << 63n) | (BigInt(exponent) << MANTISSA_BITS) | mantissa;
    return FLOAT_SCRATCH[0];
  }
}
