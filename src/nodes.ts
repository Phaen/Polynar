/**
 * Schema nodes. A node IS the codec for its type: `_write` validates one value
 * and pushes its digits through the packer primitives (`compose`,
 * `composeTerm`), `_read` pulls them back in the same order. There is no
 * intermediate description format — the node tree is the schema, the wire
 * format, and the validator in one place.
 *
 * Nodes are immutable: every refinement returns a fresh node, and all
 * configuration is validated eagerly in the constructor, so an invalid schema
 * fails where it is defined rather than on first use.
 *
 * Custom types are nodes too: subclass `PNode`, implement `_write`/`_read`
 * against the same primitives, and the node composes with `p.object`,
 * `p.array` and `.optional()` like any built-in.
 */
import { Encoder } from './encoder';
import { Decoder } from './decoder';
import { DATE_INTERVALS, TERM_BASE, UTF16_RANGE } from './constants';
import type { DateInterval } from './constants';
import { CorruptInputError } from './errors';
import { isArray, isDate, isObject, validateCharset } from './utils';
import type { Charset } from './types';
import type { InferShape } from './infer';

/** Base class for every schema node. `_t` is a phantom carrying the output type. */
export abstract class PNode<TOut> {
  declare readonly _t: TOut;

  /** Validate one value and write its digits. The whole codec for this type. */
  abstract _write(enc: Encoder, value: TOut): void;

  /** Read one value back, in the exact order `_write` produced it. */
  abstract _read(dec: Decoder): TOut;

  encode(value: TOut): Uint8Array {
    const enc = new Encoder();
    this._write(enc, value);
    return enc.toUint8Array();
  }

  decode(bytes: Uint8Array): TOut {
    const dec = new Decoder(bytes);
    const value = this._read(dec);
    // The schema is the whole message, so the input must be exactly consumed.
    // This rejects tampered digits and trailing padding instead of silently
    // decoding them into plausible-looking values.
    dec.finalize();
    return value;
  }

  /** Encode to text instead of bytes. Both sides must agree on the charset. */
  encodeString(value: TOut, charset?: Charset): string {
    const enc = new Encoder();
    this._write(enc, value);
    return enc.toString(charset);
  }

  /** Decode text produced by `encodeString` with the same charset. */
  decodeString(str: string, charset?: Charset): TOut {
    const dec = new Decoder(str, charset);
    const value = this._read(dec);
    // Same exhaustion check as `decode`: the text is the whole message.
    dec.finalize();
    return value;
  }

  /** Mark this node optional. Only meaningful as a `p.object` field. */
  optional(): POptional<TOut> {
    return new POptional<TOut>(this);
  }
}

/** Wraps a node, adding the object-field presence bit. */
export class POptional<TOut> extends PNode<TOut> {
  declare readonly _optional: true;

  constructor(readonly inner: PNode<TOut>) {
    super();
  }

  _write(enc: Encoder, value: TOut): void {
    // The presence bit is emitted by PObject, which unwraps this node; a
    // direct write means top-level use, where absence has no slot to live in.
    if (value == null) {
      throw new TypeError(
        '.optional() is only meaningful on object fields; a top-level optional cannot encode null/undefined'
      );
    }
    this.inner._write(enc, value);
  }

  _read(dec: Decoder): TOut {
    return this.inner._read(dec);
  }

  optional(): POptional<TOut> {
    // Optionality is a single presence bit; wrapping twice would change
    // nothing but make PObject's one-level unwrap miss the real node.
    return this;
  }
}

/**
 * The shared integer-lattice wire: one index against optional [min, max]
 * bounds. Both bounds -> one slot of exact radix; one bound -> a term counting
 * away from it (downward from a max, so the term stays non-negative);
 * unbounded -> sign before magnitude, the order every signed value on the
 * wire reads. PInt, PDecimal and PDate all pack through here, so their
 * layouts can never drift apart.
 */
function writeIndex(enc: Encoder, index: number, min?: number, max?: number): void {
  if (min !== undefined && max !== undefined) {
    enc.compose(index - min, max - min + 1);
  } else if (min !== undefined) {
    const offset = index - min;
    // Float subtraction rounds once the offset passes 2^53, which would
    // silently encode a neighbouring value. Refuse anything that cannot
    // reconstruct exactly — the check IS the decode expression.
    if (min + offset !== index) {
      throw new RangeError(`Value '${index}' is too far from its bound to encode exactly`);
    }
    enc.composeTerm(offset);
  } else if (max !== undefined) {
    const offset = max - index;
    if (max - offset !== index) {
      throw new RangeError(`Value '${index}' is too far from its bound to encode exactly`);
    }
    enc.composeTerm(offset);
  } else {
    enc.compose(index < 0 ? 1 : 0, 2);
    enc.composeTerm(Math.abs(index));
  }
}

function readIndex(dec: Decoder, min?: number, max?: number): number {
  if (min !== undefined && max !== undefined) {
    return min + dec.parse(max - min + 1);
  }
  if (min !== undefined) {
    const offset = dec.parseTerm();
    const index = min + offset;
    // Mirror of the encode-side exactness guard: an offset whose sum rounds
    // could never have been emitted.
    if (index - min !== offset) {
      throw new CorruptInputError('Term offset is outside the exact range of its bound');
    }
    return index;
  }
  if (max !== undefined) {
    const offset = dec.parseTerm();
    const index = max - offset;
    if (max - index !== offset) {
      throw new CorruptInputError('Term offset is outside the exact range of its bound');
    }
    return index;
  }
  const negative = dec.parse(2) === 1;
  const magnitude = dec.parseTerm();
  // The encoder never signs a zero, so a signed zero is a corrupted input,
  // not a value.
  if (negative && magnitude === 0) {
    throw new CorruptInputError('Non-canonical negative zero in input');
  }
  return negative ? -magnitude : magnitude;
}

