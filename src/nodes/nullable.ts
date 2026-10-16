import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import type { LearningOptions } from './adaptive';
import { members, type MemberPrior, type Members } from './members';
import { MethodNode, PRIOR_METHODS, learningOf, type MethodSet } from './methods';

/**
 * A value or `null`. `p.nullable`. Writes the same bits as
 * `p.union([node, p.null()])`, but tells `null` apart by value instead of by
 * kind, so the inner node needs no kinds and can be `p.lazy`.
 */
export class PNullable<T> extends MethodNode<T | null> {
  /**
   * The inner node's kinds plus `'null'`, or undeclared when the inner node's
   * are, so a nullable node is a union member whenever its inner node is.
   */
  declare readonly _kinds?: readonly Kind[];

  /** The prior as declared, `[value, null]`, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  readonly _methodNames = PRIOR_METHODS;
  /** Member 0 is a value, member 1 null. */
  private readonly _members: Members;

  constructor(
    readonly inner: PNode<T>,
    prior?: MemberPrior,
    readonly _methods: MethodSet = {}
  ) {
    super();
    if (inner._kinds !== undefined) {
      this._kinds = [...new Set<Kind>([...inner._kinds, 'null'])];
    }
    this._prior = prior;
    this._members = members(2, { ...prior, learn: learningOf(_methods) }, 'p.nullable');
  }

  _takesUndefined(): boolean {
    return this.inner._takesUndefined();
  }

  /**
   * Declare how likely each side is, as `[value, null]`. A prior, not a
   * constraint, and part of the wire format.
   */
  weights(w: readonly number[]): PNullable<T> {
    return new PNullable<T>(this.inner, { ...this._prior, weights: w }, this._methods);
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are where it starts, and each side coded counts as one
   * observation, so a side that keeps recurring gets cheaper as the message
   * goes on. From its second value on, the node spends one bit to stay static,
   * or a few to name the learning rate that paid off. Part of the wire format,
   * like the weights.
   */
  learn(): PNullable<T> {
    return this._declare('learn', 'p.nullable');
  }

  /**
   * What the node's learning goes by: `window` is how many observations the
   * counts hold before they halve, so the newest weigh most (1024 when left
   * out, and raised to the number of values counted when smaller), and
   * `separate` keeps it from starting where other nodes of its kind and window
   * got to. Set once; it applies once something learns.
   */
  learning(options: LearningOptions): PNullable<T> {
    return this._learning(options, 'p.nullable');
  }

  /** Learn with every method the node has, here `.learn()`, under `options` as `.learning()` takes them. */
  adaptive(options?: LearningOptions): PNullable<T> {
    return this._adapt(options, 'p.nullable');
  }

  _withMethods(methods: MethodSet): PNullable<T> {
    return new PNullable<T>(this.inner, this._prior, methods);
  }

  get _exact(): boolean {
    return this.inner._exact;
  }

  _write(enc: Encoder, value: T | null): void {
    this._members.write(enc, value === null ? 1 : 0);
    if (value !== null) {
      this.inner._write(enc, value);
    }
  }

  _read(dec: Decoder): T | null {
    if (this._members.read(dec) === 1) {
      return null;
    }
    return this.inner._read(dec);
  }
}
