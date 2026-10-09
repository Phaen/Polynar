import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { buildWeights, writeTable, readTable, type WeightTable } from './weights';

/** Boolean. `p.bool`. */
export class PBool extends PNode<boolean> {
  readonly _kinds: readonly Kind[] = ['boolean'];

  /** A prior as `[false, true]` weights; undefined means one bit each way. */
  private readonly _weights?: WeightTable;

  constructor(weights?: readonly number[]) {
    super();
    if (weights !== undefined) {
      this._weights = buildWeights(weights, 2, 'p.bool');
    }
  }

  /**
   * Declare how likely each value is, as `[false, true]`. A prior, not a
   * constraint, and part of the wire format.
   */
  weights(w: readonly number[]): PBool {
    return new PBool(w);
  }

  _write(enc: Encoder, value: boolean): void {
    if (this._weights === undefined) {
      enc.compose(value ? 1 : 0, 2);
    } else {
      const pos = value ? 1 : 0;
      writeTable(enc, this._weights, pos);
    }
  }

  _read(dec: Decoder): boolean {
    if (this._weights === undefined) {
      return Boolean(dec.parse(2));
    }
    return readTable(dec, this._weights) === 1;
  }
}
