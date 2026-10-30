import { Encoder, Decoder } from '../packer';
import { describe } from './path';
import type { Kind } from './guards';
import { IndexRange, checkUnset } from './lattice';
import type { Cdf, Prior } from './weights';
import type { LearningOptions } from './adaptive';
import { learningOf, learns, MethodNode, type MethodSet } from './methods';
import { checkCompress, resolve } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import { STRUCT, type CompressOptions } from '../predictor/types';

const INT_MARKERS: ReadonlySet<number> = new Set([STRUCT.INT]);

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
export class PInt extends MethodNode<number> {
  readonly _kinds: readonly Kind[] = ['number'];

  /** The value IS its own index on the lattice. */
  private readonly _range: IndexRange;
  /** The methods the node has, declared or open. */
  readonly _methods: MethodSet;
  declare readonly _radix?: number;
  /** The options `.compress()` set, which hand the values to the predictor. */
  readonly _compress?: CompressOptions;

  constructor(
    min?: number,
    max?: number,
    prior?: Prior,
    methods: MethodSet = {},
    compress?: CompressOptions
  ) {
    super();
    this._compress = compress;
    this._range = new IndexRange(
      'p.int',
      min,
      max,
      prior,
      learningOf(methods),
      String,
      compress === undefined
        ? undefined
        : { path: this, options: resolve(compress, loadedPriors.json, 'p.int') }
    );
    this._methods = methods;
    this._radix = this._range.radix;
    this._fromDigit = this._range.fromDigit;
    const toDigit = this._range.toDigit;
    if (toDigit !== undefined) {
      this._toDigit = (value) => toDigit(checkInteger(value), () => `Value ${value}`);
    }
  }

  min(n: number): PInt {
    checkUnset(this._range.lo, 'p.int', 'min');
    const { hi, declared } = this._range;
    return this._with(n, hi, declared);
  }

  max(n: number): PInt {
    checkUnset(this._range.hi, 'p.int', 'max');
    const { lo, declared } = this._range;
    return this._with(lo, n, declared);
  }

  /**
   * Declare a prior over the bounded range as an integer CDF. A value's cost
   * is log2(total / weight) bits — fractional, exact. A zero-weight value
   * cannot encode; everything else just gets cheaper or dearer. Under
   * `.compress()` it is the prior of values the node has not seen.
   */
  cdf(fn: Cdf): PInt {
    checkUnset(this._range.declared, 'p.int', 'prior');
    return this._with(this._range.lo, this._range.hi, fn);
  }

  /**
   * Declare how likely each value in the bounded range is, lowest first. Same
   * prior as `.cdf()`, given as the histogram instead of its running total.
   */
  weights(w: readonly number[]): PInt {
    checkUnset(this._range.declared, 'p.int', 'prior');
    return this._with(this._range.lo, this._range.hi, w);
  }

  /**
   * Let the prior over the bounded range learn from the message: the declared
   * weights, or even ones when none are, are the starting point, and each
   * value coded counts as one observation, so a value that keeps recurring
   * gets cheaper as the message goes on. From its second value on, the node
   * spends one bit to stay static, or a few to name the learning rate that
   * paid off. Takes weights, not a cdf; part of the wire format, like the
   * weights. A range unbounded or wider than 65536 values learns on the
   * magnitude scale instead: distances from the min, else the max, else 0, by
   * bit-length class. `window` is how many observations a table's counts
   * hold before they halve (1024 when left out), and `separate` keeps its
   * tables from starting where other nodes of its kind and window got to.
   * Not with `.compress()`.
   */
  learn(options?: LearningOptions): PInt {
    if (this._compress !== undefined) {
      throw new TypeError('p.int learn and compress cannot both be set');
    }
    return this._declare('learn', 'p.int', options);
  }

  /**
   * Code the values through the similarity predictor: each is predicted from
   * the node's past values plus a learned step, the same values exactly,
   * the numbers coded earlier in the same object, and a prior over
   * magnitudes. The bounds still hold, and a declared prior prices the values
   * the node has not seen. Not with `.learn()`. Set once.
   */
  compress(options?: CompressOptions): PInt {
    if (this._compress !== undefined) {
      throw new TypeError('p.int compress is already set');
    }
    if (learns(this._methods)) {
      throw new TypeError('p.int learn and compress cannot both be set');
    }
    const { lo, hi, declared } = this._range;
    return new PInt(lo, hi, declared, this._methods, checkCompress(options, 'p.int'));
  }

  _adapted(options: CompressOptions): PInt {
    return this._compress !== undefined || learns(this._methods) ? this : this.compress(options);
  }

  _marker(): number {
    return STRUCT.INT;
  }

  _markers(): ReadonlySet<number> {
    return INT_MARKERS;
  }

  /** This node with `methods` in place of its own. */
  _withMethods(methods: MethodSet): PInt {
    const { lo, hi, declared } = this._range;
    return new PInt(lo, hi, declared, methods, this._compress);
  }

  /** This node with these bounds and prior, keeping its methods and compress options. */
  private _with(lo: number | undefined, hi: number | undefined, prior: Prior | undefined): PInt {
    return new PInt(lo, hi, prior, this._methods, this._compress);
  }

  _write(enc: Encoder, value: number): void {
    // -0 packs as 0 on the lattice wire.
    this._range.writeValue(enc, checkInteger(value), () => `Value ${value}`);
  }

  _read(dec: Decoder): number {
    return this._range.readValue(dec);
  }
}
