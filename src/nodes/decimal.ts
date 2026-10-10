import { Encoder, Decoder, CorruptInputError } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { IndexRange, checkUnset } from './lattice';
import type { Cdf, Prior } from './weights';

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
  /** Multiple-of-step bounds, rounded inward onto the grid. */
  private readonly _range: IndexRange;

  constructor(step: number, min?: number, max?: number, prior?: Prior) {
    super();
    if (!(step > 0) || step === Infinity) {
      throw new TypeError(`p.decimal step must be a positive finite number, got ${step}`);
    }

    const places = [step, min, max].map((n) => (n == null ? 0 : decimalPlaces(n)));
    if (places.some((n) => n === null)) {
      // A step or bound without a finite decimal form (1/3, Math.PI) has no
      // exact scaled-integer representation, so every value would be off-grid
      // by a rounding hair. The schema is rejected rather than guessed at.
      throw new TypeError('p.decimal step and bounds must be exact decimals (<= 15 places)');
    }
    const [stepPlaces, minPlaces, maxPlaces] = places as number[];

    this._step = step;
    this._minRaw = min ?? undefined;
    this._maxRaw = max ?? undefined;
    this._scale = 10 ** stepPlaces;
    this._scaledStep = Math.round(step * this._scale);

    // Like p.int bounds, each bound rounds inward onto the grid (ceil the min
    // multiple, floor the max multiple) so a bound off the grid never admits
    // a value beyond itself. A bound finer than the step converts at its own
    // scale, which only this conversion needs.
    const multiple = (bound: number, boundPlaces: number, which: string): number => {
      const scale = 10 ** Math.max(stepPlaces, boundPlaces);
      const scaled = Math.round(bound * scale);
      if (Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(
          `p.decimal ${which} ${bound} is outside the exact range ±${Number.MAX_SAFE_INTEGER / scale}`
        );
      }
      return scaled / Math.round(step * scale);
    };
    const kMin = min == null ? undefined : Math.ceil(multiple(min, minPlaces, 'min'));
    const kMax = max == null ? undefined : Math.floor(multiple(max, maxPlaces, 'max'));
    this._range = new IndexRange('p.decimal', kMin, kMax, prior, {
      show: (k) => String(this._valueAt(k)),
      empty: 'p.decimal range is empty: no multiple of the step lies within the requested bounds',
      // Index arithmetic (multiple - kMin) is only exact while the span of
      // multiples fits in exact integer range.
      span: 'p.decimal range spans more steps than exact arithmetic supports',
    });
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

    const scaled = Math.round(value * this._scale);
    // Beyond 2^53 the scaled integer (and the decode product) stops being
    // exact, which would silently violate the bit-exact contract.
    if (Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        `Value '${value}' is outside the exact range ±${Number.MAX_SAFE_INTEGER / this._scale}`
      );
    }
    // Round-tripping through the scale proves the value carries no precision
    // beyond the grid; the remainder check proves it sits on a step multiple.
    if (scaled / this._scale !== value || scaled % this._scaledStep !== 0) {
      throw new RangeError(`Value '${value}' is not a multiple of step ${this._step}`);
    }

    // `+ 0` normalizes the -0 quotient of a negative zero input.
    const k = scaled / this._scaledStep + 0;

    this._range.write(enc, k, () => `Value '${value}'`);
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

  /**
   * The value of the k-th step multiple. Integer times integer, divided once
   * by the power-of-ten scale: exact at every step, so this lands on the same
   * double the caller passed in.
   */
  private _valueAt(k: number): number {
    return (k * this._scaledStep) / this._scale;
  }
}
