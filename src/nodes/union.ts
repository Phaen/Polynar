import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { kindOf, type Kind } from './guards';
import { describe, oneOf } from './path';
import type { AdaptiveOptions, Learning } from './adaptive';
import { members, type MemberPrior, type Members } from './members';

/**
 * Union: one of several member nodes, picked by the value's JS kind
 * (`typeof`, with null, arrays and dates told apart). `p.union`.
 *
 * Each kind belongs to one member, so the encoder never guesses and every
 * value has exactly one encoding. Two array or two object members are
 * therefore rejected; object shapes go in `p.tagged`.
 */
export class PUnion<T> extends PNode<T> {
  readonly _kinds: readonly Kind[];
  private readonly _members: readonly PNode<any>[];
  private readonly _byKind = new Map<Kind, number>();
  /** The prior as declared, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  /** How the member a value goes to is spelled. */
  private readonly _pick: Members;

  constructor(nodes: readonly PNode<any>[], prior?: MemberPrior) {
    super();
    if (nodes.length === 0) {
      throw new TypeError('p.union requires at least one member');
    }
    this._members = [...nodes]; // copy so later caller mutation can't change the node
    this._members.forEach((member, i) => {
      if (member._kinds === undefined) {
        throw new TypeError(
          'p.union members must declare their kinds; p.lazy and custom nodes without _kinds cannot be members'
        );
      }
      for (const kind of member._kinds) {
        if (this._byKind.has(kind)) {
          throw new TypeError(
            `p.union members overlap on kind ${describe(kind)}; only one member per kind`
          );
        }
        this._byKind.set(kind, i);
      }
    });
    this._kinds = [...this._byKind.keys()];
    this._prior = prior;
    this._pick = members(this._members.length, prior, 'p.union');
  }

  /**
   * Declare how likely each member is, in list order. A prior, not a
   * constraint: rare members still encode, just dearer. The weights are part
   * of the wire format.
   */
  weights(w: readonly number[]): PUnion<T> {
    return new PUnion<T>(this._members, { ...this._prior, weights: w });
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are the starting point, and each member coded counts as one
   * observation, so a member that keeps recurring gets cheaper as the message
   * goes on. `window` is how many observations the counts hold before they
   * halve, so the newest weigh most (1024 when left out, and raised to the
   * number of values it counts when smaller). From its second value on, the
   * node spends one bit to stay static, or a few to name the learning rate that
   * paid off. Part of the wire format, like the weights.
   */
  adaptive(options?: AdaptiveOptions): PUnion<T> {
    return new PUnion<T>(this._members, {
      ...this._prior,
      adaptive: options ?? {},
    });
  }

  _open(options: Learning): PUnion<T> {
    return this.adaptive(options);
  }

  get _exact(): boolean {
    return this._members.every((member) => member._exact);
  }

  _write(enc: Encoder, value: T): void {
    const kind = kindOf(value);
    const pos = this._byKind.get(kind);
    if (pos === undefined) {
      throw new TypeError(`Kind ${describe(kind)} is not ${oneOf(this._kinds)}`);
    }
    this._pick.write(enc, pos);
    this._members[pos]._write(enc, value);
  }

  _read(dec: Decoder): T {
    return this._members[this._pick.read(dec)]._read(dec);
  }
}
