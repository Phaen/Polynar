import { Encoder, Decoder, CorruptInputError } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { IndexRange, checkUnset } from './lattice';
import type { Cdf, Prior } from './weights';

const valueSubject = (value: number): string => `Value '${value}'`;

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
  readonly _kinds: readonly Kind[] = ['number'];

  private readonly _step: number;
  private readonly _minRaw?: number;
  private readonly _maxRaw?: number;
  /** 10^places that makes the step an integer. */
  private readonly _scale: number;
  private readonly _scaledStep: number;
  /** Indexed by step multiple: the k-th multiple of the step is index k. */
  private readonly _range: IndexRange;

  constructor(step: number, min?: number, max?: number, prior?: Prior) {
    super();
    if (!(step > 0) || step === Infinity) {
      throw new TypeError(`p.decimal step must be a positive finite number, got ${step}`);
    }

    const stepPlaces = decimalPlaces(step);
    if (stepPlaces === null) {
      // A step without a finite decimal form (1/3, Math.PI) has no exact
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
    this._range = new IndexRange('p.decimal', kMin, kMax, prior, (k) => String(this._valueAt(k)));
  }

  min(n: number): PDecimal {
    checkUnset(this._minRaw, 'p.decimal', 'min');
    return new PDecimal(this._step, n, this._maxRaw, this._range.prior?.declared);
  }

  max(n: number): PDecimal {
    checkUnset(this._maxRaw, 'p.decimal', 'max');
    return new PDecimal(this._step, this._minRaw, n, this._range.prior?.declared);
  }

  /**
   * Declare a prior over the bounded grid as an integer CDF over grid
   * indices: `fn(k)` is the cumulative weight below the k-th multiple of the
   * step (k = value / step), so a value's weight is `fn(k + 1) - fn(k)`.
   * Costs log2(total / weight) bits per value; zero-weight grid points cannot
   * encode.
   */
  cdf(fn: Cdf): PDecimal {
    return new PDecimal(this._step, this._minRaw, this._maxRaw, fn);
  }

  /**
   * Declare how likely each grid point from min to max is, lowest first. Same
   * prior as `.cdf()`, given as the histogram instead of its running total.
   */
  weights(w: readonly number[]): PDecimal {
    return new PDecimal(this._step, this._minRaw, this._maxRaw, w);
  }

  _write(enc: Encoder, value: number): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`p.decimal expected a finite number, got ${String(value)}`);
    }
    const k = this._multiple(value, valueSubject);

    this._range.write(enc, k, () => valueSubject(value));
  }

  _read(dec: Decoder): number {
    const k = this._range.read(dec);
    // Counterpart of the encode-side exactness guard: a product past 2^53 rounds,
    // and the encoder could never have emitted it.
    if (Math.abs(k * this._scaledStep) > Number.MAX_SAFE_INTEGER) {
      throw new CorruptInputError('Step multiple is outside the exact range of its step');
    }
    return this._valueAt(k);
  }

  /** The step multiple a bound sits on; anything else rejects the schema. */
  private _bound(bound: number, which: string): number {
    if (!Number.isFinite(bound)) {
      throw new TypeError(`p.decimal ${which} must be a finite number, got ${bound}`);
    }
    return this._multiple(bound, (v) => `p.decimal ${which} ${v}`);
  }

  /**
   * The k for which `value` is the k-th step multiple. `subject` names the
   * value in an error, as in `Value '0.15'`.
   */
  private _multiple(value: number, subject: (value: number) => string): number {
    const scaled = Math.round(value * this._scale);
    // Beyond 2^53 the scaled integer (and the decode product) stops being
    // exact, which would silently violate the bit-exact contract.
    if (Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        `${subject(value)} is outside the exact range ±${Number.MAX_SAFE_INTEGER / this._scale}`
      );
    }
    // Round-tripping through the scale proves the value carries no precision
    // beyond the grid; the remainder check proves it sits on a step multiple.
    if (scaled / this._scale !== value || scaled % this._scaledStep !== 0) {
      throw new RangeError(`${subject(value)} is not a multiple of step ${this._step}`);
    }
    // `+ 0` normalizes the -0 quotient of a negative zero input.
    return scaled / this._scaledStep + 0;
  }

  /**
   * The value of the k-th step multiple. Integer times integer, divided once
   * by the power-of-ten scale: exact at every step, so this lands on the same
   * double the caller passed in.
   */
  private _valueAt(k: number): number {
    return (k * this._scaledStep) / this._scale;
  }
}
