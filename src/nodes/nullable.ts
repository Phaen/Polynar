import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import type { AdaptiveOptions } from './adaptive';
import { members, type MemberPrior, type Members } from './members';

/**
 * A value or `null`. `p.nullable`. Writes the same bits as
 * `p.union([node, p.null()])`, but tells `null` apart by value instead of by
 * kind, so the inner node needs no kinds and can be `p.lazy`.
 */
export class PNullable<T> extends PNode<T | null> {
  /**
   * The inner node's kinds plus `'null'`, or undeclared when the inner node's
   * are, so a nullable node is a union member whenever its inner node is.
   */
  declare readonly _kinds?: readonly Kind[];

  /** The prior as declared, `[value, null]`, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  /** Member 0 is a value, member 1 null. */
  private readonly _members: Members;

  constructor(
    readonly inner: PNode<T>,
    prior?: MemberPrior
  ) {
    super();
    if (inner._kinds !== undefined) {
      this._kinds = [...new Set<Kind>([...inner._kinds, 'null'])];
    }
    this._prior = prior;
    this._members = members(2, prior, 'p.nullable');
  }

  _takesUndefined(): boolean {
    return this.inner._takesUndefined();
  }

  /**
   * Declare how likely each side is, as `[value, null]`. A prior, not a
   * constraint, and part of the wire format.
   */
  weights(w: readonly number[]): PNullable<T> {
    return new PNullable<T>(this.inner, { ...this._prior, weights: w });
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are the starting point, and each side coded counts as one
   * observation, so a side that keeps recurring gets cheaper as the message
   * goes on. `window` is how many observations the counts hold before they
   * halve, so the newest weigh most (1024 when left out, and raised to the
   * number of values it counts when smaller). From its second value on, the
   * node spends one bit to stay static, or a few to name the learning rate that
   * paid off. Part of the wire format, like the weights.
   */
  adaptive(options?: AdaptiveOptions): PNullable<T> {
    return new PNullable<T>(this.inner, {
      ...this._prior,
      adaptive: options ?? {},
    });
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