/** Integer (strict: non-integers throw). `p.int`. */
export class PInt extends PNode<number> {
  private readonly _min?: number;
  private readonly _max?: number;

  constructor(min?: number, max?: number) {
    super();
    // Round each bound INWARD (ceil the min, floor the max) so a fractional
    // bound never widens the declared range: .min(10.9) admits 11 and up.
    this._min = min == null ? undefined : Math.ceil(min);
    this._max = max == null ? undefined : Math.floor(max);
    if (this._min !== undefined && !Number.isFinite(this._min)) {
      throw new TypeError('p.int min must be a finite number');
    }
    if (this._max !== undefined && !Number.isFinite(this._max)) {
      throw new TypeError('p.int max must be a finite number');
    }
    // After inward rounding a fractional band can invert (.min(2.1).max(2.9))
    // when it contains no integer. Reject it rather than silently swapping the
    // bounds into a WIDER range that would admit values below the declared
    // minimum.
    if (this._min !== undefined && this._max !== undefined && this._min > this._max) {
      throw new RangeError(
        `p.int range is empty: no integer lies within the requested bounds (rounded to [${this._min}, ${this._max}])`
      );
    }
    // Index arithmetic (value - min) is only exact while the span fits in
    // exact integer range; a wider band would round values silently.
    if (
      this._min !== undefined &&
      this._max !== undefined &&
      this._max - this._min > Number.MAX_SAFE_INTEGER
    ) {
      throw new RangeError('p.int range is wider than exact integer arithmetic supports');
    }
  }

  min(n: number): PInt {
    return new PInt(n, this._max);
  }

  max(n: number): PInt {
    return new PInt(this._min, n);
  }

  _write(enc: Encoder, value: number): void {
    // Strict, like every other node: a fractional value is off the integer
    // lattice and throws — truncating it away would silently lose data.
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new TypeError(`p.int expected an integer, got ${String(value)}`);
    }
    // `+ 0` normalizes -0 to 0 so the sign bit never records a negative zero.
    const v = value + 0;

    if ((this._min !== undefined && v < this._min) || (this._max !== undefined && v > this._max)) {
      throw new RangeError(`Value '${v}' exceeds range bounds`);
    }

    writeIndex(enc, v, this._min, this._max);
  }

  _read(dec: Decoder): number {
    return readIndex(dec, this._min, this._max);
  }
}

// Smallest number of decimal places at which x is represented exactly, or
// null when there is none within double precision (e.g. 1/3, Math.PI).
const decimalPlaces = (x: number): number | null => {
  let e = 1;
  for (let places = 0; places <= 15; places++, e *= 10) {
    if (Math.round(x * e) / e === x) {
      return places;
    }
  }
  return null;
};

/**
 * Number on a fixed decimal step. `p.decimal`.
 *
 * The value is required to be an exact multiple of `step` and is encoded as
 * the integer multiple, so `p.decimal(0.01).min(0).max(100)` spends the same
 * state as `p.int().min(0).max(10000)`. All arithmetic runs in
 * decimal-scaled integers — never
 * raw float division — so on-grid values encode and decode bit-exact and
 * off-grid values throw instead of snapping to a neighbour.
 */
export class PDecimal extends PNode<number> {
  private readonly _step: number;
  private readonly _minRaw?: number;
  private readonly _maxRaw?: number;
  /** 10^places that makes step and both bounds integers. */
  private readonly _scale: number;
  private readonly _scaledStep: number;
  /** Multiple-of-step bounds, rounded inward onto the grid. */
  private readonly _kMin?: number;
  private readonly _kMax?: number;

  constructor(step: number, min?: number, max?: number) {
    super();
    if (typeof step !== 'number' || !(step > 0)) {
      throw new TypeError('p.decimal step must be a positive number');
    }

    const places = [step, min, max].map((n) => (n == null ? 0 : decimalPlaces(n)));
    if (places.some((n) => n === null)) {
      // A step or bound without a finite decimal form (1/3, Math.PI) has no
      // exact scaled-integer representation, so every value would be off-grid
      // by a rounding hair. Reject the schema instead of guessing.
      throw new TypeError('p.decimal step and bounds must be exact decimals (<= 15 places)');
    }

    this._step = step;
    this._minRaw = min ?? undefined;
    this._maxRaw = max ?? undefined;
    this._scale = 10 ** Math.max(...(places as number[]));
    this._scaledStep = Math.round(step * this._scale);

    // Like p.int bounds, round each bound INWARD onto the grid (ceil the min
    // multiple, floor the max multiple) so a bound off the grid never admits
    // a value beyond itself.
    if (min != null) {
      const scaledMin = Math.round(min * this._scale);
      if (Math.abs(scaledMin) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError('p.decimal min is outside the exact range of this step');
      }
      this._kMin = Math.ceil(scaledMin / this._scaledStep);
    }
    if (max != null) {
      const scaledMax = Math.round(max * this._scale);
      if (Math.abs(scaledMax) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError('p.decimal max is outside the exact range of this step');
      }
      this._kMax = Math.floor(scaledMax / this._scaledStep);
    }
    if (this._kMin !== undefined && this._kMax !== undefined && this._kMin > this._kMax) {
      throw new RangeError(
        'p.decimal range is empty: no multiple of the step lies within the requested bounds'
      );
    }
    // Index arithmetic (multiple - kMin) is only exact while the span of
    // multiples fits in exact integer range.
    if (
      this._kMin !== undefined &&
      this._kMax !== undefined &&
      this._kMax - this._kMin > Number.MAX_SAFE_INTEGER
    ) {
      throw new RangeError('p.decimal range spans more steps than exact arithmetic supports');
    }
  }

