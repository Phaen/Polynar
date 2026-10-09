import { Encoder, Decoder, CorruptInputError } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { buildWeights, writeTable, readTable, type WeightTable } from './weights';

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

  /** A prior as `[value, null]` weights; undefined means one bit. */
  private readonly _weights?: WeightTable;

  constructor(
    readonly inner: PNode<T>,
    weights?: readonly number[]
  ) {
    super();
    if (inner._kinds !== undefined) {
      this._kinds = [...new Set<Kind>([...inner._kinds, 'null'])];
    }
    if (weights !== undefined) {
      this._weights = buildWeights(weights, 2, 'p.nullable');
    }
  }

  /**
   * Declare how likely each side is, as `[value, null]`. A prior, not a
   * constraint, and part of the wire format.
   */
  weights(w: readonly number[]): PNullable<T> {
    return new PNullable<T>(this.inner, w);
  }

  _write(enc: Encoder, value: T | null): void {
    const pos = value === null ? 1 : 0;
    if (this._weights === undefined) {
      enc.compose(pos, 2);
    } else {
      writeTable(enc, this._weights, pos);
    }
    if (value !== null) {
      this.inner._write(enc, value);
    }
  }

  _read(dec: Decoder): T | null {
    const pos = this._weights === undefined ? dec.parse(2) : readTable(dec, this._weights);
    if (pos === 1) {
      return null;
    }
    const value = this.inner._read(dec);
    // `null` is spelled by the null side alone, so an inner node decoding to
    // it (an inner `any`'s null tag) has no canonical encoding.
    if (value === null) {
      throw new CorruptInputError('Non-null side decoded as null, which is not encodable');
    }
    return value;
  }
}
