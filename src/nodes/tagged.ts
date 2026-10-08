import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import type { InferTagged } from './infer';
import type { PObject } from './object';
import { atPath } from './path';
import { buildWeights, locateWeighted, type WeightTable } from './weights';

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
  /** A prior over the members; undefined means uniform. */
  private readonly _weights?: WeightTable;

  constructor(key: K, members: M, weights?: readonly number[]) {
    super();
    this._key = key;
    this._members = { ...members }; // copy so later caller mutation can't change the node
    this._tags = Object.keys(this._members);
    if (this._tags.length === 0) {
      throw new TypeError('p.tagged requires at least one member');
    }
    this._tags.forEach((tag, i) => {
      if (this._members[tag]._has(key)) {
        throw new TypeError(
          `p.tagged member '${tag}' cannot have a '${key}' field; the tag carries it`
        );
      }
      this._index.set(tag, i);
    });
    if (weights !== undefined) {
      this._weights = buildWeights(weights, this._tags.length, 'p.tagged');
    }
  }

  /**
   * Declare how likely each member is, in key order. A prior, not a
   * constraint: rare members still encode, just dearer. The weights are part
   * of the wire format.
   */
  weights(w: readonly number[]): PTagged<K, M> {
    return new PTagged<K, M>(this._key, this._members, w);
  }

  _write(enc: Encoder, value: InferTagged<K, M>): void {
    const tag = (value as Record<string, unknown>)[this._key];
    const pos = this._index.get(tag as string);
    if (pos === undefined) {
      throw atPath(new Error(`Value '${String(tag)}' not found in tags`), this._key);
    }
    if (this._weights === undefined) {
      enc.compose(pos, this._tags.length);
    } else {
      enc.composeWeighted(this._weights.cums[pos], this._weights.freqs[pos], this._weights.total);
    }
    // The member ignores the tag key as it ignores any key outside its shape.
    this._members[this._tags[pos]]._write(enc, value);
  }

  _read(dec: Decoder): InferTagged<K, M> {
    const pos =
      this._weights === undefined
        ? dec.parse(this._tags.length)
        : dec.parseWeighted(this._weights.total, locateWeighted(this._weights));
    const tag = this._tags[pos];
    return { [this._key]: tag, ...this._members[tag]._read(dec) } as InferTagged<K, M>;
  }
}
