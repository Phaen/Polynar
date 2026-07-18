import { Encoder, Decoder, CorruptInputError } from '../packer';
import { isArray, isObject } from './guards';
import type { InferShape } from './infer';
import { PNode, POptional } from './base';

/** Object with a fixed shape. Optional fields carry a single presence bit. */
export class PObject<S extends Record<string, PNode<any>>> extends PNode<InferShape<S>> {
  private readonly _shape: S;
  private readonly _keys: readonly string[];

  constructor(shape: S) {
    super();
    this._shape = { ...shape }; // copy so later caller mutation can't change the node
    this._keys = Object.keys(this._shape);
    for (const key of this._keys) {
      if (!(this._shape[key] instanceof PNode)) {
        throw new TypeError(`p.object field '${key}' is not a schema node`);
      }
    }
  }

  _write(enc: Encoder, value: InferShape<S>): void {
    if (!isObject(value) || isArray(value)) {
      throw new TypeError('p.object expected an object');
    }

    for (const key of this._keys) {
      const field = this._shape[key];
      const optional = field instanceof POptional;
      // Unwrap the optional marker so the presence bit is written here, once;
      // the inner node never learns it was optional.
      const node = optional ? (field as POptional<unknown>).inner : field;
      const v = (value as Record<string, unknown>)[key];

      const presence = optional ? (field as POptional<unknown>).presence : undefined;

      // Only `undefined` means absent. `null` is a value in its own right (the
      // any type round-trips it), so it must reach the field's node.
      if (v === undefined) {
        if (optional) {
          if (presence === undefined) {
            enc.compose(0, 2);
          } else {
            enc.composeWeighted(0, presence[0], presence[0] + presence[1]);
          }
          continue;
        }
        throw new ReferenceError(`Object has no property '${key}'`);
      }

      if (optional) {
        if (presence === undefined) {
          enc.compose(1, 2);
        } else {
          enc.composeWeighted(presence[0], presence[1], presence[0] + presence[1]);
        }
      }
      node._write(enc, v);
    }
  }

  _read(dec: Decoder): InferShape<S> {
    const value: Record<string, unknown> = {};

    for (const key of this._keys) {
      const field = this._shape[key];
      const optional = field instanceof POptional;
      const node = optional ? (field as POptional<unknown>).inner : field;

      if (optional) {
        const presence = (field as POptional<unknown>).presence;
        const there =
          presence === undefined
            ? dec.parse(2) === 1
            : dec.parseWeighted(presence[0] + presence[1], (r) =>
                r < presence[0] ? [false, 0, presence[0]] : [true, presence[0], presence[1]]
              );
        if (!there) {
          continue;
        }
      }

      const v = node._read(dec);
      // `undefined` is the absence marker on encode, so no object can carry
      // it as a field VALUE — a wire state decoding to one (an `any` field's
      // undefined tag) has no canonical spelling and must read as corruption.
      if (v === undefined) {
        throw new CorruptInputError('Object field decoded as undefined, which is not encodable');
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
