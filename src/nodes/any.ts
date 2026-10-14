import { Encoder, Decoder, CorruptInputError } from '../packer';
import { isPlainObject, kindOf, type Kind, type TypedArray } from './guards';
import { PNode } from './base';
import { PInt } from './int';
import { PFloat } from './float';
import { PString } from './string';
import { PDate } from './date';
import { PBinary } from './binary';
import { PEnum } from './enum';
import { PNull } from './null';
import { PArray } from './array';
import { PCollection, MAP, RECORD, SET } from './collection';
import { atPath, unlocated } from './path';
import { AdaptiveTable, checkAdaptation, type AdaptiveOptions } from './adaptive';
import { members, type Members } from './members';
import { PRecall } from './recall';

/**
 * Every value `p.any` encodes: the JSON-like scalars plus `undefined`,
 * bigints, dates, regular expressions, ArrayBuffers, DataViews and typed
 * arrays, nested in arrays, plain objects, Maps and Sets.
 */
export type AnyValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Date
  | RegExp
  | ArrayBuffer
  | DataView
  | TypedArray
  | AnyValue[]
  | { [key: string]: AnyValue }
  | Map<AnyValue, AnyValue>
  | Set<AnyValue>;

// Type tags for the self-describing `any` codec: absent values, then scalars,
// then containers, then raw bytes: an ArrayBuffer, a DataView and one tag per
// typed-array class in TYPED_ARRAYS order. Each boolean is a tag of its own,
// so an adaptive tag table learns them like any other tag.
const TAG_UNDEFINED = 0;
const TAG_NULL = 1;
const TAG_FALSE = 2;
const TAG_TRUE = 3;
const TAG_INT = 4;
const TAG_FLOAT = 5;
const TAG_BIGINT = 6;
const TAG_STRING = 7;
const TAG_DATE = 8;
const TAG_REGEXP = 9;
const TAG_ARRAY = 10;
const TAG_OBJECT = 11;
const TAG_MAP = 12;
const TAG_SET = 13;
const TAG_ARRAY_BUFFER = 14;
const TAG_DATA_VIEW = 15;
const TAG_TYPED = 16;

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

const COMMON_TAGS: ReadonlySet<number> = new Set([
  TAG_NULL,
  TAG_FALSE,
  TAG_TRUE,
  TAG_INT,
  TAG_FLOAT,
  TAG_STRING,
  TAG_ARRAY,
  TAG_OBJECT,
]);

/**
 * The declared weight of each tag: two tiers, 100 for the JSON-like kinds
 * and 1 for the rest, so a common tag starts at about 3 bits instead of 4.8.
 */
export const TAG_TIERS: readonly number[] = Array.from({ length: TAG_COUNT }, (_, tag) =>
  COMMON_TAGS.has(tag) ? 100 : 1
);

/**
 * How many observations the tag tiers count as under `.adaptive()`: 7, so
 * one observed tag is worth about one common-tier unit.
 */
export const TAG_PRIOR = 7;

/**
 * How many observations the adaptive tag table holds before its learned
 * counts halve, unless `.adaptive()` declares a window.
 */
export const TAG_WINDOW = 1024;

/**
 * Whether a number travels under the int tag rather than the float tag. Both
 * round-trip every finite double exactly; the int lattice is the smaller
 * encoding for safe integers, and the float one for larger magnitudes and
 * the non-finite values. -0 is a safe integer to the check, but the int
 * lattice drops its sign.
 */
const travelsAsInt = (value: number): boolean =>
  Number.isSafeInteger(value) && !Object.is(value, -0);

/** Whether a tag stands for an array, record, map or set, which hold `p.any` itself. */
const isContainer = (tag: number): boolean => tag >= TAG_ARRAY && tag <= TAG_SET;

/**
 * How many containers `p.any` may nest. Encoding and decoding recurse two
 * frames per level, which before optimization take about 500 bytes of stack,
 * so the deepest value needs about 256 KB. That is under half of a 600 KB
 * stack, about what a browser gives, and leaves the rest to the caller.
 */
