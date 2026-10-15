import { Encoder, Decoder } from '../packer';
import type { InferShape } from './infer';
import { PNode } from './base';
import { atPath } from './path';
import type { Kind } from './guards';
import { withMethod, type Spelling } from './methods';
import { Recall, copy, identity } from './recall';

/**
 * Object with a fixed shape. A field whose node takes `undefined` may be
 * absent or `undefined`, and then decodes with its key left out.
 */
export class PObject<S extends Record<string, PNode<any>>> extends PNode<InferShape<S>> {
  readonly _kinds: readonly Kind[] = ['object'];

  private readonly _shape: S;
  private readonly _keys: readonly string[];
  private readonly _spelling: Spelling;
  /** Set by `.recall()`. */
  private readonly _recall?: Recall<InferShape<S>>;

  constructor(shape: S, spelling: Spelling = {}) {
    super();
    this._shape = { ...shape }; // copy so later caller mutation can't change the node
    this._keys = Object.keys(this._shape);
    this._spelling = spelling;
    if (spelling.recall !== undefined) {
      this._recall = new Recall(false, copy);
    }
  }

  /**
   * Spell an object this node already wrote in the message by its place
   * among the distinct objects it wrote, and a new one as an escape and
   * then in full: with n objects seen, a repeat costs log2(n + 1) bits. The
   * message's first object costs nothing extra. Objects the schema writes
   * the same way are the same object, and a repeat decodes as a copy of the
   * object first decoded.
   */
  recall(): PObject<S> {
    return new PObject<S>(this._shape, withMethod(this._spelling, 'recall', 'p.object'));
  }

  /** Whether the shape declares `key`. */
  _has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this._shape, key);
  }

  _write(enc: Encoder, value: InferShape<S>): void {
    const recall = this._recall;
    if (recall === undefined) {
      this._spell(enc, value);
    } else {
      const key = identity((alone) => this._spell(alone, value));
      recall.write(enc, key, () => this._spell(enc, value));
    }
  }

  _read(dec: Decoder): InferShape<S> {
    const recall = this._recall;
    return recall === undefined ? this._unspell(dec) : recall.read(dec, () => this._unspell(dec));
  }

  /** Writes the object in full. */
  private _spell(enc: Encoder, value: InferShape<S>): void {
    let key = '';
    try {
      for (key of this._keys) {
        this._writeField(enc, value, key);
      }
    } catch (error) {
      throw atPath(error, key);
    }
  }

  /** `key` is one of the shape's keys. */
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

  /** Reads an object `_spell` wrote. */
  private _unspell(dec: Decoder): InferShape<S> {
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
