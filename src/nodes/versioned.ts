import { Encoder, ReplayDecoder, UnknownVersionError, type Decoder } from '../packer';
import { PNode, adapt } from './base';
import { session } from '../predictor/session';
import type { CompressOptions } from '../predictor/types';
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

  /** The versions under a container's `.compress()`, the migrations kept. */
  _adapted(options: CompressOptions, memo: Map<PNode<any>, PNode<any>>): PVersioned<T, TFirst> {
    const nodes = this._nodes.map((node) => adapt(node, options, memo));
    if (nodes.every((node, i) => node === this._nodes[i])) {
      return this;
    }
    const versions = nodes.map((node, i) =>
      i === 0 ? node : ([node, this._migrations[i - 1]] as const)
    );
    return new PVersioned<T, TFirst>(versions as unknown as Versions);
  }

  get _holdsCompress(): boolean {
    return this._nodes.some((node) => node._holdsCompress);
  }

  /** The newest version's: the structure symbol a parent codes is that version's first. */
  _marker(value: unknown): number {
    return this._nodes[this._nodes.length - 1]._marker(value);
  }

  _markers(): ReadonlySet<number> | undefined {
    return this._nodes[this._nodes.length - 1]._markers();
  }

  _write(enc: Encoder, value: T): void {
    const newest = this._nodes.length - 1;
    VERSION.write(enc, newest);
    this._pass(enc, this._nodes[newest]);
    this._nodes[newest]._write(enc, value);
  }

  _read(dec: Decoder): T {
    const index = VERSION.read(dec);
    if (index >= this._nodes.length) {
      throw new UnknownVersionError(index + 1, this._nodes.length);
    }
    this._pass(dec, this._nodes[index]);
    const value = this._nodes[index]._read(dec);
    return index === this._nodes.length - 1 ? value : this._upgrade(value, index);
  }

  /** Hands the structure symbol coded for this node on to `node`, where one was. */
  private _pass(side: Encoder | Decoder, node: PNode<any>): void {
    if (this._holdsCompress) {
      const s = session(side);
      const sym = s.take(this);
      if (sym >= 0) s.give(sym, node);
    }
  }

  /**
   * Upgrades a value of an older version to the newest, the same way `decode`
   * upgrades old data: the value is written with its version's node and read
   * back before the migrations see it, so they can't change the caller's
   * object. The value is of the first version, of the version whose node is
   * passed as `from`, or of version `from` counting from 1.
   */
  walk(value: TFirst): T;
  walk<S>(value: S, from: PNode<S>): T;
  walk(value: unknown, from: number): T;
  walk(value: unknown, from?: PNode<unknown> | number): T {
    const start =
      from === undefined ? 0 : typeof from === 'number' ? from - 1 : this._nodes.indexOf(from);
    if (
      typeof from === 'number' &&
      !(Number.isInteger(from) && from >= 1 && from <= this._nodes.length)
    ) {
      throw new RangeError(
        `p.versioned walk got version ${from}; this schema knows 1 to ${this._nodes.length}`
      );
    }
    if (typeof from === 'object' && this._nodes.lastIndexOf(from) !== start) {
      throw new TypeError('p.versioned walk got a node listed as more than one version');
    }
    if (start === -1) {
      throw new TypeError('p.versioned walk got a node that is not one of its versions');
    }
    if (start === this._nodes.length - 1) {
      return this._upgrade(value, start);
    }
    const enc = new Encoder();
    this._nodes[start]._write(enc, value);
    return this._upgrade(this._nodes[start]._read(new ReplayDecoder(enc)), start);
  }

  /**
   * Migrates from version `index` to the newest. Every step's result is
   * written with that version's node, so one that does not fit throws as
   * encoding it would, with the step named. The newest is read back from the
   * symbols it wrote, so the value comes out as decoding it would.
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
    // The newest node wrote these symbols, so they read back.
    return this._nodes[newest]._read(new ReplayDecoder(enc));
  }
}
