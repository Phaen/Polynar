import { Encoder, Decoder, CorruptInputError } from '../packer';
import { isPlainObject, kindOf, type Kind, type TypedArray } from './guards';
import { PNode } from './base';
import { PInt } from './int';
import { PFloat } from './float';
import { PString } from './string';
import { PBool } from './bool';
import { PDate } from './date';
import { PBinary } from './binary';
import { PEnum } from './enum';
import { PNull } from './null';
import { PArray } from './array';
import { PCollection, MAP, RECORD, SET } from './collection';

/**
 * Every value `p.any` encodes: the JSON-like scalars plus `undefined`, dates
 * and typed arrays, nested in arrays, plain objects, Maps and Sets.
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
  | { [key: string]: AnyValue }
  | Map<AnyValue, AnyValue>
  | Set<AnyValue>;

// Type tags for the self-describing `any` codec: absent values, then scalars,
// then containers, then one tag per typed-array class in TYPED_ARRAYS order.
// Integers and floats are distinct so integer values round-trip bit-exact
// through the int lattice instead of drifting through the fraction
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
const TAG_MAP = 9;
const TAG_SET = 10;
const TAG_TYPED = 11;

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

// The default nodes behind the scalar tags. Module singletons: `any` has no
// configuration, so these never vary.
const ANY_UNDEFINED = new PEnum([undefined]);
const ANY_NULL = new PNull();
const ANY_BOOL = new PBool();
const ANY_INT = new PInt();
const ANY_FLOAT = new PFloat();
const ANY_STRING = new PString();
const ANY_DATE = new PDate();
const ANY_BINARY = TYPED_ARRAYS.map((type) => new PBinary<TypedArray>(type));

/** The tag of each kind that has exactly one; numbers split by value. */
const TAG_BY_KIND = new Map<Kind, number>([
  ['undefined', TAG_UNDEFINED],
  ['null', TAG_NULL],
  ['boolean', TAG_BOOLEAN],
  ['string', TAG_STRING],
  ['date', TAG_DATE],
  ['array', TAG_ARRAY],
  ['object', TAG_OBJECT],
  ['map', TAG_MAP],
  ['set', TAG_SET],
  ...ANY_BINARY.map((node, i): [Kind, number] => [node._kinds[0], TAG_TYPED + i]),
]);

/**
 * Self-describing escape hatch: a type tag, then the value through the node
 * that tag stands for. Containers hold `p.any` itself. Output type
 * `AnyValue`. `p.any`.
 */
export class PAny extends PNode<AnyValue> {
  readonly _kinds: readonly Kind[] = [...TAG_BY_KIND.keys(), 'number'];

  /** The node behind each tag, in tag order. */
  private readonly _nodes: readonly PNode<any>[];

  /**
   * The containers between the root and the value being written. Every
   * nested value comes back through `_write`, so a container met again
   * while it is open is a cycle, which would otherwise recurse forever. It
   * is closed on the way out, so a shared (diamond) reference still encodes,
   * once per occurrence, as separate copies.
   */
  private readonly _open = new Set<object>();

  constructor() {
    super();
    this._nodes = [
      ANY_UNDEFINED,
      ANY_NULL,
      ANY_BOOL,
      ANY_INT,
      ANY_FLOAT,
      ANY_STRING,
      ANY_DATE,
      new PArray<AnyValue>(this),
      new PCollection(RECORD, ANY_STRING, this),
      new PCollection(MAP, this, this),
      new PCollection(SET, this),
      ...ANY_BINARY,
    ];
  }

  _write(enc: Encoder, value: AnyValue): void {
    const tag = this._tagOf(value);
    enc.compose(tag, TAG_COUNT);
    const node = this._nodes[tag];
    if (typeof value !== 'object' || value === null) {
      node._write(enc, value);
      return;
    }
    if (this._open.has(value)) {
      throw new TypeError('p.any cannot encode a circular structure');
    }
    this._open.add(value);
    try {
      node._write(enc, value);
    } finally {
      this._open.delete(value);
    }
  }

  private _tagOf(value: unknown): number {
    const kind = kindOf(value);
    if (kind === 'number') {
      // -0 is integer-valued but the int lattice normalizes it away; the
      // float path carries its sign bit, so every double round-trips exact.
      return Number.isInteger(value) && !Object.is(value, -0) ? TAG_INT : TAG_FLOAT;
    }
    if (kind === 'object' && !isPlainObject(value)) {
      const name = (value as object).constructor?.name ?? 'this type';
      throw new TypeError(`p.any cannot encode ${name} values, only plain objects`);
    }
    const tag = TAG_BY_KIND.get(kind);
    if (tag === undefined) {
      throw new TypeError(`p.any cannot encode ${kind} values`);
    }
    return tag;
  }

  _read(dec: Decoder): AnyValue {
    const tag = dec.parse(TAG_COUNT);
    const value = this._nodes[tag]._read(dec);
    // Integer-valued doubles always travel under the int tag (-0 is the one
    // exception), so a float-tagged integer is a second spelling of the same
    // value — the encoder never emits it.
    if (tag === TAG_FLOAT && Number.isInteger(value) && !Object.is(value, -0)) {
      throw new CorruptInputError('Non-canonical float tag on an integer value');
    }
    return value;
  }
}
