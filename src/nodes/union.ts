import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { kindOf, type Kind } from './guards';
import { oneOf } from './path';
import { buildWeights, locateWeighted, type WeightTable } from './weights';

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
  /** A prior over the members; undefined means uniform. */
  private readonly _weights?: WeightTable;

  constructor(members: readonly PNode<any>[], weights?: readonly number[]) {
    super();
    if (members.length === 0) {
      throw new TypeError('p.union requires at least one member');
    }
    this._members = [...members]; // copy so later caller mutation can't change the node
    this._members.forEach((member, i) => {
      if (member._kinds === undefined) {
        throw new TypeError(
          'p.union members must declare their kinds; p.lazy and custom nodes without _kinds cannot be members'
        );
      }
      for (const kind of member._kinds) {
        if (this._byKind.has(kind)) {
          throw new TypeError(
            `p.union members overlap on kind '${kind}'; only one member per kind`
          );
        }
        this._byKind.set(kind, i);
      }
    });
    this._kinds = [...this._byKind.keys()];
    if (weights !== undefined) {
      this._weights = buildWeights(weights, this._members.length, 'p.union');
    }
  }

  /**
   * Declare how likely each member is, in list order. A prior, not a
   * constraint: rare members still encode, just dearer. The weights are part
   * of the wire format.
   */
  weights(w: readonly number[]): PUnion<T> {
    return new PUnion<T>(this._members, w);
  }

  _write(enc: Encoder, value: T): void {
    const kind = kindOf(value);
    const pos = this._byKind.get(kind);
    if (pos === undefined) {
      throw new TypeError(`Kind '${kind}' is not ${oneOf(this._kinds)}`);
    }
    if (this._weights === undefined) {
      enc.compose(pos, this._members.length);
    } else {
      enc.composeWeighted(this._weights.cums[pos], this._weights.freqs[pos], this._weights.total);
    }
    this._members[pos]._write(enc, value);
  }

  _read(dec: Decoder): T {
    const pos =
      this._weights === undefined
        ? dec.parse(this._members.length)
        : dec.parseWeighted(this._weights.total, locateWeighted(this._weights));
    return this._members[pos]._read(dec);
  }
}
