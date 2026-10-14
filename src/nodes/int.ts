import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { describe } from './path';
import type { Kind } from './guards';
import { IndexRange, checkUnset } from './lattice';
import type { Cdf, Prior } from './weights';
import type { AdaptiveOptions } from './adaptive';

/** Integer (strict: non-integers throw). `p.int`. */
export class PInt extends PNode<number> {
  readonly _kinds: readonly Kind[] = ['number'];

  /** The value IS its own index on the lattice. */
  private readonly _range: IndexRange;
  declare readonly _radix?: number;

  constructor(min?: number, max?: number, prior?: Prior, adaptive?: AdaptiveOptions) {
    super();
    this._range = new IndexRange('p.int', min, max, prior, adaptive);
    this._radix = this._range.radix;
    this._fromDigit = this._range.fromDigit;
  }

  min(n: number): PInt {
    checkUnset(this._range.lo, 'p.int', 'min');
    return new PInt(n, this._range.hi, this._range.declared, this._range.adaptive);
  }

  max(n: number): PInt {
    checkUnset(this._range.hi, 'p.int', 'max');
    return new PInt(this._range.lo, n, this._range.declared, this._range.adaptive);
  }

  /**
   * Declare a prior over the bounded range as an integer CDF. A value's cost
   * is log2(total / weight) bits — fractional, exact. A zero-weight value
   * cannot encode; everything else just gets cheaper or dearer.
   */
  cdf(fn: Cdf): PInt {
    return new PInt(this._range.lo, this._range.hi, fn, this._range.adaptive);
  }

  /**
   * Declare how likely each value in the bounded range is, lowest first. Same
   * prior as `.cdf()`, given as the histogram instead of its running total.
   */
  weights(w: readonly number[]): PInt {
    return new PInt(this._range.lo, this._range.hi, w, this._range.adaptive);
  }

  /**
   * Let the prior over the bounded range learn from the message: the declared
   * weights, or even ones when none are, are the starting point, and each value
   * coded counts as one observation, so a value that keeps recurring gets
   * cheaper as the message goes on. `window` is how many observations the
   * counts hold before they halve, so the newest weigh most (1024 when left
   * out, and raised to the number of values it counts when smaller). From its
   * second value on, the node spends one bit to stay static, or a few to name
   * the learning rate that paid off. Takes weights, not a cdf; part of the wire
   * format, like the weights.
   */
  adaptive(options?: AdaptiveOptions): PInt {
    const { lo, hi, declared } = this._range;
    return new PInt(lo, hi, declared, options ?? {});
  }

  _write(enc: Encoder, value: number): void {
    // Strict, like every other node: a fractional value is off the integer
    // lattice and throws — truncating it away would silently lose data.
    if (!Number.isInteger(value)) {
      throw new TypeError(`p.int expected an integer, got ${describe(value)}`);
    }
    // -0 packs as 0 on the lattice wire.
    this._range.write(enc, value, () => `Value ${value}`);
  }

  _read(dec: Decoder): number {
    return this._range.read(dec);
  }
}
