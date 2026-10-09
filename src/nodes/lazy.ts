import { Encoder, Decoder } from '../packer';
import { PNode } from './base';

/**
 * A node resolved on first use, so a schema can refer to itself or to a node
 * defined further down. `p.lazy`. The function runs once, on the first
 * encode or decode, and the node it returns does all the work: a lazy
 * reference costs nothing on the wire. Its kinds stay unknown until then, so
 * it cannot be a `p.union` member.
 */
export class PLazy<T> extends PNode<T> {
  private readonly _resolve: () => PNode<T>;
  private _node?: PNode<T>;

  constructor(resolve: () => PNode<T>) {
    super();
    this._resolve = resolve;
  }

  /** The node `resolve` returns, resolved on first use. */
  get _target(): PNode<T> {
    return (this._node ??= this._resolve());
  }

  _write(enc: Encoder, value: T): void {
    this._target._write(enc, value);
  }

  _read(dec: Decoder): T {
    return this._target._read(dec);
  }
}
