import { Encoder, Decoder, CorruptInputError } from '../packer';
import type { InferShape } from './infer';
import { PNode, POptional } from './base';
import { atPath } from './path';
import type { Kind } from './guards';

/** Object with a fixed shape. An optional field that is absent decodes with its key left out. */
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
    if (v === undefined && !takesUndefined(field)) {
      throw new TypeError('Required field is missing');
    }
    field._write(enc, v);
  }

  _read(dec: Decoder): InferShape<S> {
    const value: Record<string, unknown> = {};

    for (const key of this._keys) {
      const field = this._shape[key];
      const v = field._read(dec);
      if (v === undefined) {
        if (field instanceof POptional) {
          continue;
        }
        // Only a field that takes `undefined` can have written it.
        if (!takesUndefined(field)) {
          throw new CorruptInputError('Object field decoded as undefined, which is not encodable');
        }
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

const takesUndefined = (field: PNode<unknown>): boolean =>
  field instanceof POptional || (field._kinds?.includes('undefined') ?? false);