export const MAX_DEPTH = 512;

/** Bits of a bigint's zigzag per digit, below 53 so each digit is an exact number. */
const BIGINT_CHUNK = 32;

/**
 * A bigint of any size as its zigzag (0, -1, 1, -2 -> 0, 1, 2, 3): a term
 * counting the zigzag's bits, then every bit below the top one, which is
 * always set and so left out. Zero has no bits. The zigzag is a bijection, so there is
 * no negative zero to reject, and the implicit top bit leaves no leading
 * zeros, so each bigint has one spelling.
 */
class AnyBigInt extends PNode<bigint> {
  readonly _kinds: readonly Kind[] = ['bigint'];

  _write(enc: Encoder, value: bigint): void {
    const zigzag = value < 0n ? -value * 2n - 1n : value * 2n;
    const bits = zigzag === 0n ? '' : zigzag.toString(2);
    enc.composeTerm(bits.length);
    for (let at = 1; at < bits.length; at += BIGINT_CHUNK) {
      const chunk = bits.slice(at, at + BIGINT_CHUNK);
      enc.compose(parseInt(chunk, 2), 2 ** chunk.length);
    }
  }

  _read(dec: Decoder): bigint {
    const length = dec.parseTerm();
    if (length === 0) {
      return 0n;
    }
    // Digits are read before the bigint is built, so a corrupt bit count
    // runs out of input instead of building an absurd number.
    let bits = '0b1';
    for (let at = 1; at < length; at += BIGINT_CHUNK) {
      const width = Math.min(BIGINT_CHUNK, length - at);
      bits += dec
        .parse(2 ** width)
        .toString(2)
        .padStart(width, '0');
    }
    const zigzag = BigInt(bits);
    return zigzag % 2n === 0n ? zigzag / 2n : -(zigzag + 1n) / 2n;
  }
}

/** The RegExp flags `p.any` encodes, in the order a RegExp's `flags` lists them. */
const REGEXP_FLAGS = 'dgimsuvy';

/**
 * A regular expression as its source, then one bit per flag of
 * REGEXP_FLAGS, so each flag set has one spelling. Its `lastIndex` is
 * state, not part of the value, and is not kept. The encoder takes the
 * source from a live RegExp, already in the form the engine gives it, so a
 * decoded source the engine would rewrite, or a pattern it refuses, was
 * never written.
 */
class AnyRegExp extends PNode<RegExp> {
  readonly _kinds: readonly Kind[] = ['regexp'];

  _write(enc: Encoder, value: RegExp): void {
    ANY_STRING._write(enc, value.source);
    let mask = 0;
    for (const flag of value.flags) {
      const bit = REGEXP_FLAGS.indexOf(flag);
      if (bit === -1) {
        throw new TypeError(`p.any cannot encode the RegExp flag ${flag}`);
      }
      mask |= 1 << bit;
    }
    enc.compose(mask, 2 ** REGEXP_FLAGS.length);
  }

  _read(dec: Decoder): RegExp {
    const source = ANY_STRING._read(dec);
    const mask = dec.parse(2 ** REGEXP_FLAGS.length);
    const flags = [...REGEXP_FLAGS].filter((_, bit) => mask & (1 << bit)).join('');
    try {
      return new RegExp(source, flags);
    } catch (error) {
      throw new CorruptInputError(
        `Invalid RegExp /${source}/${flags}: ${(error as Error).message}`
      );
    }
  }
}

/** An ArrayBuffer as the bytes of a `Uint8Array` over all of it. */
class AnyArrayBuffer extends PNode<ArrayBuffer> {
  readonly _kinds: readonly Kind[] = ['ArrayBuffer'];

  _write(enc: Encoder, value: ArrayBuffer): void {
    ANY_BYTES._write(enc, new Uint8Array(value));
  }

  _read(dec: Decoder): ArrayBuffer {
    return ANY_BYTES._read(dec).buffer as ArrayBuffer;
  }
}

