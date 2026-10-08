import { Encoder, Decoder, UnknownVersionError } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { readIndex, writeIndex } from './lattice';

/**
 * A later version of a `p.versioned` schema: the node alone when a value of
 * the previous version already is one of the new (a widened bound, an added
 * optional field), otherwise the node with the function that turns a previous
 * value into a new one.
 */
export type Step<Prev, Next> = [Prev] extends [Next]
  ? PNode<Next> | readonly [PNode<Next>, (prev: Prev) => NoInfer<Next>]
  : readonly [PNode<Next>, (prev: Prev) => NoInfer<Next>];

type Migrate = (prev: unknown) => unknown;

/**
 * A schema that can change after data has been written. `p.versioned`.
 *
 * The wire carries the version index as the unbounded lattice term, then that
 * version's own encoding. The encoder always writes the newest version; the
 * decoder reads whichever version wrote the data and runs the migrations from
 * there up to the newest, one step at a time. Data of a version the schema
 * does not know throws `UnknownVersionError`.
 *
 * Old data therefore re-encodes as the newest version: the one place where
 * decode then encode does not reproduce the bytes.
 */
export class PVersioned<T> extends PNode<T> {
  readonly _kinds?: readonly Kind[];
  private readonly _nodes: readonly PNode<any>[];
  /** `_migrations[i]` turns a value of version i into one of version i + 1. */
  private readonly _migrations: readonly Migrate[];

  constructor(versions: readonly (PNode<any> | readonly [PNode<any>, Migrate])[]) {
    super();
    this._nodes = versions.map((step) => (step instanceof PNode ? step : step[0]));
    this._migrations = versions
      .slice(1)
      .map((step) => (step instanceof PNode ? (value: unknown) => value : step[1]));
    this._kinds = this._nodes[this._nodes.length - 1]._kinds;
  }

  _write(enc: Encoder, value: T): void {
    const newest = this._nodes.length - 1;
    writeIndex(enc, newest, 0);
    this._nodes[newest]._write(enc, value);
  }

  _read(dec: Decoder): T {
    const index = readIndex(dec, 0);
    if (index >= this._nodes.length) {
      throw new UnknownVersionError(
        `Data was written by version ${index + 1}; this schema knows ${this._nodes.length}`
      );
    }
    let value: unknown = this._nodes[index]._read(dec);
    for (let i = index; i < this._migrations.length; i++) {
      value = this._migrations[i](value);
    }
    return value as T;
  }
}
