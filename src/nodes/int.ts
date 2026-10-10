import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { describe } from './path';
import type { Kind } from './guards';
import { IndexRange, checkUnset } from './lattice';
import type { Cdf, Prior } from './weights';

/** Bounds are integers like the values they admit; NaN and Infinity are not. */
const checkBound = (bound: number | undefined, which: string): void => {
  if (bound !== undefined && !Number.isInteger(bound)) {
    throw new TypeError(`p.int ${which} must be an integer, got ${bound}`);
  }
};

/** Integer (strict: non-integers throw). `p.int`. */
export class PInt extends PNode<number> {
  readonly _kinds: readonly Kind[] = ['number'];

  /** The value IS its own index on the lattice. */
  private readonly _range: IndexRange;

  constructor(min?: number, max?: number, prior?: Prior) {
    super();
    checkBound(min, 'min');
    checkBound(max, 'max');
    this._range = new IndexRange('p.int', min, max, prior);
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
      throw new TypeError(`p.int expected an integer, got ${describe(value)}`);
    }
    // `+ 0` normalizes -0 to 0 so the sign bit never records a negative zero.
    const v = value + 0;

    this._range.write(enc, v, () => `Value ${v}`);
  }

  _read(dec: Decoder): number {
    return this._range.read(dec);
  }
}
