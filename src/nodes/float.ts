import { Encoder, Decoder, CorruptInputError } from '../packer';
import { TERM_BASE } from '../packer/constants';
import { PNode } from './base';

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
