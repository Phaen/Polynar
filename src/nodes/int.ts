import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { writeIndex, readIndex } from './lattice';
import { RangePrior, priorKind, type Cdf, type Prior } from './weights';

/** Integer (strict: non-integers throw). `p.int`. */
export class PInt extends PNode<number> {
  readonly _kinds: readonly Kind[] = ['number'];

  private readonly _min?: number;
  private readonly _max?: number;
  /** A prior over the bounded range; undefined means uniform. */
  private readonly _prior?: RangePrior;

  constructor(min?: number, max?: number, prior?: Prior) {
    super();
    // Each bound rounds inward (ceil the min, floor the max) so a fractional
    // bound never widens the declared range: .min(10.9) admits 11 and up.
    this._min = min == null ? undefined : Math.ceil(min);
    this._max = max == null ? undefined : Math.floor(max);
    if (this._min !== undefined && !Number.isFinite(this._min)) {
      throw new TypeError(`p.int min must be a finite number, got ${this._min}`);
    }
    if (this._max !== undefined && !Number.isFinite(this._max)) {
      throw new TypeError(`p.int max must be a finite number, got ${this._max}`);
    }
    // After inward rounding a fractional band can invert (.min(2.1).max(2.9))
    // when it contains no integer. It is rejected because swapping the
    // bounds would give a WIDER range that admits values below the declared
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
      throw new RangeError(
        `p.int range [${this._min}, ${this._max}] is wider than exact integer arithmetic supports`
      );
    }

    if (prior !== undefined) {
      if (this._min === undefined || this._max === undefined) {
        throw new TypeError(`p.int ${priorKind(prior)} requires both bounds`);
      }
      this._prior = new RangePrior(prior, this._min, this._max, 'p.int');
    }
  }

  min(n: number): PInt {
    return new PInt(n, this._max, this._prior?.declared);
  }

  max(n: number): PInt {
    return new PInt(this._min, n, this._prior?.declared);
  }

  /**
   * Declare a prior over the bounded range as an integer CDF. A value's cost
   * is log2(total / weight) bits — fractional, exact. A zero-weight value
   * cannot encode; everything else just gets cheaper or dearer.
   */
  cdf(fn: Cdf): PInt {
    return new PInt(this._min, this._max, fn);
  }

  /**
   * Declare how likely each value in the bounded range is, lowest first. Same
   * prior as `.cdf()`, given as the histogram instead of its running total.
   */
  weights(w: readonly number[]): PInt {
    return new PInt(this._min, this._max, w);
  }

  _write(enc: Encoder, value: number): void {
    // Strict, like every other node: a fractional value is off the integer
    // lattice and throws — truncating it away would silently lose data.
    if (!Number.isInteger(value)) {
      throw new TypeError(`p.int expected an integer, got ${String(value)}`);
    }
    // `+ 0` normalizes -0 to 0 so the sign bit never records a negative zero.
    const v = value + 0;

    if (this._min !== undefined && v < this._min) {
      throw new RangeError(`Value '${v}' is below the minimum ${this._min}`);
    }
    if (this._max !== undefined && v > this._max) {
      throw new RangeError(`Value '${v}' is above the maximum ${this._max}`);
    }

    if (this._prior === undefined) {
      writeIndex(enc, v, this._min, this._max);
      return;
    }
    this._prior.write(enc, v, () => `Value '${v}'`);
  }

  _read(dec: Decoder): number {
    if (this._prior === undefined) {
      return readIndex(dec, this._min, this._max);
    }
    return this._prior.read(dec);
  }
}
