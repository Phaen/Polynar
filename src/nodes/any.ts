import { Encoder, Decoder, CorruptInputError } from '../packer';
import { isArray, isDate } from './guards';
import { PNode } from './base';
import { PInt } from './int';
import { PFloat } from './float';
import { PString } from './string';
import { PBool } from './bool';
import { PDate } from './date';

// Type tags for the self-describing `any` codec: absent values, then scalars,
// then containers. Integers and floats are distinct so integer values
// round-trip bit-exact through `composeTerm` instead of drifting through the
// fraction approximation.
const TAG_COUNT = 9;
const TAG_UNDEFINED = 0;
const TAG_NULL = 1;
const TAG_BOOLEAN = 2;
const TAG_INT = 3;
const TAG_FLOAT = 4;
const TAG_STRING = 5;
const TAG_DATE = 6;
const TAG_ARRAY = 7;
const TAG_OBJECT = 8;

/** Self-describing escape hatch. Output type `unknown`. `p.any`. */
export class PAny extends PNode<unknown> {
  _write(enc: Encoder, value: unknown): void {
    this._writeAny(enc, value, new WeakSet());
  }

  /**
   * `path` holds the containers between the root and the current value.
   * Membership means a cycle, which would otherwise recurse forever; it is
   * removed again on the way out so a shared (diamond) reference still
   * encodes — once per occurrence, as separate copies.
   */
  private _writeAny(enc: Encoder, value: unknown, path: WeakSet<object>): void {
    // `null` and arrays both report `typeof 'object'`, so handle them first.
    if (value === null) {
      enc.compose(TAG_NULL, TAG_COUNT);
      return;
    }

    if (isArray(value)) {
      if (path.has(value)) {
        throw new TypeError('p.any cannot encode a circular structure');
      }
      path.add(value);
      enc.compose(TAG_ARRAY, TAG_COUNT);
      enc.composeTerm(value.length);
      // Indexed iteration: sparse holes must encode (as `undefined`) so the
      // element count stays consistent with the length prefix.
      for (let i = 0; i < value.length; i++) {
        this._writeAny(enc, value[i], path);
      }
      path.delete(value);
      return;
    }

    switch (typeof value) {
      case 'undefined':
        enc.compose(TAG_UNDEFINED, TAG_COUNT);
        break;

      case 'number':
        // -0 is integer-valued but the int lattice normalizes it away; the
        // float path carries its sign bit, so every double round-trips exact.
        if (Number.isInteger(value) && !Object.is(value, -0)) {
          enc.compose(TAG_INT, TAG_COUNT);
          ANY_INT._write(enc, value);
        } else {
          enc.compose(TAG_FLOAT, TAG_COUNT);
          ANY_FLOAT._write(enc, value);
        }
        break;

      case 'string':
        enc.compose(TAG_STRING, TAG_COUNT);
        ANY_STRING._write(enc, value);
        break;

      case 'boolean':
        enc.compose(TAG_BOOLEAN, TAG_COUNT);
        ANY_BOOL._write(enc, value);
        break;

      case 'object':
        if (isDate(value)) {
          enc.compose(TAG_DATE, TAG_COUNT);
          ANY_DATE._write(enc, value);
        } else {
          if (path.has(value)) {
            throw new TypeError('p.any cannot encode a circular structure');
          }
          path.add(value);
          enc.compose(TAG_OBJECT, TAG_COUNT);
          const record = value as Record<string, unknown>;
          const keys = Object.keys(record);
          enc.composeTerm(keys.length);
          for (const key of keys) {
            ANY_STRING._write(enc, key);
            this._writeAny(enc, record[key], path);
          }
          path.delete(value);
        }
        break;

      default:
        throw new TypeError(`Type '${typeof value}' not supported`);
    }
  }

  _read(dec: Decoder): unknown {
    switch (dec.parse(TAG_COUNT)) {
      case TAG_UNDEFINED:
        return undefined;
      case TAG_FLOAT: {
        const value = ANY_FLOAT._read(dec);
        // Integer-valued doubles always travel under the int tag (-0 is the
        // one exception), so a float-tagged integer is a second spelling of
        // the same value — the encoder never emits it.
        if (Number.isInteger(value) && !Object.is(value, -0)) {
          throw new CorruptInputError('Non-canonical float tag on an integer value');
        }
        return value;
      }
      case TAG_STRING:
        return ANY_STRING._read(dec);
      case TAG_BOOLEAN:
        return ANY_BOOL._read(dec);
      case TAG_DATE:
        return ANY_DATE._read(dec);
      case TAG_NULL:
        return null;
      case TAG_INT:
        return ANY_INT._read(dec);
      case TAG_ARRAY: {
        const length = dec.parseTerm();
        const value: unknown[] = [];
        for (let i = 0; i < length; i++) {
          value.push(this._read(dec));
        }
        return value;
      }
      case TAG_OBJECT: {
        const value: Record<string, unknown> = {};
        const count = dec.parseTerm();
        for (let i = 0; i < count; i++) {
          const key = ANY_STRING._read(dec);
          // The encoder walks Object.keys, which never repeats, so a wire
          // duplicate would collapse on decode and re-encode shorter.
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            throw new CorruptInputError('Duplicate key in record');
          }
          // Define an own property: plain assignment would follow a
          // '__proto__' key to the prototype setter, letting wire data replace
          // the decoded object's prototype.
          Object.defineProperty(value, key, {
            value: this._read(dec),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        return value;
      }
      default:
        // parse() bounds the tag to its radix, so this is unreachable.
        throw new CorruptInputError('Unknown any-type tag');
    }
  }
}

// The default nodes the `any` codec delegates to after its type tag. Module
// singletons: `any` has no configuration, so these never vary.
const ANY_INT = new PInt();
const ANY_FLOAT = new PFloat();
const ANY_STRING = new PString();
const ANY_BOOL = new PBool();
const ANY_DATE = new PDate();