  min(n: number): PDecimal {
    return new PDecimal(this._step, n, this._maxRaw);
  }

  max(n: number): PDecimal {
    return new PDecimal(this._step, this._minRaw, n);
  }

  _write(enc: Encoder, value: number): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`p.decimal expected a finite number, got ${String(value)}`);
    }

    const scaled = Math.round(value * this._scale);
    // Beyond 2^53 the scaled integer (and the decode product) stops being
    // exact, which would silently violate the bit-exact contract.
    if (Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Value '${value}' is outside the exact range of this step`);
    }
    // Round-tripping through the scale proves the value carries no precision
    // beyond the grid; the remainder check proves it sits on a step multiple.
    if (scaled / this._scale !== value || scaled % this._scaledStep !== 0) {
      throw new RangeError(`Value '${value}' is not a multiple of step ${this._step}`);
    }

    // `+ 0` normalizes the -0 quotient of a negative zero input.
    const k = scaled / this._scaledStep + 0;

    if (
      (this._kMin !== undefined && k < this._kMin) ||
      (this._kMax !== undefined && k > this._kMax)
    ) {
      throw new RangeError(`Value '${value}' exceeds range bounds`);
    }

    writeIndex(enc, k, this._kMin, this._kMax);
  }

  _read(dec: Decoder): number {
    const k = readIndex(dec, this._kMin, this._kMax);
    const scaled = k * this._scaledStep;
    // Mirror of the encode-side exactness guard: a product past 2^53 rounds,
    // and the encoder could never have emitted it.
    if (Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
      throw new CorruptInputError('Step multiple is outside the exact range of its step');
    }
    // Integer times integer, divided once by the power-of-ten scale: exact at
    // every step, so this lands on the same double the caller passed in.
    return scaled / this._scale;
  }
}

// Scratch views for splitting a double into its IEEE-754 fields and back.
// Both views share one buffer, so platform endianness cancels out; the wire
// carries the fields as plain integers, never raw bytes.
const FLOAT_SCRATCH = new Float64Array(1);
const FLOAT_BITS = new BigUint64Array(FLOAT_SCRATCH.buffer);
const MANTISSA_BITS = 52n;
const MANTISSA_RADIX = 2 ** 52;
// Finite doubles use exponents 0..2046; 2047 encodes NaN/Infinity, which this
// codec rejects. The exponent rides the term encoding as the zigzag of its
// distance from the bias (0, -1, +1, -2 -> 0, 1, 2, 3): real-world magnitudes
// cluster near 1, so the common exponents spend ~2-8 bits where a flat radix
// would spend 11. Zigzag over sign-plus-magnitude because it is a bijection,
// leaving no signed-zero wire state to reject.
const EXPONENT_BIAS = 1023;
const EXPONENT_ZIGZAG_MAX = 2046;
/** Full significand of 1.0: the implicit leading bit of every normal double. */
const SIGNIFICAND_ONE = 1n << MANTISSA_BITS;

/**
 * Simplest rational (smallest denominator, then smallest numerator) in the
 * open interval (a/b, c/d). Stern-Brocot descent driven by the continued
 * fractions of the endpoints, so it runs in O(log max(b, d)) BigInt steps.
 */
function simplestInInterval(a: bigint, b: bigint, c: bigint, d: bigint): [bigint, bigint] {
  const whole = a / b;
  if ((whole + 1n) * d < c) {
    return [whole + 1n, 1n];
  }
  if (a % b === 0n) {
    // The interval opens exactly on the integer `whole`, so the simplest
    // interior value is whole + 1/t for the smallest t that fits below c/d.
    const t = d / (c - whole * d) + 1n;
    return [whole * t + 1n, t];
  }
  const [sn, sd] = simplestInInterval(d, c - whole * d, b, a - whole * b);
  return [whole * sn + sd, sn];
}

/**
 * Wire states an inline term run of value n consumes. The formula assumes an
 * inline run; escaped terms exceed the flat-significand budget long before
 * the escape range, so the fraction-vs-flat comparison is unaffected.
 */
function termRunStates(n: bigint): bigint {
  let states = BigInt(TERM_BASE + 2);
  for (let v = n; v > 0n; v /= BigInt(TERM_BASE)) {
    states *= BigInt(TERM_BASE + 1);
  }
  return states;
}

// Selector states for a normal significand: flat mantissa, plain fraction,
// or a fraction times a power of five (the decimal realm).
const SIG_FLAT = 0;
const SIG_FRACTION = 1;
const SIG_FRACTION5 = 2;
const SIG_SELECTOR = 3;
/** Bound on the five-realm shift; shortest-decimal forms never exceed it. */
const FIVE_SHIFT_MAX = 500;

// Zigzag over the NONZERO integers (+1, -1, +2, -2 -> 0, 1, 2, 3): a zero
// shift is the plain-fraction selector state, so it has no code here.
const zigNonzero = (f: number): number => (f > 0 ? 2 * (f - 1) : -2 * f - 1);
const unzigNonzero = (z: number): number => (z % 2 === 0 ? z / 2 + 1 : -(z + 1) / 2);

const bitLength = (x: bigint): number => x.toString(2).length;

/**
 * The five-realm shift suggested by a value's shortest round-trip decimal
 * form (`toString`, pinned by the ECMAScript spec, so encoder and decoder
 * derive the same candidate): a X.YeZ decimal names the double as
 * digits x 10^k, whose fives are digits' own times 5^k.
 */
function fiveShiftCandidate(value: number): number {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(Math.abs(value).toString());
  if (match === null) {
    return 0;
  }
  let digits = match[1] + (match[2] ?? '');
  let shift = (match[3] ? Number(match[3]) : 0) - (match[2]?.length ?? 0);
  while (digits.length > 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    shift++;
  }
  for (let n = BigInt(digits); n % 5n === 0n; n /= 5n) {
    shift++;
  }
  return shift;
}

/** The canonical spelling of a normal significand. */
interface SignificandForm {
  sel: number;
  /** Five-realm shift; 0 outside SIG_FRACTION5. */
  f: number;
  /** Fraction p/q with p in [q, 2q); 0/0 for SIG_FLAT. */
  p: bigint;
  q: bigint;
}

/**
 * Simplest fraction in the significand's rounding interval, scaled into the
 * five realm by `shift` and 2-normalized so p lands in [q, 2q). Returns null
 * when the scaled window straddles a binade edge, where no such p exists.
 */
function windowFraction(significand: bigint, shift: number): [bigint, bigint] | null {
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

  const [p, q] = simplestInInterval(loN, loD, hiN, hiD);
  return p < q || p >= 2n * q ? null : [p, q];
}

/**
 * The canonical form of a normal significand: flat, fraction, or fraction in
 * the five realm — whichever spends the fewest wire states, with ties going
 * to the earlier selector. Interval endpoints always carry denominators far
 * beyond any fraction that can win, so open intervals are exact here and
 * rounding ties never reach the wire format.
 */
function canonicalSignificand(significand: bigint, value: number): SignificandForm {
  let best: SignificandForm = { sel: SIG_FLAT, f: 0, p: 0n, q: 0n };
  let bestStates = SIGNIFICAND_ONE;

  const plain = windowFraction(significand, 0);
  if (plain !== null) {
    const states = termRunStates(plain[1] - 1n) * plain[1];
    if (states < bestStates) {
      best = { sel: SIG_FRACTION, f: 0, p: plain[0], q: plain[1] };
      bestStates = states;
    }
  }

  const shift = fiveShiftCandidate(value);
  if (shift !== 0 && Math.abs(shift) <= FIVE_SHIFT_MAX) {
    const scaled = windowFraction(significand, shift);
    if (scaled !== null) {
      const states =
        termRunStates(BigInt(zigNonzero(shift))) * termRunStates(scaled[1] - 1n) * scaled[1];
      if (states < bestStates) {
        best = { sel: SIG_FRACTION5, f: shift, p: scaled[0], q: scaled[1] };
      }
    }
  }

  return best;
}

/**
 * Round num/den to the significand grid [2^52, 2^53). Ties are impossible:
 * a halfway point carries a denominator of exactly 2^53, and wire fractions
 * keep the two-adic part of their denominator below 2^22.
 */
function roundToSignificand(num: bigint, den: bigint): bigint {
  // The bit-length estimate can be off by one; re-divide at the corrected
  // scale rather than halving a rounded result, which would round twice.
  for (let shift = 52 + bitLength(den) - bitLength(num); ; ) {
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
    if (m >= 2n * SIGNIFICAND_ONE) {
      shift--;
    } else if (m < SIGNIFICAND_ONE) {
      shift++;
    } else {
      return m;
    }
  }
}

/** Assemble a positive double from IEEE fields; toString on it drives the
 * five-realm candidate, so it must carry the true exponent. */
function doubleFrom(exponent: number, mantissa: bigint): number {
  FLOAT_BITS[0] = (BigInt(exponent) << MANTISSA_BITS) | mantissa;
  return FLOAT_SCRATCH[0];
}

/**
 * IEEE-754 double, bit-exact. The significand travels as the cheapest of
 * three spellings — flat mantissa, simplest fraction in the double's
 * rounding interval, or that fraction times a power of five (the decimal
 * realm) — so human-entered values pack in a few bytes at any magnitude.
 * `p.float`.
 */
export class PFloat extends PNode<number> {
  _write(enc: Encoder, value: number): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`p.float expected a finite number, got ${String(value)}`);
    }

    FLOAT_SCRATCH[0] = value;
    const bits = FLOAT_BITS[0];
    const exponent = Number((bits >> MANTISSA_BITS) & 0x7ffn);
    const mantissa = bits & 0xfffffffffffffn;
    enc.compose(Number(bits >> 63n), 2);
    enc.composeTerm(
      exponent >= EXPONENT_BIAS
        ? (exponent - EXPONENT_BIAS) * 2
        : (EXPONENT_BIAS - exponent) * 2 - 1
    );

    // Zero and subnormals have no implicit bit and no [1, 2) significand, so
    // the fraction forms are undefined there: the mantissa goes flat with no
    // selector slot.
    if (exponent === 0) {
      enc.compose(Number(mantissa), MANTISSA_RADIX);
      return;
    }

    const form = canonicalSignificand(SIGNIFICAND_ONE | mantissa, value);
    enc.compose(form.sel, SIG_SELECTOR);
    if (form.sel === SIG_FLAT) {
      enc.compose(Number(mantissa), MANTISSA_RADIX);
      return;
    }
    if (form.sel === SIG_FRACTION5) {
      enc.composeTerm(zigNonzero(form.f));
    }
    enc.composeTerm(Number(form.q - 1n));
    // p sits in [q, 2q) by construction: the numerator rides in an exact
    // radix-q slot as its offset from q.
    enc.compose(Number(form.p - form.q), Number(form.q));
  }

  _read(dec: Decoder): number {
    const sign = BigInt(dec.parse(2));
    const zigzag = dec.parseTerm();
    // A term is open-ended where a radix is not: anything past the top finite
    // exponent is a wire state the encoder cannot emit.
    if (zigzag > EXPONENT_ZIGZAG_MAX) {
      throw new CorruptInputError('Float exponent is outside the finite range');
    }
    const exponent =
      zigzag % 2 === 0 ? EXPONENT_BIAS + zigzag / 2 : EXPONENT_BIAS - (zigzag + 1) / 2;

    let mantissa: bigint;
    if (exponent === 0) {
      mantissa = BigInt(dec.parse(MANTISSA_RADIX));
    } else {
      const sel = dec.parse(SIG_SELECTOR);
      let f = 0;
      let p = 0n;
      let q = 0n;
      if (sel === SIG_FRACTION5) {
        f = unzigNonzero(dec.parseTerm());
        if (Math.abs(f) > FIVE_SHIFT_MAX) {
          throw new CorruptInputError('Five-realm shift is outside the canonical range');
        }
      }

      if (sel === SIG_FLAT) {
        mantissa = BigInt(dec.parse(MANTISSA_RADIX));
      } else {
        q = BigInt(dec.parseTerm()) + 1n;
        // Checked before the numerator slot so an absurd denominator fails as
        // corruption rather than as an oversized radix.
        const states =
          (sel === SIG_FRACTION5 ? termRunStates(BigInt(zigNonzero(f))) : 1n) *
          termRunStates(q - 1n) *
          q;
        if (states >= SIGNIFICAND_ONE) {
          throw new CorruptInputError('Fraction spelling is dearer than the flat mantissa');
        }
        p = q + BigInt(dec.parse(Number(q)));
        // Rebuild the named significand in exact arithmetic: the name is
        // p/q shifted by 5^f, rounded onto the significand grid.
        const scale = 5n ** BigInt(Math.abs(f));
        mantissa =
          roundToSignificand(f >= 0 ? p * scale : p, f >= 0 ? q : q * scale) - SIGNIFICAND_ONE;
      }

      // One spelling per value: whatever branch the wire took must be the
      // spelling the encoder would have chosen for the decoded significand.
      const form = canonicalSignificand(SIGNIFICAND_ONE | mantissa, doubleFrom(exponent, mantissa));
      if (form.sel !== sel || form.f !== f || form.p !== p || form.q !== q) {
        throw new CorruptInputError('Significand spelling is not the canonical form');
      }
    }

    FLOAT_BITS[0] = (sign << 63n) | (BigInt(exponent) << MANTISSA_BITS) | mantissa;
    return FLOAT_SCRATCH[0];
  }
}

/** UTF-16 string. Default charset is the full `[0, 65535]` range. `p.string`. */
export class PString extends PNode<string> {
  private readonly _max?: number;
  private readonly _charset: Charset;
  /** Symbol count of a range charset; undefined for string charsets. */
  private readonly _size?: number;

  constructor(max?: number, charset: Charset = UTF16_RANGE) {
    super();
    // Round the cap INWARD (floor) so a fractional cap never admits a longer
    // string than declared.
    this._max = max == null ? undefined : Math.floor(max);
    if (this._max !== undefined && (!Number.isInteger(this._max) || this._max < 0)) {
      throw new RangeError('p.string max must be a non-negative length');
    }
    // validateCharset returns a normalized copy, so later caller mutation of a
    // range array can't change the node.
    this._charset = validateCharset(charset);
    if (typeof this._charset !== 'string') {
      this._size = this._charset[1] - this._charset[0] + 1;
    }
  }

  max(n: number): PString {
    return new PString(n, this._charset);
  }

  charset(c: Charset): PString {
    return new PString(this._max, c);
  }

  _write(enc: Encoder, value: string): void {
    if (typeof value !== 'string') {
      throw new TypeError(`p.string expected a string, got ${String(value)}`);
    }

    if (this._max === undefined) {
      enc.composeTerm(value.length);
    } else if (value.length > this._max) {
      throw new RangeError(`String '${value}' exceeds max length`);
    } else {
      enc.compose(value.length, this._max + 1);
    }

    for (let i = 0; i < value.length; i++) {
      if (typeof this._charset === 'string') {
        const pos = this._charset.indexOf(value.charAt(i));
        if (pos === -1) {
          throw new Error('String not compliant with character set');
        }
        enc.compose(pos, this._charset.length);
      } else {
        const code = value.charCodeAt(i);
        if (code < this._charset[0] || code > this._charset[1]) {
          throw new Error('String not compliant with character set');
        }
        enc.compose(code - this._charset[0], this._size!);
      }
    }
  }

  _read(dec: Decoder): string {
    const length = this._max === undefined ? dec.parseTerm() : dec.parse(this._max + 1);
    let value = '';
    for (let i = 0; i < length; i++) {
      if (typeof this._charset === 'string') {
        value += this._charset.charAt(dec.parse(this._charset.length));
      } else {
        value += String.fromCharCode(dec.parse(this._size!) + this._charset[0]);
      }
    }
    return value;
  }
}

/** Boolean. `p.bool`. */
export class PBool extends PNode<boolean> {
  _write(enc: Encoder, value: boolean): void {
    if (typeof value !== 'boolean') {
      throw new TypeError(`p.bool expected a boolean, got ${String(value)}`);
    }
    enc.compose(value ? 1 : 0, 2);
  }

  _read(dec: Decoder): boolean {
    return Boolean(dec.parse(2));
  }
}

/**
 * Enum: a fixed list of values, packed as a sub-byte index. `p.enum`.
 *
 * Membership is identity (`===`), so members can be anything with a stable
 * reference: strings, numbers, objects, functions, symbols. Decode returns
 * the listed member itself, not a copy.
 */
export class PEnum<T> extends PNode<T> {
  private readonly _list: readonly T[];

  constructor(list: readonly T[]) {
    super();
    if (!isArray(list) || list.length === 0) {
      throw new TypeError('p.enum requires a non-empty list');
    }
    for (const member of list) {
      // The one real requirement: a member must equal itself under the ===
      // that indexOf uses, or it could never be encoded. Only NaN fails this.
      if (member !== member) {
        throw new TypeError('p.enum members must equal themselves; NaN cannot be encoded');
      }
    }
    // A duplicate member is unreachable behind its first occurrence and
    // silently inflates the radix every value pays for.
    if (new Set(list).size !== list.length) {
      throw new TypeError('p.enum members must be unique');
    }
    this._list = [...list]; // copy so later caller mutation can't change the node
  }

  _write(enc: Encoder, value: T): void {
    const pos = this._list.indexOf(value);
    if (pos === -1) {
      throw new Error(`Value '${String(value)}' not found in list`);
    }
    enc.compose(pos, this._list.length);
  }

  _read(dec: Decoder): T {
    return this._list[dec.parse(this._list.length)];
  }
}

/** Date. Default interval is 1ms (lossless); larger intervals are lossy. `p.date`. */
export class PDate extends PNode<Date> {
  private readonly _min?: number;
  private readonly _max?: number;
  private readonly _interval: number;

  constructor(min?: number | Date, max?: number | Date, interval: number | DateInterval = 1) {
    super();
    this._min = isDate(min) ? min.getTime() : (min ?? undefined);
    this._max = isDate(max) ? max.getTime() : (max ?? undefined);

    if (
      (this._min !== undefined && !Number.isInteger(this._min)) ||
      (this._max !== undefined && !Number.isInteger(this._max))
    ) {
      throw new TypeError('p.date bounds must be Dates or integer timestamps');
    }
    // Swapping the bounds silently would accept dates before the declared
    // minimum and reject dates the caller declared valid.
    if (this._min !== undefined && this._max !== undefined && this._min > this._max) {
      throw new RangeError('p.date minimum exceeds maximum');
    }

    if (typeof interval === 'string') {
      if (!(interval in DATE_INTERVALS)) {
        throw new TypeError('Invalid date interval');
      }
      interval = DATE_INTERVALS[interval as DateInterval];
    }
    // The interval is a divisor (ms per bucket). 0/negative/non-integer values
    // have no coherent meaning and an interval of 0 would divide by zero.
    if (typeof interval !== 'number' || !(interval > 0) || interval % 1 !== 0) {
      throw new TypeError('Invalid date interval');
    }
    this._interval = interval;
    // No span guard here: it would depend on the interval, which a chained
    // `.interval()` sets only after the bounds construct intermediate nodes.
    // The quantization check in `_write` catches drift per value instead.
  }

  min(n: number | Date): PDate {
    return new PDate(n, this._max, this._interval);
  }

  max(n: number | Date): PDate {
    return new PDate(this._min, n, this._interval);
  }

  interval(i: number | DateInterval): PDate {
    return new PDate(this._min, this._max, i);
  }

  _write(enc: Encoder, value: Date): void {
    if (!isDate(value) || isNaN(value.getTime())) {
      throw new TypeError(`p.date expected a valid Date, got ${String(value)}`);
    }
    const timestamp = value.getTime();

    if (this._min !== undefined && timestamp < this._min) {
      throw new RangeError(`Date '${value.toISOString()}' is before the minimum bound`);
    }
    if (this._max !== undefined && timestamp > this._max) {
      throw new RangeError(`Date '${value.toISOString()}' is after the maximum bound`);
    }

    // Quantize relative to the min bound (or epoch when unbounded below).
    // Anchoring at min guarantees every in-range date is representable AND
    // that no decoded date falls below the declared minimum. Buckets count
    // from 0 when a min exists, so the index bounds are [0, maxBucket].
    const base = this._min ?? 0;
    const bucket = Math.floor((timestamp - base) / this._interval);

    // The bucket must land within one interval below the timestamp; float
    // drift in the offset arithmetic past 2^53 would miss that silently.
    const reconstructed = base + bucket * this._interval;
    if (reconstructed > timestamp || timestamp - reconstructed >= this._interval) {
      throw new RangeError(
        `Date '${value.toISOString()}' is too far from its bound to quantize exactly`
      );
    }

    writeIndex(enc, bucket, this._bucketMin(), this._bucketMax());
  }

  _read(dec: Decoder): Date {
    const base = this._min ?? 0;
    const bucket = readIndex(dec, this._bucketMin(), this._bucketMax());
    const date = new Date(base + bucket * this._interval);
    // A bucket beyond the ±8.64e15 ms Date range can only come from a
    // corrupted input; the encoder requires a valid Date.
    if (isNaN(date.getTime())) {
      throw new CorruptInputError('Date is outside the representable time range');
    }
    return date;
  }

  private _bucketMin(): number | undefined {
    return this._min === undefined ? undefined : 0;
  }

  private _bucketMax(): number | undefined {
    return this._max === undefined
      ? undefined
      : Math.floor((this._max - (this._min ?? 0)) / this._interval);
  }
}

/** Count constraints for an array node: min/max bounds, or a fixed length. */
interface ArrayBounds {
  min?: number;
  max?: number;
  length?: number;
}

/**
 * Array of one item type. The count travels through the shared integer
 * lattice with bounds `[min ?? 0, max]`: unbounded counts are term-prefixed,
 * bounded counts pack against their range, and a fixed `.length(n)` collapses
 * the range to one state — the count then costs zero bits on the wire.
 */
export class PArray<TItem> extends PNode<TItem[]> {
  private readonly _item: PNode<TItem>;
  private readonly _min?: number;
  private readonly _max?: number;
  private readonly _length?: number;

  constructor(item: PNode<TItem>, bounds: ArrayBounds = {}) {
    super();
    if (!(item instanceof PNode)) {
      throw new TypeError('p.array requires a schema node for its item type');
    }
    // The presence bit only exists for object fields; an array slot is always
    // occupied, so an optional item type could never mark anything absent.
    if (item instanceof POptional) {
      throw new TypeError('p.array items cannot be .optional(); make the array itself optional');
    }
    this._item = item;

    // A fixed length IS both bounds; combining the two spellings is a
    // contradiction, so it throws instead of silently merging.
    if (bounds.length != null && (bounds.min != null || bounds.max != null)) {
      throw new TypeError('p.array length cannot be combined with min or max');
    }

    if (bounds.length != null) {
      // No inward rounding here: no count satisfies a fractional length, so
      // either rounding direction would invent a contract never declared.
      if (!Number.isInteger(bounds.length) || bounds.length < 0) {
        throw new RangeError('p.array length must be a non-negative integer count');
      }
      this._length = bounds.length;
    }
    // Like p.int bounds, round each bound INWARD (ceil the min, floor the
    // max) so a fractional bound never admits a count beyond itself.
    if (bounds.min != null) {
      this._min = Math.ceil(bounds.min);
      if (!Number.isInteger(this._min) || this._min < 0) {
        throw new RangeError('p.array min must be a non-negative count');
      }
    }
    if (bounds.max != null) {
      this._max = Math.floor(bounds.max);
      if (!Number.isInteger(this._max) || this._max < 0) {
        throw new RangeError('p.array max must be a non-negative count');
      }
    }
    if (this._min !== undefined && this._max !== undefined && this._min > this._max) {
      throw new RangeError('p.array range is empty: min exceeds max');
    }
  }

  /** Require at least `n` items. A raised floor packs the count denser. */
  min(n: number): PArray<TItem> {
    return new PArray<TItem>(this._item, { min: n, max: this._max, length: this._length });
  }

  /** Cap the item count. A capped count packs denser than the uncapped prefix. */
  max(n: number): PArray<TItem> {
    return new PArray<TItem>(this._item, { min: this._min, max: n, length: this._length });
  }

  /** Fix the exact item count. The count then costs zero bits on the wire. */
  length(n: number): PArray<TItem> {
    return new PArray<TItem>(this._item, { min: this._min, max: this._max, length: n });
  }

  _write(enc: Encoder, value: TItem[]): void {
    if (!isArray(value)) {
      throw new TypeError('p.array expected an array');
    }
    const count = value.length;

    if (this._length !== undefined && count !== this._length) {
      throw new RangeError('Array length differs from the fixed length');
    }
    if (this._min !== undefined && count < this._min) {
      throw new RangeError('Array length is below the minimum');
    }
    if (this._max !== undefined && count > this._max) {
      throw new RangeError('Array length exceeds maximum');
    }

    writeIndex(enc, count, this._countMin(), this._countMax());

    // Indexed iteration, not for-of over holes: a sparse array's holes read as
    // undefined and must fail the item's own validation rather than be skipped,
    // or the element count would desync from the length prefix.
    for (let i = 0; i < count; i++) {
      this._item._write(enc, value[i]);
    }
  }

  _read(dec: Decoder): TItem[] {
    const count = readIndex(dec, this._countMin(), this._countMax());
    const value: TItem[] = [];
    for (let i = 0; i < count; i++) {
      value.push(this._item._read(dec));
    }
    return value;
  }

  /** A count is never negative, so the lattice floor defaults to 0. */
  private _countMin(): number {
    return this._length ?? this._min ?? 0;
  }

  private _countMax(): number | undefined {
    return this._length ?? this._max;
  }
}

/** Object with a fixed shape. Optional fields carry a single presence bit. */
export class PObject<S extends Record<string, PNode<any>>> extends PNode<InferShape<S>> {
  private readonly _shape: S;
  private readonly _keys: readonly string[];

  constructor(shape: S) {
    super();
    this._shape = { ...shape }; // copy so later caller mutation can't change the node
    this._keys = Object.keys(this._shape);
    for (const key of this._keys) {
      if (!(this._shape[key] instanceof PNode)) {
        throw new TypeError(`p.object field '${key}' is not a schema node`);
      }
    }
  }

  _write(enc: Encoder, value: InferShape<S>): void {
    if (!isObject(value) || isArray(value)) {
      throw new TypeError('p.object expected an object');
    }

    for (const key of this._keys) {
      const field = this._shape[key];
      const optional = field instanceof POptional;
      // Unwrap the optional marker so the presence bit is written here, once;
      // the inner node never learns it was optional.
      const node = optional ? (field as POptional<unknown>).inner : field;
      const v = (value as Record<string, unknown>)[key];

      // Only `undefined` means absent. `null` is a value in its own right (the
      // any type round-trips it), so it must reach the field's node.
      if (v === undefined) {
        if (optional) {
          enc.compose(0, 2);
          continue;
        }
        throw new ReferenceError(`Object has no property '${key}'`);
      }

      if (optional) {
        enc.compose(1, 2);
      }
      node._write(enc, v);
    }
  }

  _read(dec: Decoder): InferShape<S> {
    const value: Record<string, unknown> = {};

    for (const key of this._keys) {
      const field = this._shape[key];
      const optional = field instanceof POptional;
      const node = optional ? (field as POptional<unknown>).inner : field;

      if (optional && dec.parse(2) === 0) {
        continue;
      }

      const v = node._read(dec);
      // `undefined` is the absence marker on encode, so no object can carry
      // it as a field VALUE — a wire state decoding to one (an `any` field's
      // undefined tag) has no canonical spelling and must read as corruption.
      if (v === undefined) {
        throw new CorruptInputError('Object field decoded as undefined, which is not encodable');
      }

      // A schema key named '__proto__' must land as an own property; plain
      // assignment would hit the prototype setter and silently drop it.
      if (key === '__proto__') {
        Object.defineProperty(value, key, {
          value: v,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        value[key] = v;
      }
    }

    return value as InferShape<S>;
  }
}

// Type tags for the self-describing `any` codec: absent values, then scalars,
// then containers. Integers and floats are distinct so integer values
// round-trip bit-exact through `composeTerm` instead of drifting through the
// fraction approximation.
const TAG_COUNT = 9;
const TAG_UNDEFINED = 0;
const TAG_NULL = 1;
const TAG_BOOLEAN = 2;
const TAG_INT = 3;
const TAG_FLOAT = 4;
const TAG_STRING = 5;
const TAG_DATE = 6;
const TAG_ARRAY = 7;
const TAG_OBJECT = 8;

/** Self-describing escape hatch. Output type `unknown`. `p.any`. */
export class PAny extends PNode<unknown> {
  _write(enc: Encoder, value: unknown): void {
    this._writeAny(enc, value, new WeakSet());
  }

  /**
   * `path` holds the containers between the root and the current value.
   * Membership means a cycle, which would otherwise recurse forever; it is
   * removed again on the way out so a shared (diamond) reference still
   * encodes — once per occurrence, as separate copies.
   */
  private _writeAny(enc: Encoder, value: unknown, path: WeakSet<object>): void {
    // `null` and arrays both report `typeof 'object'`, so handle them first.
    if (value === null) {
      enc.compose(TAG_NULL, TAG_COUNT);
      return;
    }

    if (isArray(value)) {
      if (path.has(value)) {
        throw new TypeError('p.any cannot encode a circular structure');
      }
      path.add(value);
      enc.compose(TAG_ARRAY, TAG_COUNT);
      enc.composeTerm(value.length);
      // Indexed iteration: sparse holes must encode (as `undefined`) so the
      // element count stays consistent with the length prefix.
      for (let i = 0; i < value.length; i++) {
        this._writeAny(enc, value[i], path);
      }
      path.delete(value);
      return;
    }

    switch (typeof value) {
      case 'undefined':
        enc.compose(TAG_UNDEFINED, TAG_COUNT);
        break;

      case 'number':
        // -0 is integer-valued but the int lattice normalizes it away; the
        // float path carries its sign bit, so every double round-trips exact.
        if (Number.isInteger(value) && !Object.is(value, -0)) {
          enc.compose(TAG_INT, TAG_COUNT);
          ANY_INT._write(enc, value);
        } else {
          enc.compose(TAG_FLOAT, TAG_COUNT);
          ANY_FLOAT._write(enc, value);
        }
        break;

      case 'string':
        enc.compose(TAG_STRING, TAG_COUNT);
        ANY_STRING._write(enc, value);
        break;

      case 'boolean':
        enc.compose(TAG_BOOLEAN, TAG_COUNT);
        ANY_BOOL._write(enc, value);
        break;

      case 'object':
        if (isDate(value)) {
          enc.compose(TAG_DATE, TAG_COUNT);
          ANY_DATE._write(enc, value);
        } else {
          if (path.has(value)) {
            throw new TypeError('p.any cannot encode a circular structure');
          }
          path.add(value);
          enc.compose(TAG_OBJECT, TAG_COUNT);
          const record = value as Record<string, unknown>;
          const keys = Object.keys(record);
          enc.composeTerm(keys.length);
          for (const key of keys) {
            ANY_STRING._write(enc, key);
            this._writeAny(enc, record[key], path);
          }
          path.delete(value);
        }
        break;

      default:
        throw new TypeError(`Type '${typeof value}' not supported`);
    }
  }

  _read(dec: Decoder): unknown {
    switch (dec.parse(TAG_COUNT)) {
      case TAG_UNDEFINED:
        return undefined;
      case TAG_FLOAT: {
        const value = ANY_FLOAT._read(dec);
        // Integer-valued doubles always travel under the int tag (-0 is the
        // one exception), so a float-tagged integer is a second spelling of
        // the same value — the encoder never emits it.
        if (Number.isInteger(value) && !Object.is(value, -0)) {
          throw new CorruptInputError('Non-canonical float tag on an integer value');
        }
        return value;
      }
      case TAG_STRING:
        return ANY_STRING._read(dec);
      case TAG_BOOLEAN:
        return ANY_BOOL._read(dec);
      case TAG_DATE:
        return ANY_DATE._read(dec);
      case TAG_NULL:
        return null;
      case TAG_INT:
        return ANY_INT._read(dec);
      case TAG_ARRAY: {
        const length = dec.parseTerm();
        const value: unknown[] = [];
        for (let i = 0; i < length; i++) {
          value.push(this._read(dec));
        }
        return value;
      }
      case TAG_OBJECT: {
        const value: Record<string, unknown> = {};
        const count = dec.parseTerm();
        for (let i = 0; i < count; i++) {
          const key = ANY_STRING._read(dec);
          // The encoder walks Object.keys, which never repeats, so a wire
          // duplicate would collapse on decode and re-encode shorter.
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            throw new CorruptInputError('Duplicate key in record');
          }
          // Define an own property: plain assignment would follow a
          // '__proto__' key to the prototype setter, letting wire data replace
          // the decoded object's prototype.
          Object.defineProperty(value, key, {
            value: this._read(dec),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        return value;
      }
      default:
        // parse() bounds the tag to its radix, so this is unreachable.
        throw new CorruptInputError('Unknown any-type tag');
    }
  }
}

// The default nodes the `any` codec delegates to after its type tag. Module
// singletons: `any` has no configuration, so these never vary.
const ANY_INT = new PInt();
const ANY_FLOAT = new PFloat();
const ANY_STRING = new PString();
const ANY_BOOL = new PBool();
const ANY_DATE = new PDate();
