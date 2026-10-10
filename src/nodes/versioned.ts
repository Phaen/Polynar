import { Encoder, Decoder, UnknownVersionError } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { IndexRange } from './lattice';

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

/** The version index: a lattice term counting up from 0. */
const VERSION = new IndexRange('p.versioned', 0);

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
export class PVersioned<T, TFirst = T> extends PNode<T> {
  readonly _kinds?: readonly Kind[];
  private readonly _nodes: readonly PNode<any>[];
  /** `_migrations[i]` turns a value of version i into one of version i + 1. */
  private readonly _migrations: readonly Migrate[];

  constructor(versions: readonly [PNode<any>, ...(PNode<any> | readonly [PNode<any>, Migrate])[]]) {
    super();
    this._nodes = versions.map((step) => (step instanceof PNode ? step : step[0]));
    this._migrations = versions
      .slice(1)
      .map((step) => (step instanceof PNode ? (value: unknown) => value : step[1]));
    this._kinds = this._nodes[this._nodes.length - 1]._kinds;
  }

  _takesUndefined(): boolean {
    return this._nodes[this._nodes.length - 1]._takesUndefined();
  }

  _write(enc: Encoder, value: T): void {
    const newest = this._nodes.length - 1;
    VERSION.write(enc, newest);
    this._nodes[newest]._write(enc, value);
  }

  _read(dec: Decoder): T {
    const index = VERSION.read(dec);
    if (index >= this._nodes.length) {
      throw new UnknownVersionError(
        `Data was written by version ${index + 1}; this schema knows ${this._nodes.length}`
      );
    }
    return this._upgrade(this._nodes[index]._read(dec), index);
  }

  /**
   * Runs a value through the migrations to the newest version, the same way
   * `decode` upgrades old data. The value is of the first version, or of the
   * version whose node is passed as `from`.
   */
  walk(value: TFirst): T;
  walk<S>(value: S, from: PNode<S>): T;
  walk(value: unknown, from?: PNode<unknown>): T {
    const start = from === undefined ? 0 : this._nodes.indexOf(from);
    if (from !== undefined && this._nodes.lastIndexOf(from) !== start) {
      throw new TypeError('p.versioned walk got a node listed as more than one version');
    }
    if (start === -1) {
      throw new TypeError('p.versioned walk got a node that is not one of its versions');
    }
    return this._upgrade(value, start);
  }

  /** `index` is the version `value` is of, one of the listed versions. */
  private _upgrade(value: unknown, index: number): T {
    for (let i = index; i < this._migrations.length; i++) {
      value = this._migrations[i](value);
    }
    return value as T;
  }
}
