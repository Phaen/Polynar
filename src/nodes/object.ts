import { Encoder, Decoder } from '../packer';
import { resolve } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import { session, type Session } from '../predictor/session';
import { STRUCT, type AdaptiveOptions, type Resolved } from '../predictor/types';
import type { InferShape } from './infer';
import { adapt, type PNode } from './base';
import { atPath } from './path';
import type { Kind } from './guards';
import { readMarker, writeMarker } from './markers';
import { MethodNode, type MethodSet } from './methods';

const OBJECT_MARKERS: ReadonlySet<number> = new Set([STRUCT.OBJ_START]);

/**
 * Object with a fixed shape. A field whose node takes `undefined` may be
 * absent or `undefined`, and then decodes with its key left out.
 */
export class PObject<S extends Record<string, PNode<any>>> extends MethodNode<InferShape<S>> {
  readonly _kinds: readonly Kind[] = ['object'];

  private readonly _shape: S;
  private readonly _keys: readonly string[];
  /** How the node learns. */
  readonly _methods: MethodSet;
  readonly _adaptive?: AdaptiveOptions;
  /** Under `.adaptive()`: the options the object's structure symbols code under. */
  private readonly _resolved?: Resolved;
  /** Whether a field codes through the predictor, so the object is a record of the message. */
  private readonly _holds: boolean;

  constructor(shape: S, methods: MethodSet = {}) {
    super();
    this._shape = { ...shape }; // copy so later caller mutation can't change the node
    this._keys = Object.keys(this._shape);
    this._methods = methods;
    this._adaptive = methods.adaptive;
    if (this._adaptive !== undefined) {
      this._resolved = resolve(this._adaptive, loadedPriors.json, 'p.object');
    }
    this._holds =
      this._adaptive !== undefined || this._keys.some((key) => this._shape[key]._holdsAdaptive);
  }

  /**
   * Code the object through the similarity predictor: its start, the
   * fields in shape order with their keys implied, each after the symbol
   * its value starts with (its kind, or whether an optional field is
   * there), and its end, as symbols of the message's structure; and every
   * field as under its own `.adaptive(options)` unless it has `.adaptive()`
   * or `.learn()` already, its nested objects, arrays and choices included.
   * Set once.
   */
  adaptive(options?: AdaptiveOptions): PObject<S> {
    return this._sugar(options, 'p.object');
  }

  _adapted(options: AdaptiveOptions, memo: Map<PNode<any>, PNode<any>>): PObject<S> {
    if (this._keeps()) {
      return this;
    }
    // fromEntries defines own properties, so a '__proto__' field stays a field.
    const shape = Object.fromEntries(
      this._keys.map((key) => [key, adapt(this._shape[key], options, memo)])
    );
    return new PObject<S>(shape as S, { ...this._methods, adaptive: options });
  }

  /** This node with `methods` in place of its own. */
  _withMethods(methods: MethodSet): PObject<S> {
    return new PObject<S>(this._shape, methods);
  }

  get _holdsAdaptive(): boolean {
    return this._holds;
  }

  _marker(): number {
    return STRUCT.OBJ_START;
  }

  _markers(): ReadonlySet<number> {
    return OBJECT_MARKERS;
  }

  /** Whether the shape declares `key`. */
  _has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this._shape, key);
  }

  _write(enc: Encoder, value: InferShape<S>): void {
    if (!this._holds) {
      this._fields(enc, value);
      return;
    }
    const s = this._open(enc, (s, o) => {
      if (s.take(this) < 0) s.marker(this, o).write(enc, STRUCT.OBJ_START);
    });
    try {
      this._fields(enc, value);
      const o = this._resolved;
      if (o !== undefined) s.marker(this, o).write(enc, STRUCT.OBJ_END);
    } finally {
      this._close(s);
    }
  }

  _read(dec: Decoder): InferShape<S> {
    if (!this._holds) {
      return this._unfields(dec);
    }
    const s = this._open(dec, (s, o) => {
      if (s.take(this) < 0) s.marker(this, o).read(dec);
    });
    try {
      const value = this._unfields(dec);
      const o = this._resolved;
      if (o !== undefined) s.marker(this, o).read(dec);
      return value;
    } finally {
      this._close(s);
    }
  }

  /**
   * Opens the object's record and its marker scope on the session of `side`, under
   * `.adaptive()` after `start` codes its start where its parent has not.
   */
  private _open(side: Encoder | Decoder, start: (s: Session, o: Resolved) => void): Session {
    const s = session(side);
    const o = this._resolved;
    if (o === undefined) {
      s.enterPlain();
    } else {
      start(s, o);
      s.enterScope(this, o);
    }
    s.enterRecord();
    return s;
  }

  private _close(s: Session): void {
    s.leaveRecord();
    s.leaveScope();
  }

  /** Writes the fields in shape order, each after its first structure symbol under `.adaptive()`. */
  private _fields(enc: Encoder, value: InferShape<S>): void {
    const record = value as Record<string, unknown>;
    const keys = this._keys;
    const o = this._resolved;
    let i = 0;
    try {
      for (; i < keys.length; i++) {
        const field = this._shape[keys[i]];
        const v = record[keys[i]];
        // A field that takes `undefined` (an optional, or a union or `any` that
        // includes it) writes it like any other value, so an absent key and an
        // `undefined` value encode the same way.
        if (v === undefined && !field._takesUndefined()) {
          throw new TypeError('Required field is missing');
        }
        if (o !== undefined) writeMarker(enc, this, o, field, field._marker(v));
        field._write(enc, v);
      }
    } catch (error) {
      throw atPath(error, keys[i]);
    }
  }

  /** Reads the fields `_fields` wrote. */
  private _unfields(dec: Decoder): InferShape<S> {
    const value: Record<string, unknown> = {};
    const o = this._resolved;
    for (const key of this._keys) {
      const node = this._shape[key];
      let v: unknown;
      try {
        if (o !== undefined) readMarker(dec, this, o, node);
        v = node._read(dec);
      } catch (error) {
        throw atPath(error, key);
      }
      if (v === undefined) {
        continue;
      }

      // A schema key named '__proto__' must land as an own property; plain
      // assignment would hit the prototype setter and silently drop it.
      if (key === '__proto__') {
        Object.defineProperty(value, key, {
          value: v,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        value[key] = v;
      }
    }
    return value as InferShape<S>;
  }
}
