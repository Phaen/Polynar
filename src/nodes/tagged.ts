import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import type { InferTagged } from './infer';
import type { PObject } from './object';
import { atPath, oneOf, describe } from './path';
import type { AdaptiveOptions } from './adaptive';
import { members, type MemberPrior, type Members } from './members';

/**
 * Tagged union: object shapes picked by the value's tag field. `p.tagged`.
 *
 * The tag is written as an index into the members (log2(members) bits, or
 * whatever the weights say), never as text, and the tag key belongs to no
 * member shape: the union carries it. The node is of kind 'object', so it
 * combines with members of other kinds in `p.union`.
 */
export class PTagged<K extends string, M extends Record<string, PObject<any>>> extends PNode<
  InferTagged<K, M>
> {
  readonly _kinds: readonly Kind[] = ['object'];
  private readonly _key: K;
  private readonly _members: M;
  private readonly _tags: readonly string[];
  private readonly _index = new Map<string, number>();
  /** The prior as declared, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  /** How the tag is spelled. */
  private readonly _pick: Members;

  constructor(key: K, shapes: M, prior?: MemberPrior) {
    super();
    this._key = key;
    this._members = { ...shapes }; // copy so later caller mutation can't change the node
    this._tags = Object.keys(this._members);
    if (this._tags.length === 0) {
      throw new TypeError('p.tagged requires at least one member');
    }
    this._tags.forEach((tag, i) => {
      // JS lists keys like '2' before all others, in numeric order, so the
      // member order (and with it the weights and the wire) would not be the
      // order the members were written in.
      if (/^(0|[1-9]\d{0,9})$/.test(tag) && Number(tag) < 2 ** 32 - 1) {
        throw new TypeError(
          `p.tagged tag ${describe(tag)} is a number, which JS reorders; use a tag that starts with a letter`
        );
      }
      if (this._members[tag]._has(key)) {
        throw new TypeError(
          `p.tagged member ${describe(tag)} cannot have a ${describe(key)} field; the tag carries it`
        );
      }
      this._index.set(tag, i);
    });
    this._prior = prior;
    this._pick = members(this._tags.length, prior, 'p.tagged');
  }

  /**
   * Declare how likely each member is, in key order. A prior, not a
   * constraint: rare members still encode, just dearer. The weights are part
   * of the wire format.
   */
  weights(w: readonly number[]): PTagged<K, M> {
    return new PTagged<K, M>(this._key, this._members, { ...this._prior, weights: w });
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are the starting point, and each tag coded counts as one
   * observation, so a tag that keeps recurring gets cheaper as the message goes
   * on. `window` is how many observations the counts hold before they halve, so
   * the newest weigh most (1024 when left out, and raised to the number of
   * values it counts when smaller). From its second value on, the node spends
   * one bit to stay static, or a few to name the learning rate that paid off.
   * Part of the wire format, like the weights.
   */
  adaptive(options?: AdaptiveOptions): PTagged<K, M> {
    return new PTagged<K, M>(this._key, this._members, {
      ...this._prior,
      adaptive: options ?? {},
    });
  }

  _write(enc: Encoder, value: InferTagged<K, M>): void {
    const tag = (value as Record<string, unknown>)[this._key];
    const pos = this._index.get(tag as string);
    if (pos === undefined) {
      throw atPath(new RangeError(`Value ${describe(tag)} is not ${oneOf(this._tags)}`), this._key);
    }
    this._pick.write(enc, pos);
    // The member ignores the tag key as it ignores any key outside its shape.
    this._members[this._tags[pos]]._write(enc, value);
  }

  _read(dec: Decoder): InferTagged<K, M> {
    const tag = this._tags[this._pick.read(dec)];
    return { [this._key]: tag, ...this._members[tag]._read(dec) } as InferTagged<K, M>;
  }
}
