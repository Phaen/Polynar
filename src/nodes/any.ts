import { Encoder, Decoder, CorruptInputError } from '../packer';
import {
  isArray,
  isDate,
  isPlainObject,
  typedArrayKind,
  type Kind,
  type TypedArray,
} from './guards';
import { PNode } from './base';
import { atPath } from './path';
import { PInt } from './int';
import { PFloat } from './float';
import { PString } from './string';
import { PBool } from './bool';
import { PDate } from './date';
import { PBinary } from './binary';

/**
 * Every value `p.any` encodes: the JSON-like scalars plus `undefined`, dates
 * and typed arrays, nested in arrays and plain objects.
 */
export type AnyValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | Date
  | TypedArray
  | AnyValue[]
  | { [key: string]: AnyValue };

// Type tags for the self-describing `any` codec: absent values, then scalars,
// then containers, then one tag per typed-array class in TYPED_ARRAYS order.
// Integers and floats are distinct so integer values round-trip bit-exact
// through `composeTerm` instead of drifting through the fraction
// approximation.
const TAG_UNDEFINED = 0;
const TAG_NULL = 1;
const TAG_BOOLEAN = 2;
const TAG_INT = 3;
const TAG_FLOAT = 4;
const TAG_STRING = 5;
const TAG_DATE = 6;
const TAG_ARRAY = 7;
const TAG_OBJECT = 8;
const TAG_TYPED = 9;

/** The typed-array classes `p.any` encodes, each through a default `p.binary` of its class. */
const TYPED_ARRAYS = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
] as const;

const TAG_COUNT = TAG_TYPED + TYPED_ARRAYS.length;

/** Self-describing escape hatch. Output type `AnyValue`. `p.any`. */
export class PAny extends PNode<AnyValue> {
  readonly _kinds: readonly Kind[] = [
    'undefined',
    'null',
    'boolean',
    'number',
    'string',
    'date',
    'array',
    'object',
    ...ANY_BINARY_BY_KIND.keys(),
  ];

  _write(enc: Encoder, value: AnyValue): void {
    this._writeAny(enc, value, new WeakSet());
  }

  /**
   * `path` holds the containers between the root and the current value,
   * empty at the root.
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
      let i = 0;
      try {
        for (; i < value.length; i++) {
          this._writeAny(enc, value[i], path);
        }
      } catch (error) {
        throw atPath(error, i);
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

      case 'object': {
        // A DataView is a view too, but has no tag.
        const typed = ArrayBuffer.isView(value)
          ? ANY_BINARY_BY_KIND.get(typedArrayKind(value))
          : undefined;
        if (isDate(value)) {
          enc.compose(TAG_DATE, TAG_COUNT);
          ANY_DATE._write(enc, value);
        } else if (typed !== undefined) {
          enc.compose(typed, TAG_COUNT);
          ANY_BINARY[typed - TAG_TYPED]._write(enc, value as TypedArray);
        } else {
          if (!isPlainObject(value)) {
            const name = value.constructor?.name ?? 'this type';
            throw new TypeError(`p.any cannot encode ${name} values, only plain objects`);
          }
          if (path.has(value)) {
            throw new TypeError('p.any cannot encode a circular structure');
          }
          path.add(value);
          enc.compose(TAG_OBJECT, TAG_COUNT);
          const record = value as Record<string, unknown>;
          const keys = Object.keys(record);
          enc.composeTerm(keys.length);
          let key = '';
          try {
            for (key of keys) {
              ANY_STRING._write(enc, key);
              this._writeAny(enc, record[key], path);
            }
          } catch (error) {
            throw atPath(error, key);
          }
          path.delete(value);
        }
        break;
      }

      default:
        throw new TypeError(`p.any cannot encode ${typeof value} values`);
    }
  }

  _read(dec: Decoder): AnyValue {
    const tag = dec.parse(TAG_COUNT);
    switch (tag) {
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
        const value: AnyValue[] = [];
        for (let i = 0; i < length; i++) {
          value.push(this._read(dec));
        }
        return value;
      }
      case TAG_OBJECT: {
        const value: Record<string, AnyValue> = {};
        const count = dec.parseTerm();
        for (let i = 0; i < count; i++) {
          const key = ANY_STRING._read(dec);
          // The encoder walks Object.keys, which never repeats, so a wire
          // duplicate would collapse on decode and re-encode shorter.
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            throw new CorruptInputError('Duplicate key in record');
          }
          // An own property is defined because plain assignment would follow a
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
        // parse() bounds the tag to its radix, so only typed-array tags are
        // left.
        return ANY_BINARY[tag - TAG_TYPED]._read(dec);
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
const ANY_BINARY = TYPED_ARRAYS.map((type) => new PBinary<TypedArray>(type));
/** Each typed-array kind's tag. */
const ANY_BINARY_BY_KIND = new Map<Kind, number>(
  ANY_BINARY.map((node, i) => [node._kinds[0], TAG_TYPED + i])
);
