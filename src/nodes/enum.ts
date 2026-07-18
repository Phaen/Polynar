import { Encoder, Decoder } from '../packer';
import { isArray } from './guards';
import { PNode } from './base';
import { buildWeights, locateWeighted, type WeightTable } from './weights';

/**
 * Enum: a fixed list of values, packed as a sub-byte index. `p.enum`.
 *
 * Membership is identity (`===`), so members can be anything with a stable
 * reference: strings, numbers, objects, functions, symbols. Decode returns
 * the listed member itself, not a copy.
 */
export class PEnum<T> extends PNode<T> {
  private readonly _list: readonly T[];
  /** A prior over the members; undefined means uniform. */
  private readonly _weights?: WeightTable;

  constructor(list: readonly T[], weights?: readonly number[]) {
    super();
    if (!isArray(list) || list.length === 0) {
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
    if (weights !== undefined) {
      this._weights = buildWeights(weights, this._list.length, 'p.enum');
    }
  }

  /**
   * Declare how likely each member is, in list order. A prior, not a
   * constraint: rare members still encode, just dearer. The weights are part
   * of the wire format.
   */
  weights(w: readonly number[]): PEnum<T> {
    return new PEnum<T>(this._list, w);
  }

  _write(enc: Encoder, value: T): void {
    const pos = this._list.indexOf(value);
    if (pos === -1) {
      throw new Error(`Value '${String(value)}' not found in list`);
    }
    if (this._weights === undefined) {
      enc.compose(pos, this._list.length);
    } else {
      enc.composeWeighted(this._weights.cums[pos], this._weights.freqs[pos], this._weights.total);
    }
  }

  _read(dec: Decoder): T {
    if (this._weights === undefined) {
      return this._list[dec.parse(this._list.length)];
    }
    return this._list[dec.parseWeighted(this._weights.total, locateWeighted(this._weights))];
  }
}
