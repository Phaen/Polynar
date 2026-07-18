import { Encoder, Decoder, CorruptInputError } from '../packer';
import { PNode } from './base';
import { writeIndex, readIndex } from './lattice';
import { validateCdf, cdfBucket, locateCdf, type Cdf } from './weights';

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
  /** The user's value-domain cdf and its multiple-domain adapter. */
  private readonly _cdf?: Cdf;
  private readonly _kCdf?: Cdf;
  private readonly _total?: number;

  constructor(step: number, min?: number, max?: number, cdf?: Cdf) {
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

    if (cdf !== undefined) {
      if (this._kMin === undefined || this._kMax === undefined) {
        throw new TypeError('p.decimal cdf requires both bounds');
      }
      // The adapter hands the user exact grid values while the packer sees
      // plain multiple indices.
      const rebased = validateCdf(
        (k: number) => cdf((k * this._scaledStep) / this._scale),
        this._kMin,
        this._kMax,
        'p.decimal'
      );
      this._kCdf = rebased.cdf;
      this._total = rebased.total;
      this._cdf = cdf;
    }
  }

  min(n: number): PDecimal {
    return new PDecimal(this._step, n, this._maxRaw, this._cdf);
  }

  max(n: number): PDecimal {
    return new PDecimal(this._step, this._minRaw, n, this._cdf);
  }

  /**
   * Declare a prior over the bounded grid as an integer CDF over VALUES:
   * `fn(v)` is the cumulative weight of grid points below `v`, evaluated at
   * the exact doubles the grid holds. Costs log2(total / weight) bits per
   * value; zero-weight grid points cannot encode.
   */
  cdf(fn: Cdf): PDecimal {
    return new PDecimal(this._step, this._minRaw, this._maxRaw, fn);
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

    if (this._kCdf === undefined) {
      writeIndex(enc, k, this._kMin, this._kMax);
      return;
    }
    const [cum, freq] = cdfBucket(this._kCdf, k, 'p.decimal');
    enc.composeWeighted(cum, freq, this._total!);
  }

  _read(dec: Decoder): number {
    const k =
      this._kCdf === undefined
        ? readIndex(dec, this._kMin, this._kMax)
        : dec.parseWeighted(this._total!, locateCdf(this._kCdf, this._kMin!, this._kMax!));
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