/**
 * A DataView as the bytes it spans. It decodes over a fresh buffer of exactly
 * those bytes, so its offset into a larger buffer is not kept.
 */
class AnyDataView extends PNode<DataView> {
  readonly _kinds: readonly Kind[] = ['DataView'];

  _write(enc: Encoder, value: DataView): void {
    ANY_BYTES._write(enc, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }

  _read(dec: Decoder): DataView {
    return new DataView(ANY_BYTES._read(dec).buffer);
  }
}

// The default nodes behind the scalar tags. Module singletons: no option of
// `any` changes them.
const ANY_UNDEFINED = new PEnum([undefined]);
const ANY_NULL = new PNull();
const ANY_FALSE = new PEnum([false]);
const ANY_TRUE = new PEnum([true]);
const ANY_INT = new PInt();
const ANY_FLOAT = new PFloat();
const ANY_BIGINT = new AnyBigInt();
const ANY_STRING = new PString();
const ANY_DATE = new PDate();
const ANY_REGEXP = new AnyRegExp();
const ANY_BINARY = TYPED_ARRAYS.map((type) => new PBinary<TypedArray>(type));
const ANY_BYTES = new PBinary(Uint8Array);
const ANY_ARRAY_BUFFER = new AnyArrayBuffer();
const ANY_DATA_VIEW = new AnyDataView();

/** The tag of each kind that has exactly one; booleans and numbers split by value. */
const TAG_BY_KIND = new Map<Kind, number>([
  ['undefined', TAG_UNDEFINED],
  ['null', TAG_NULL],
  ['bigint', TAG_BIGINT],
  ['string', TAG_STRING],
  ['date', TAG_DATE],
  ['regexp', TAG_REGEXP],
  ['array', TAG_ARRAY],
  ['object', TAG_OBJECT],
  ['map', TAG_MAP],
  ['set', TAG_SET],
  ['ArrayBuffer', TAG_ARRAY_BUFFER],
  ['DataView', TAG_DATA_VIEW],
  ...ANY_BINARY.map((node, i): [Kind, number] => [node._kinds[0], TAG_TYPED + i]),
]);

/**
 * A plain object as its key list, spelled through a recall of whole key
 * lists, then each value in that order. The key list is the object's own
 * key order, so the empty object is the empty list.
 */
class AnyRecord extends PNode<{ [key: string]: AnyValue }> {
  readonly _kinds: readonly Kind[] = ['object'];

  constructor(
    private readonly _shape: PNode<string[]>,
    private readonly _value: PNode<AnyValue>
  ) {
    super();
  }

  _write(enc: Encoder, value: { [key: string]: AnyValue }): void {
    const keys = Object.keys(value);
    this._shape._write(enc, keys);
    for (const key of keys) {
      try {
        this._value._write(enc, value[key]);
      } catch (error) {
        throw atPath(error, key);
      }
    }
  }

  _read(dec: Decoder): { [key: string]: AnyValue } {
    const keys = this._shape._read(dec);
    const entries = new Map<unknown, unknown>();
    for (const key of keys) {
      entries.set(key, this._value._read(dec));
    }
    return RECORD.build(entries);
  }
}

/**
 * Self-describing escape hatch: a type tag, then the value through the node
 * that tag stands for. Containers hold `p.any` itself. The tags take two
 * static tiers that favour the JSON-like kinds, and a record is its entry
 * count, then each key and value. Output type `AnyValue`. `p.any`.
 */
export class PAny extends PNode<AnyValue> {
  readonly _kinds: readonly Kind[] = [...TAG_BY_KIND.keys(), 'boolean', 'number'];

  /** The node behind each tag, in tag order. */
  private readonly _nodes: readonly PNode<any>[];

  /** The tag table: static, or learning which tags this node's message uses. */
  private readonly _tags: Pick<Members, 'write' | 'read'>;

