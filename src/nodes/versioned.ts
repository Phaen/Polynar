import { Encoder, Decoder, UnknownVersionError } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { IndexRange } from './lattice';
import { noted } from './path';

/**
 * A later version of a `p.versioned` schema: the node alone when a value of
 * the previous version already is one of the new (a widened bound, an added
 * optional field, a removed field), otherwise the node with the function that
 * turns a previous value into a new one.
 */
export type Step<Prev, Next> = [Prev] extends [Next]
  ? PNode<Next> | readonly [PNode<Next>, (prev: Prev) => NoInfer<Next>]
  : readonly [PNode<Next>, (prev: Prev) => NoInfer<Next>];

/**
 * The argument list of `p.versioned` for the version types `T`: the first
 * node, then a `Step` from each version to the next. `[never, ...T][K]` is
 * the element before `T[K]`.
 */
export type Chain<T extends readonly unknown[]> = {
  [K in keyof T]: K extends '0' ? PNode<T[K]> : Step<[never, ...T][K & keyof [never, ...T]], T[K]>;
};

/** The last element of a tuple. */
export type Last<T extends readonly unknown[]> = T extends readonly [...unknown[], infer L]
  ? L
  : never;

type Migrate = (prev: unknown) => unknown;

/** What `PVersioned` is built from: the first node, then nodes or `[node, migrate]` pairs. */
export type Versions = readonly [PNode<any>, ...(PNode<any> | readonly [PNode<any>, Migrate])[]];

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
 * Each migration's result is written with its version's node, which checks
 * it, and the newest one is read back from its own bytes, so old data comes
 * out exactly as newest data would. Old data therefore re-encodes as the
 * newest version: the one place where decode then encode does not reproduce
 * the bytes.
 */
export class PVersioned<T, TFirst = T> extends PNode<T> {
  readonly _kinds?: readonly Kind[];
  private readonly _nodes: readonly PNode<any>[];
  /** `_migrations[i]` turns a value of version i into one of version i + 1. */
  private readonly _migrations: readonly Migrate[];

  constructor(versions: Versions) {
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
    const value = this._nodes[index]._read(dec);
    return index === this._nodes.length - 1 ? value : this._upgrade(value, index);
  }

  /**
   * Upgrades a value of an older version to the newest, the same way `decode`
   * upgrades old data. The value is of the first version, or of the version
   * whose node is passed as `from`.
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

  /**
   * Migrates from version `index` to the newest. Every step's result is
   * written with that version's node, so one that does not fit throws as
   * encoding it would, with the step named. The newest is read back from the
   * bytes it wrote, so the value comes out as decoding it would.
   */
  private _upgrade(value: unknown, index: number): T {
    const newest = this._nodes.length - 1;
    let enc: Encoder | undefined;
    for (let i = index; i < newest; i++) {
      try {
        value = this._migrations[i](value);
      } catch (error) {
        throw noted(error, `in migrating version ${i + 1} data to version ${i + 2}`);
      }
      enc = new Encoder();
      try {
        this._nodes[i + 1]._write(enc, value);
      } catch (error) {
        throw noted(error, `in data migrated from version ${i + 1} to ${i + 2}`);
      }
    }
    if (enc === undefined) {
      // Nothing to migrate: a walk from the newest version.
      enc = new Encoder();
      this._nodes[newest]._write(enc, value);
    }
    // The newest node wrote these bytes, so they decode.
    return this._nodes[newest]._read(new Decoder(enc.output()));
  }
}
