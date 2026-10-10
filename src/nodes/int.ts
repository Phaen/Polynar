import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { IndexRange, checkUnset } from './lattice';
import type { Cdf, Prior } from './weights';

/** Integer (strict: non-integers throw). `p.int`. */
export class PInt extends PNode<number> {
  readonly _kinds: readonly Kind[] = ['number'];

  /** The value IS its own index on the lattice. */
  private readonly _range: IndexRange;

  constructor(min?: number, max?: number, prior?: Prior) {
    super();
    // Each bound rounds inward (ceil the min, floor the max) so a fractional
    // bound never widens the declared range: .min(10.9) admits 11 and up.
    const lo = min == null ? undefined : Math.ceil(min);
    const hi = max == null ? undefined : Math.floor(max);
    if (lo !== undefined && !Number.isFinite(lo)) {
      throw new TypeError(`p.int min must be a finite number, got ${lo}`);
    }
    if (hi !== undefined && !Number.isFinite(hi)) {
      throw new TypeError(`p.int max must be a finite number, got ${hi}`);
    }
    // After inward rounding a fractional band can invert (.min(2.1).max(2.9))
    // when it contains no integer. It is rejected because swapping the
    // bounds would give a WIDER range that admits values below the declared
    // minimum.
    this._range = new IndexRange('p.int', lo, hi, prior, {
      empty: `p.int range is empty: no integer lies within the requested bounds (rounded to [${lo}, ${hi}])`,
    });
  }

  min(n: number): PInt {
    checkUnset(this._range.lo, 'p.int', 'min');
    return new PInt(n, this._range.hi, this._range.prior?.declared);
  }

  max(n: number): PInt {
    checkUnset(this._range.hi, 'p.int', 'max');
    return new PInt(this._range.lo, n, this._range.prior?.declared);
  }

  /**
   * Declare a prior over the bounded range as an integer CDF. A value's cost
   * is log2(total / weight) bits — fractional, exact. A zero-weight value
   * cannot encode; everything else just gets cheaper or dearer.
   */
  cdf(fn: Cdf): PInt {
    return new PInt(this._range.lo, this._range.hi, fn);
  }

  /**
   * Declare how likely each value in the bounded range is, lowest first. Same
   * prior as `.cdf()`, given as the histogram instead of its running total.
   */
  weights(w: readonly number[]): PInt {
    return new PInt(this._range.lo, this._range.hi, w);
  }

  _write(enc: Encoder, value: number): void {
    // Strict, like every other node: a fractional value is off the integer
    // lattice and throws — truncating it away would silently lose data.
    if (!Number.isInteger(value)) {
      throw new TypeError(`p.int expected an integer, got ${String(value)}`);
    }
    // `+ 0` normalizes -0 to 0 so the sign bit never records a negative zero.
    const v = value + 0;

    this._range.write(enc, v, () => `Value '${v}'`);
  }

  _read(dec: Decoder): number {
    return this._range.read(dec);
  }
}
