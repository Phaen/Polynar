import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { writeIndex, readIndex } from './lattice';
import { validateCdf, cdfBucket, locateCdf, type Cdf } from './weights';

/** Integer (strict: non-integers throw). `p.int`. */
export class PInt extends PNode<number> {
  private readonly _min?: number;
  private readonly _max?: number;
  private readonly _cdf?: Cdf;
  /** cdf(max + 1), the weight of the whole range. */
  private readonly _total?: number;

  constructor(min?: number, max?: number, cdf?: Cdf) {
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

    if (cdf !== undefined) {
      if (this._min === undefined || this._max === undefined) {
        throw new TypeError('p.int cdf requires both bounds');
      }
      const rebased = validateCdf(cdf, this._min, this._max, 'p.int');
      this._cdf = rebased.cdf;
      this._total = rebased.total;
    }
  }

  min(n: number): PInt {
    return new PInt(n, this._max, this._cdf);
  }

  max(n: number): PInt {
    return new PInt(this._min, n, this._cdf);
  }

  /**
   * Declare a prior over the bounded range as an integer CDF. A value's cost
   * is log2(total / weight) bits — fractional, exact. A zero-weight value
   * cannot encode; everything else just gets cheaper or dearer.
   */
  cdf(fn: Cdf): PInt {
    return new PInt(this._min, this._max, fn);
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

    if (this._cdf === undefined) {
      writeIndex(enc, v, this._min, this._max);
      return;
    }
    const [cum, freq] = cdfBucket(this._cdf, v, 'p.int');
    enc.composeWeighted(cum, freq, this._total!);
  }

  _read(dec: Decoder): number {
    if (this._cdf === undefined) {
      return readIndex(dec, this._min, this._max);
    }
    return dec.parseWeighted(this._total!, locateCdf(this._cdf, this._min!, this._max!));
  }
}
