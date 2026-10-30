import { Encoder, Decoder } from '../packer';
import { resolve } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import type { MarkerPrior } from '../predictor/session';
import { STRUCT, type AdaptiveOptions, type Resolved } from '../predictor/types';
import { PNode, adapt } from './base';
import type { Kind } from './guards';
import type { LearningOptions } from './adaptive';
import { checkUnset } from './lattice';
import { markerPrior, ownMarker, readMarker, readOwnMarker, writeMarker } from './markers';
import { members, type MemberPrior, type Members } from './members';
import { MethodNode, learningOf, type MethodSet } from './methods';

const PRESENCE_MARKERS: ReadonlySet<number> = new Set([STRUCT.KEY, STRUCT.NOKEY]);

/**
 * A value or `undefined`, at the cost of one presence bit. `p.optional`.
 * Only `undefined` means absent; `null` reaches the inner node.
 */
export class POptional<TOut> extends MethodNode<TOut | undefined> {
  /**
   * The inner node's kinds plus `'undefined'`, or undeclared when the inner
   * node is, so an optional node is a union member whenever its inner node is.
   */
  declare readonly _kinds?: readonly Kind[];

  /** The prior as declared, `[present, absent]`, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  /** Member 0 is present, as the weights list it first. */
  private readonly _members: Members;
  readonly _adaptive?: AdaptiveOptions;
  /** Under `.adaptive()`: the options the presence symbol codes under. */
  private readonly _resolved?: Resolved;

  constructor(
    readonly inner: PNode<TOut>,
    prior?: MemberPrior,
    readonly _methods: MethodSet = {}
  ) {
    super();
    if (inner._kinds !== undefined) {
      this._kinds = [...new Set<Kind>([...inner._kinds, 'undefined'])];
    }
    this._prior = prior;
    this._members = members(2, { ...prior, learn: learningOf(_methods) }, 'p.optional');
    this._adaptive = _methods.adaptive;
    if (this._adaptive !== undefined) {
      this._resolved = resolve(this._adaptive, loadedPriors.json, 'p.optional');
    }
  }

  get _holdsAdaptive(): boolean {
    return this._adaptive !== undefined || this.inner._holdsAdaptive;
  }

  _takesUndefined(): boolean {
    return true;
  }

  /**
   * Declare how likely the value is to be there, as `[present, absent]`
   * weights: a 99%-present value costs ~0.015 bits instead of a full bit.
   * A prior, not a constraint, and part of the wire format.
   */
  weights(w: readonly [number, number]): POptional<TOut> {
    checkUnset(this._prior?.weights, 'p.optional', 'weights');
    return new POptional<TOut>(this.inner, { ...this._prior, weights: w }, this._methods);
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are where it starts, and each value or absence coded counts
   * as one observation, so whichever keeps recurring gets cheaper as the
   * message goes on. From its second value on, the node spends one bit to stay
   * static, or a few to name the learning rate that paid off. `window` is how
   * many observations the counts hold before they halve, so the newest weigh
   * most (1024 when left out, and raised to the number of values counted when
   * smaller), and `separate` keeps it from starting where other nodes of its
   * kind and window got to. Part of the wire format, like the weights. Not
   * with `.adaptive()`.
   */
  learn(options?: LearningOptions): POptional<TOut> {
    return this._declare('learn', 'p.optional', options);
  }

  /**
   * Code whether the value is there through the similarity predictor, as a
   * symbol of the structure around it with the weights as its prior counts,
   * and the inner node as under its own `.adaptive(options)` unless it has
   * `.adaptive()` or `.learn()` already. Not with `.learn()`. Set once.
   */
  adaptive(options?: AdaptiveOptions): POptional<TOut> {
    return this._sugar(options, 'p.optional');
  }

  _adapted(options: AdaptiveOptions, memo: Map<PNode<any>, PNode<any>>): POptional<TOut> {
    if (this._keeps()) {
      return this;
    }
    const inner = adapt(this.inner, options, memo);
    return new POptional<TOut>(inner, this._prior, { ...this._methods, adaptive: options });
  }

  _withMethods(methods: MethodSet): POptional<TOut> {
    return new POptional<TOut>(this.inner, this._prior, methods);
  }

  _marker(value: unknown): number {
    return value === undefined ? STRUCT.NOKEY : STRUCT.KEY;
  }

  _markers(): ReadonlySet<number> {
    return PRESENCE_MARKERS;
  }

  _markerPrior(): MarkerPrior | undefined {
    return this._adaptive === undefined
      ? undefined
      : markerPrior(this, this._prior?.weights, [new Set([STRUCT.KEY]), new Set([STRUCT.NOKEY])]);
  }

  _write(enc: Encoder, value: TOut | undefined): void {
    const o = this._resolved;
    if (o === undefined) {
      this._members.write(enc, value === undefined ? 1 : 0);
      if (value !== undefined) {
        this.inner._write(enc, value);
      }
      return;
    }
    ownMarker(enc, this, o, this._marker(value));
    if (value !== undefined) {
      writeMarker(enc, this, o, this.inner, this.inner._marker(value));
      this.inner._write(enc, value);
    }
  }

  _read(dec: Decoder): TOut | undefined {
    const o = this._resolved;
    if (o === undefined) {
      if (this._members.read(dec) === 1) {
        return undefined;
      }
      return this.inner._read(dec);
    }
    if (readOwnMarker(dec, this, o) !== STRUCT.KEY) {
      return undefined;
    }
    readMarker(dec, this, o, this.inner);
    return this.inner._read(dec);
  }
}
