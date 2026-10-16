import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import type { LearningOptions } from './adaptive';
import { members, type MemberPrior, type Members } from './members';
import { MethodNode, PRIOR_METHODS, learningOf, type MethodSet } from './methods';

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

  readonly _methodNames = PRIOR_METHODS;

  /** The prior as declared, `[present, absent]`, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  /** Member 0 is present, as the weights list it first. */
  private readonly _members: Members;

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
  }

  get _exact(): boolean {
    return this.inner._exact;
  }

  _takesUndefined(): boolean {
    return true;
  }

  /**
   * When the prior learns, the prior of the presence flag in `contexts`
   * contexts: the declared weights in each, learning as declared.
   */
  _presence(contexts: number): MemberPrior | undefined {
    const learn = learningOf(this._methods);
    if (learn === undefined) {
      return undefined;
    }
    const weights = this._prior?.weights ?? [1, 1];
    return { rows: new Array<readonly number[]>(contexts).fill(weights), learn };
  }

  /**
   * Declare how likely the value is to be there, as `[present, absent]`
   * weights: a 99%-present value costs ~0.015 bits instead of a full bit.
   * A prior, not a constraint, and part of the wire format.
   */
  weights(w: readonly [number, number]): POptional<TOut> {
    return new POptional<TOut>(this.inner, { ...this._prior, weights: w }, this._methods);
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are where it starts, and each value or absence coded counts
   * as one observation, so whichever keeps recurring gets cheaper as the
   * message goes on. From its second value on, the node spends one bit to stay
   * static, or a few to name the learning rate that paid off. Part of the wire
   * format, like the weights.
   */
  learn(): POptional<TOut> {
    return this._declare('learn', 'p.optional');
  }

  /**
   * What the node's learning goes by: `window` is how many observations the
   * counts hold before they halve, so the newest weigh most (1024 when left
   * out, and raised to the number of values counted when smaller), and
   * `separate` keeps it from starting where other nodes of its kind and window
   * got to. Set once; it applies once something learns.
   */
  learning(options: LearningOptions): POptional<TOut> {
    return this._learning(options, 'p.optional');
  }

  /** Learn with every method the node has, here `.learn()`, under `options` as `.learning()` takes them. */
  adaptive(options?: LearningOptions): POptional<TOut> {
    return this._adapt(options, 'p.optional');
  }

  _withMethods(methods: MethodSet): POptional<TOut> {
    return new POptional<TOut>(this.inner, this._prior, methods);
  }

  _write(enc: Encoder, value: TOut | undefined): void {
    this._members.write(enc, value === undefined ? 1 : 0);
    if (value !== undefined) {
      this.inner._write(enc, value);
    }
  }

  _read(dec: Decoder): TOut | undefined {
    if (this._members.read(dec) === 1) {
      return undefined;
    }
    return this.inner._read(dec);
  }
}
