import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { buildWeights, locateWeighted, type WeightTable } from './weights';

/** Boolean. `p.bool`. */
export class PBool extends PNode<boolean> {
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
    if (typeof value !== 'boolean') {
      throw new TypeError(`p.bool expected a boolean, got ${String(value)}`);
    }
    if (this._weights === undefined) {
      enc.compose(value ? 1 : 0, 2);
    } else {
      const pos = value ? 1 : 0;
      enc.composeWeighted(this._weights.cums[pos], this._weights.freqs[pos], this._weights.total);
    }
  }

  _read(dec: Decoder): boolean {
    if (this._weights === undefined) {
      return Boolean(dec.parse(2));
    }
    return dec.parseWeighted(this._weights.total, locateWeighted(this._weights)) === 1;
  }
}
