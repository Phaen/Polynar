import { Encoder, Decoder } from '../packer';
import type { InferShape } from './infer';
import { PNode } from './base';
import { atPath } from './path';
import type { Kind } from './guards';

/**
 * Object with a fixed shape. A field whose node takes `undefined` may be
 * absent or `undefined`, and then decodes with its key left out.
 */
export class PObject<S extends Record<string, PNode<any>>> extends PNode<InferShape<S>> {
  readonly _kinds: readonly Kind[] = ['object'];

  private readonly _shape: S;
  private readonly _keys: readonly string[];

  constructor(shape: S) {
    super();
    this._shape = { ...shape }; // copy so later caller mutation can't change the node
    this._keys = Object.keys(this._shape);
  }

  /** Whether the shape declares `key`. */
  _has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this._shape, key);
  }

  _write(enc: Encoder, value: InferShape<S>): void {
    let key = '';
    try {
      for (key of this._keys) {
        this._writeField(enc, value, key);
      }
    } catch (error) {
      throw atPath(error, key);
    }
  }

  private _writeField(enc: Encoder, value: InferShape<S>, key: string): void {
    const field = this._shape[key];
    const v = (value as Record<string, unknown>)[key];
    // A field that takes `undefined` (an optional, or a union or `any` that
    // includes it) writes it like any other value, so an absent key and an
    // `undefined` value encode the same way.
    if (v === undefined && !field._takesUndefined()) {
      throw new TypeError('Required field is missing');
    }
    field._write(enc, v);
  }

  _read(dec: Decoder): InferShape<S> {
    const value: Record<string, unknown> = {};

    for (const key of this._keys) {
      const v = this._shape[key]._read(dec);
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
