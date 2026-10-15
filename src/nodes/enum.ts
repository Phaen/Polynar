import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { kindOf, type Kind } from './guards';
import { oneOf, describe } from './path';
import type { AdaptiveOptions } from './adaptive';
import { members, type MemberPrior, type Members } from './members';

/**
 * Enum: a fixed list of values, packed as a sub-byte index. `p.enum`.
 *
 * Membership is identity (`===`), so members can be anything with a stable
 * reference: strings, numbers, objects, functions, symbols. Decode returns
 * the listed member itself, not a copy.
 */
export class PEnum<T> extends PNode<T> {
  readonly _kinds: readonly Kind[];
  private readonly _list: readonly T[];
  /** The prior as declared, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  private readonly _members: Members;
  declare readonly _radix?: number;

  constructor(list: readonly T[], prior?: MemberPrior) {
    super();
    if (list.length === 0) {
      throw new TypeError('p.enum requires a non-empty list');
    }
    for (const member of list) {
      // The one real requirement: a member must equal itself under the ===
      // that indexOf uses, or it could never be encoded. Only NaN fails this.
      if (member !== member) {
        throw new TypeError('p.enum members must equal themselves; NaN cannot be encoded');
      }
    }
    // A duplicate member is unreachable behind its first occurrence and
    // silently inflates the radix every value pays for.
    if (new Set(list).size !== list.length) {
      throw new TypeError('p.enum members must be unique');
    }
    this._list = [...list]; // copy so later caller mutation can't change the node
    this._kinds = [...new Set(this._list.map(kindOf))];
    this._prior = prior;
    this._members = members(this._list.length, prior, 'p.enum');
    this._radix = this._members.radix;
  }

  /**
   * Declare how likely each member is, in list order. A prior, not a
   * constraint: rare members still encode, just dearer. The weights are part
   * of the wire format.
   */
  weights(w: readonly number[]): PEnum<T> {
    return new PEnum<T>(this._list, { ...this._prior, weights: w });
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
  adaptive(options?: AdaptiveOptions): PEnum<T> {
    return new PEnum<T>(this._list, {
      ...this._prior,
      adaptive: options ?? {},
    });
  }

  _write(enc: Encoder, value: T): void {
    this._members.write(enc, this._toDigit(value));
  }

  _read(dec: Decoder): T {
    return this._list[this._members.read(dec)];
  }

  /** `digit` lies in `[0, _radix)`, as a digit read in `_radix` does. */
  _fromDigit(digit: number): T {
    return this._list[digit];
  }

  /** The member's position in the list, which is also its member index under a prior. */
  _toDigit(value: T): number {
    const pos = this._list.indexOf(value);
    if (pos === -1) {
      throw new RangeError(`Value ${describe(value)} is not ${oneOf(this._list)}`);
    }
    return pos;
  }
}
