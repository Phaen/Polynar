import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { describe } from './path';
import type { Kind } from './guards';
import { IndexMethods, IndexRange, checkUnset } from './lattice';
import type { Cdf, Prior } from './weights';
import type { AdaptiveOptions } from './adaptive';
import { withMethod, type Spelling } from './methods';

/**
 * `value`, refused unless it is an integer. Strict, like every other node: a
 * fractional value is off the integer lattice and throws — truncating it
 * away would silently lose data.
 */
const checkInteger = (value: number): number => {
  if (!Number.isInteger(value)) {
    throw new TypeError(`p.int expected an integer, got ${describe(value)}`);
  }
  return value;
};

/** Integer (strict: non-integers throw). `p.int`. */
export class PInt extends PNode<number> {
  readonly _kinds: readonly Kind[] = ['number'];

  /** The value IS its own index on the lattice. */
  private readonly _range: IndexRange;
  private readonly _spelling: Spelling;
  private readonly _methods: IndexMethods;
  declare readonly _radix?: number;

  constructor(
    min?: number,
    max?: number,
    prior?: Prior,
    adaptive?: AdaptiveOptions,
    spelling: Spelling = {}
  ) {
    super();
    this._range = new IndexRange('p.int', min, max, prior, adaptive);
    this._spelling = spelling;
    this._methods = new IndexMethods(this._range, spelling, 'p.int');
    if (this._methods.plain) {
      this._radix = this._range.radix;
      this._fromDigit = this._range.fromDigit;
      const toDigit = this._range.toDigit;
      if (toDigit !== undefined) {
        this._toDigit = (value) => toDigit(checkInteger(value), () => `Value ${value}`);
      }
    }
  }

  min(n: number): PInt {
    checkUnset(this._range.lo, 'p.int', 'min');
    const { hi, declared, adaptive } = this._range;
    return new PInt(n, hi, declared, adaptive, this._spelling);
  }

  max(n: number): PInt {
    checkUnset(this._range.hi, 'p.int', 'max');
    const { lo, declared, adaptive } = this._range;
    return new PInt(lo, n, declared, adaptive, this._spelling);
  }

  /**
   * Declare a prior over the bounded range as an integer CDF. A value's cost
   * is log2(total / weight) bits — fractional, exact. A zero-weight value
   * cannot encode; everything else just gets cheaper or dearer.
   */
  cdf(fn: Cdf): PInt {
    return new PInt(this._range.lo, this._range.hi, fn, this._range.adaptive, this._spelling);
  }

  /**
   * Declare how likely each value in the bounded range is, lowest first. Same
   * prior as `.cdf()`, given as the histogram instead of its running total.
   */
  weights(w: readonly number[]): PInt {
    return new PInt(this._range.lo, this._range.hi, w, this._range.adaptive, this._spelling);
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
   * format, like the weights. A range unbounded or wider than 65536 values
   * learns on the magnitude scale instead: distances from the min, else the
   * max, else 0, by bit-length class. From the second value on, unless
   * `.delta()` is declared, each value also spends a learned mode symbol
   * naming whether it is spelled plainly or as its difference from the
   * previous value, whichever the encoder prices cheaper.
   * Unless `.recall()` is declared, a value the node already wrote may
   * also be recalled as under it, at learned odds, whenever that costs
   * less than spelling it.
   */
  adaptive(options?: AdaptiveOptions): PInt {
    const { lo, hi, declared } = this._range;
    return new PInt(lo, hi, declared, options ?? {}, this._spelling);
  }

  /**
   * Spell every value after the node's first in the message as its
   * difference from the previous one: its side, unless the bounds rule one
   * out, the bit-length class of its size among the classes the bounds
   * reach, equally likely or learned under `.adaptive()`, then the low
   * bits. Steady ids and counters cost a few bits each, bounded or not.
   * The node's first value costs its plain spelling. Takes no weights or
   * cdf; values must lie within 2^53 - 1 of the min, else the max, else 0.
   */
  delta(): PInt {
    const { lo, hi, declared, adaptive } = this._range;
    return new PInt(lo, hi, declared, adaptive, withMethod(this._spelling, 'delta', 'p.int'));
  }

  /**
   * Spell a value this node already wrote in the message by its place
   * among the distinct values it wrote, and a new one as an escape and then
   * as the node otherwise spells it: with n values seen, a repeat costs
   * log2(n + 1) bits, or under `.adaptive()` less the more often it
   * recurs. The message's first value costs nothing extra.
   */
  recall(): PInt {
    const { lo, hi, declared, adaptive } = this._range;
    return new PInt(lo, hi, declared, adaptive, withMethod(this._spelling, 'recall', 'p.int'));
  }

  _write(enc: Encoder, value: number): void {
    // -0 packs as 0 on the lattice wire.
    this._methods.write(enc, checkInteger(value), () => `Value ${value}`);
  }

  _read(dec: Decoder): number {
    return this._methods.read(dec);
  }
}
