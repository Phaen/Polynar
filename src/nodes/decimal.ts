import { Encoder, Decoder, CorruptInputError } from '../packer';
import { PNode } from './base';
import { describe } from './path';
import type { Kind } from './guards';
import { IndexRange, checkUnset } from './lattice';
import type { Cdf, Prior } from './weights';
import type { AdaptiveOptions } from './adaptive';

const valueSubject = (value: number): string => `Value ${value}`;

/**
 * The smallest number of decimal places at which `x` is represented exactly,
 * or null when there is none within 15 places (1/3, 1e-16) or `x`
 * is not finite.
 */
export const decimalPlaces = (x: number): number | null => {
  if (!Number.isFinite(x)) {
    return null;
  }
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
 *
 * An integer step scales by one, and a double that is a multiple of an
 * integer divides into another double, which multiplies back out exactly, so
 * the grid reaches as far as p.int's. A fractional step scales the value by a
 * power of ten first, which rounds past 2^53, so there the scaled value is
 * kept a safe integer.
 */
export class PDecimal extends PNode<number> {
  readonly _kinds: readonly Kind[] = ['number'];

  private readonly _step: number;
  private readonly _minRaw?: number;
  private readonly _maxRaw?: number;
  /** 10^places that makes the step an integer. */
  private readonly _scale: number;
  private readonly _scaledStep: number;
  /** Indexed by step multiple: the k-th multiple of the step is index k. */
  private readonly _range: IndexRange;
  declare readonly _radix?: number;

  constructor(step: number, min?: number, max?: number, prior?: Prior, adaptive?: AdaptiveOptions) {
    super();
    if (!(step > 0) || step === Infinity) {
      throw new TypeError(`p.decimal step must be a positive finite number, got ${step}`);
    }

    const stepPlaces = decimalPlaces(step);
    if (stepPlaces === null) {
      // A step without a decimal form of at most 15 places (1/3) has no exact
      // scaled-integer representation, so every value would be off-grid by a
      // rounding hair. The schema is rejected rather than guessed at.
      throw new TypeError('p.decimal step must be an exact decimal (<= 15 places)');
    }

    this._step = step;
    this._minRaw = min;
    this._maxRaw = max;
    this._scale = 10 ** stepPlaces;
    this._scaledStep = Math.round(step * this._scale);

    // Bounds sit on the step exactly, like the values they admit.
    const kMin = min === undefined ? undefined : this._bound(min, 'min');
    const kMax = max === undefined ? undefined : this._bound(max, 'max');
    this._range = new IndexRange('p.decimal', kMin, kMax, prior, adaptive, (k) =>
      String(this._valueAt(k))
    );
    this._radix = this._range.radix;
    const fromDigit = this._range.fromDigit;
    if (fromDigit !== undefined) {
      this._fromDigit = (digit) => this._decode(fromDigit(digit));
    }
  }

  min(n: number): PDecimal {
    checkUnset(this._minRaw, 'p.decimal', 'min');
    return new PDecimal(this._step, n, this._maxRaw, this._range.declared, this._range.adaptive);
  }

  max(n: number): PDecimal {
    checkUnset(this._maxRaw, 'p.decimal', 'max');
    return new PDecimal(this._step, this._minRaw, n, this._range.declared, this._range.adaptive);
  }

  /**
   * Declare a prior over the bounded grid as an integer CDF over grid
   * indices: `fn(k)` is the cumulative weight below the k-th multiple of the
   * step (k = value / step), so a value's weight is `fn(k + 1) - fn(k)`.
   * Costs log2(total / weight) bits per value; zero-weight grid points cannot
   * encode.
   */
  cdf(fn: Cdf): PDecimal {
    return new PDecimal(this._step, this._minRaw, this._maxRaw, fn, this._range.adaptive);
  }

  /**
   * Declare how likely each grid point from min to max is, lowest first. Same
   * prior as `.cdf()`, given as the histogram instead of its running total.
   */
  weights(w: readonly number[]): PDecimal {
    return new PDecimal(this._step, this._minRaw, this._maxRaw, w, this._range.adaptive);
  }

  /**
   * Let the prior over the bounded range learn from the message: the declared
   * weights, or even ones when none are, are the starting point, and each grid
   * point coded counts as one observation, so a grid point that keeps recurring
   * gets cheaper as the message goes on. `window` is how many observations the
   * counts hold before they halve, so the newest weigh most (1024 when left
   * out, and raised to the number of values it counts when smaller). From its
   * second value on, the node spends one bit to stay static, or a few to name
   * the learning rate that paid off. Takes weights, not a cdf; part of the wire
   * format, like the weights.
   */
  adaptive(options?: AdaptiveOptions): PDecimal {
    return new PDecimal(
      this._step,
      this._minRaw,
      this._maxRaw,
      this._range.declared,
      options ?? {}
    );
  }

  _write(enc: Encoder, value: number): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`p.decimal expected a finite number, got ${describe(value)}`);
    }
    const k = this._multiple(value, valueSubject);

    this._range.write(enc, k, () => valueSubject(value));
  }

  _read(dec: Decoder): number {
    return this._decode(this._range.read(dec));
  }

  /**
   * The value of the k-th step multiple read off the wire, or a
   * CorruptInputError for a multiple the encoder could never have emitted:
   * one whose product with the scaled step rounds. On a fractional step that
   * is any product past 2^53, the encode-side limit. On an integer step the
   * remainder tells: with a and s the odd parts of k and the step, a·s
   * overflowing 53 bits by t bits puts s above 2^(t-1), as a is below 2^53,
   * while the rounding error stays within 2^(t-1), so a rounded product is
   * never a multiple of the step.
   */
  private _decode(k: number): number {
    const scaled = k * this._scaledStep;
    const rounded =
      this._scale === 1
        ? scaled % this._scaledStep !== 0
        : Math.abs(scaled) > Number.MAX_SAFE_INTEGER;
    if (rounded) {
      throw new CorruptInputError('Step multiple is outside the exact range of its step');
    }
    return scaled / this._scale;
  }

  /** The step multiple a bound sits on; anything else rejects the schema. */
  private _bound(bound: number, which: string): number {
    if (!Number.isFinite(bound)) {
      throw new TypeError(`p.decimal ${which} must be a finite number, got ${bound}`);
    }
    return this._multiple(bound, (v) => `p.decimal ${which} ${v}`);
  }

  /**
   * The k for which `value`, a finite number, is the k-th step multiple.
   * `subject` names the value in an error, as in `Value 0.15`.
   */
  private _multiple(value: number, subject: (value: number) => string): number {
    const scaled = Math.round(value * this._scale);
    // Beyond 2^53 a scaled value (and the decode product) stops being exact,
    // which would silently violate the bit-exact contract. An integer step
    // scales by one and needs no limit: the value is its own scaled integer.
    if (this._scale !== 1 && Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        `${subject(value)} is outside the exact range ±${Number.MAX_SAFE_INTEGER / this._scale} of step ${this._step}`
      );
    }
    // Round-tripping through the scale proves the value carries no precision
    // beyond the grid; the remainder check proves it sits on a step multiple.
    // Both are exact at any size: a remainder always is, and the quotient of
    // a double by an integer that divides it is a double.
    if (scaled / this._scale !== value || scaled % this._scaledStep !== 0) {
      throw new RangeError(`${subject(value)} is not a multiple of step ${this._step}`);
    }
    // A -0 value gives a -0 multiple, which packs as 0 on the lattice wire.
    return scaled / this._scaledStep;
  }

  /**
   * The value of the k-th step multiple, for an integer k whose product with
   * the scaled step is exact. Integer times integer, divided once
   * by the power-of-ten scale: exact at every step, so this lands on the same
   * double the caller passed in.
   */
  private _valueAt(k: number): number {
    return (k * this._scaledStep) / this._scale;
  }
}