  constructor(adaptive?: AdaptiveOptions) {
    super();
    let text: PNode<string> = ANY_STRING;
    let record: PNode<{ [key: string]: AnyValue }> = new PCollection(RECORD, ANY_STRING, this);
    if (adaptive === undefined) {
      this._tags = members(TAG_COUNT, { weights: TAG_TIERS }, 'p.any');
    } else {
      const options = checkAdaptation(adaptive, 'p.any');
      const window = options.window ?? TAG_WINDOW;
      this._tags = new AdaptiveTable(TAG_TIERS, TAG_COUNT, TAG_PRIOR, window, 'p.any');
      // String values and record keys share one spelling, its characters
      // learning across both, but each has a recall of its own.
      const string = new PString().adaptive(options);
      text = new PRecall<string>(string, (s) => s, 'p.any string');
      const key = new PRecall<string>(string, (s) => s, 'p.any key');
      // Whole key lists recall too, a new one spelled key by key.
      const shape = new PRecall<string[]>(
        new PArray(key),
        (keys) => JSON.stringify(keys),
        'p.any shape'
      );
      record = new AnyRecord(shape, this);
    }
    this._nodes = [
      ANY_UNDEFINED,
      ANY_NULL,
      ANY_FALSE,
      ANY_TRUE,
      ANY_INT,
      ANY_FLOAT,
      ANY_BIGINT,
      text,
      ANY_DATE,
      ANY_REGEXP,
      new PArray<AnyValue>(this),
      record,
      new PCollection(MAP, this, this),
      new PCollection(SET, this),
      ANY_ARRAY_BUFFER,
      ANY_DATA_VIEW,
      ...ANY_BINARY,
    ];
  }

  /**
   * Tags, strings, record keys and record key lists are priced by what the
   * message has already seen, so a value that recurs costs a fraction of its
   * first spelling and an array of same-shaped objects pays for its keys
   * once; the characters of new strings and keys learn as the message goes
   * on, as under `p.string().adaptive()`. `window` is how many observations
   * each table holds before its counts halve, so the newest weigh most (1024
   * when left out). Encoding and decoding take 5 to 40 times as long as
   * without. Part of the wire format.
   */
  adaptive(options?: AdaptiveOptions): PAny {
    return new PAny(options ?? {});
  }

  /** How many containers deep the value being written or read sits, this message. */
  private _nesting(side: Encoder | Decoder): { depth: number } {
    return side.state(this, () => ({ depth: 0 }));
  }

  _write(enc: Encoder, value: AnyValue): void {
    const tag = this._tagOf(value);
    this._tags.write(enc, tag);
    const node = this._nodes[tag];
    if (!isContainer(tag)) {
      node._write(enc, value);
      return;
    }
    const nesting = this._nesting(enc);
    // A value that contains itself is infinitely deep, so this also stops cycles.
    if (nesting.depth === MAX_DEPTH) {
      // Every level would add a segment to the path, so the message leaves it out.
      throw unlocated(new RangeError(`p.any nests deeper than ${MAX_DEPTH} levels`));
    }
    nesting.depth++;
    try {
      node._write(enc, value);
    } finally {
      nesting.depth--;
    }
  }

  private _tagOf(value: unknown): number {
    const kind = kindOf(value);
    if (kind === 'number') {
      return travelsAsInt(value as number) ? TAG_INT : TAG_FLOAT;
    }
    if (kind === 'boolean') {
      return value ? TAG_TRUE : TAG_FALSE;
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
    const tag = this._tags.read(dec);
    if (isContainer(tag)) {
      const nesting = this._nesting(dec);
      // The encoder never nests deeper, and deeper input could overflow the stack.
      if (nesting.depth === MAX_DEPTH) {
        throw new CorruptInputError(`p.any input nests deeper than ${MAX_DEPTH} levels`);
      }
      nesting.depth++;
      try {
        return this._nodes[tag]._read(dec);
      } finally {
        nesting.depth--;
      }
    }
    return this._nodes[tag]._read(dec);
  }
}
