import { Encoder, Decoder, CorruptInputError, ReplayDecoder } from '../packer';
import { isPlainObject, kindOf, type Float16ArrayLike, type Kind, type TypedArray } from './guards';
import { PNode } from './base';
import { PInt } from './int';
import { PFloat } from './float';
import { PString } from './string';
import { PDate } from './date';
import { PBinary, type TypedArrayClass } from './binary';
import { PEnum } from './enum';
import { PNull } from './null';
import { PArray } from './array';
import { PCollection, MAP, RECORD, SET } from './collection';
import { unlocated } from './path';
import { members, type Members } from './members';

export { kindMarker } from './markers';

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
// typed-array class in TYPED_ARRAYS order, Float16Array last. Each boolean is a tag of its own.
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

/** `Float16Array`, where the environment has it. */
const FLOAT16 = (globalThis as { Float16Array?: TypedArrayClass<Float16ArrayLike> }).Float16Array;

// Float16Array's tag follows the others whether or not the class exists here,
// so every environment numbers the tags alike.
const TAG_COUNT = TAG_TYPED + TYPED_ARRAYS.length + 1;

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

/** The declared weight of a common tag, and of every hint's: a hint is declared, so it is common. */
const COMMON_TIER = 100;

/** The declared weight of a rare tag. */
const RARE_TIER = 1;

/**
 * The declared weight of each tag: two tiers, 100 for the JSON-like kinds
 * and 1 for the rest, so a common tag starts at about 3 bits instead of 4.8.
 */
export const TAG_TIERS: readonly number[] = Array.from({ length: TAG_COUNT }, (_, tag) =>
  COMMON_TAGS.has(tag) ? COMMON_TIER : RARE_TIER
);

/**
 * Whether a number travels under the int tag rather than the float tag. Both
 * round-trip every finite double exactly; the int lattice is the smaller
 * encoding for safe integers, and the float one for larger magnitudes and
 * the non-finite values. -0 is a safe integer to the check, but the int
 * lattice drops its sign.
 */
const travelsAsInt = (value: number): boolean =>
  Number.isSafeInteger(value) && !Object.is(value, -0);

/**
 * Whether a tag stands for a value that may hold `p.any` itself: an array,
 * record, map or set, or a hint's value.
 */
const nests = (tag: number): boolean => (tag >= TAG_ARRAY && tag <= TAG_SET) || tag >= TAG_COUNT;

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
    dec.charge(length);
    // Digits are read before the bigint is built, and a bit count no input
    // backs meets the decode limit first, so it never builds an absurd number.
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

/**
 * Stands in for the node of a typed-array class the environment lacks: no
 * value of it can be written here, and one read can't be built.
 */
export class AnyMissing extends PNode<never> {
  readonly _kinds: readonly Kind[];

  constructor(kind: string) {
    super();
    this._kinds = [kind];
  }

  _write(): never {
    throw new TypeError(`p.any cannot encode ${this._kinds[0]} values here: the class is missing`);
  }

  _read(): never {
    throw new TypeError(`p.any read a ${this._kinds[0]}, which this environment lacks`);
  }
}

/** The node behind the tag of typed-array class `type`, named `kind`, which may be missing. */
export const typedNode = (
  type: TypedArrayClass | undefined,
  kind: string
): PBinary<TypedArray> | AnyMissing =>
  type === undefined ? new AnyMissing(kind) : new PBinary(type);

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
const ANY_BINARY = [
  ...TYPED_ARRAYS.map((type) => new PBinary<TypedArray>(type)),
  typedNode(FLOAT16, 'Float16Array'),
];
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
 * The nodes behind the tags, in tag order: the default scalars, then the
 * given int, float, string, array, record, map and set nodes, then the raw
 * bytes, then the hints.
 */
function tagNodes(
  int: PNode<number>,
  float: PNode<number>,
  text: PNode<string>,
  array: PNode<AnyValue[]>,
  record: PNode<{ [key: string]: AnyValue }>,
  map: PNode<Map<AnyValue, AnyValue>>,
  set: PNode<Set<AnyValue>>,
  hints: readonly PNode<any>[]
): PNode<any>[] {
  return [
    ANY_UNDEFINED,
    ANY_NULL,
    ANY_FALSE,
    ANY_TRUE,
    int,
    float,
    ANY_BIGINT,
    text,
    ANY_DATE,
    ANY_REGEXP,
    array,
    record,
    map,
    set,
    ANY_ARRAY_BUFFER,
    ANY_DATA_VIEW,
    ...ANY_BINARY,
    ...hints,
  ];
}

/** A tag table and the node behind each tag: all of a plain `p.any`. */
class AnyCodec extends PNode<AnyValue> {
  constructor(
    private readonly any: PAny,
    private readonly tags: Members,
    private readonly nodes: readonly PNode<any>[]
  ) {
    super();
  }

  _write(enc: Encoder, value: AnyValue): void {
    const { any } = this;
    const tag = any._tagOf(enc, value);
    this.tags.write(enc, tag);
    any._nest(enc, tag, () => this.nodes[tag]._write(enc, value));
  }

  _read(dec: Decoder): AnyValue {
    const tag = this.tags.read(dec);
    return this.any._nest(dec, tag, () => this.nodes[tag]._read(dec) as AnyValue);
  }
}

/** One message's state of a `p.any` on one side. */
interface Message {
  /** How many values that may hold `p.any` the value being coded sits in. */
  depth: number;
}

/**
 * The encoders a value is tried on against a hint. A `p.any` writing to one
 * takes no hint itself: the try then costs one write of the value however
 * deep hints nest, and a hint it accepts still writes, since every value
 * its built-in tags take, a hint's nested `p.any` writes too.
 */
const trials = new WeakSet<Encoder>();

/** The bytes a buffer, a DataView or a typed array spans. */
const bytesOf = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);

/** Whether `a` and `b` hold the same bytes. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Whether `a`, a value a hint decoded, is `b` exactly: primitives by
 * `Object.is`, so -0 is not 0; dates by time, regular expressions by
 * source and flags, buffers, DataViews and typed arrays by class and
 * bytes; arrays, Maps and Sets item by item in order; and other objects by
 * class, then key by key in order. `a` is finite, so the walk ends however
 * `b` nests.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (
    Object.getPrototypeOf(a) !== Object.getPrototypeOf(b) &&
    !(isPlainObject(a) && isPlainObject(b))
  ) {
    return false;
  }
  if (a instanceof Date) {
    return Object.is(a.getTime(), (b as Date).getTime());
  }
  if (a instanceof RegExp) {
    return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags;
  }
  if (a instanceof ArrayBuffer || ArrayBuffer.isView(a)) {
    return sameBytes(bytesOf(a), bytesOf(b as ArrayBuffer));
  }
  if (a instanceof Map || a instanceof Set) {
    const left = [...(a as Map<unknown, unknown>).entries()];
    const right = [...(b as Map<unknown, unknown>).entries()];
    return (
      left.length === right.length &&
      left.every(([k, v], i) => sameValue(k, right[i][0]) && sameValue(v, right[i][1]))
    );
  }
  if (Array.isArray(a)) {
    const list = b as unknown[];
    return a.length === list.length && a.every((item, i) => sameValue(item, list[i]));
  }
  const keys = Object.keys(a);
  const others = Object.keys(b);
  return (
    keys.length === others.length &&
    keys.every(
      (key, i) =>
        key === others[i] &&
        sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    )
  );
}

/**
 * Self-describing escape hatch: a type tag, then the value through the node
 * that tag stands for. Containers hold `p.any` itself. The tags take two
 * static tiers that favour the JSON-like kinds, and a record is its entry
 * count, then each key and value. Hints, nodes the caller expects some
 * values to fit, come after the built-in tags: each value tries those that
 * take its kind, in order, and the first that writes it and reads it back
 * unchanged codes it behind a tag of its own. Output type `AnyValue`. `p.any`.
 */
export class PAny extends PNode<AnyValue> {
  readonly _kinds: readonly Kind[] = [...TAG_BY_KIND.keys(), 'boolean', 'number'];

  /** The hints as declared, which values are tried against and coded by. */
  private readonly _forms: readonly PNode<any>[];
  /** The hints that take each kind, by index, in declared order. */
  private readonly _byKind = new Map<Kind, number[]>();
  /** The one codec every value goes through. */
  private readonly _codec: AnyCodec;

  constructor(hints: readonly PNode<any>[] = []) {
    super();
    this._forms = [...hints];
    this._forms.forEach((hint, i) => {
      if (hint._kinds === undefined) {
        throw new TypeError('p.any hints must declare their kinds');
      }
      for (const kind of new Set(hint._kinds)) {
        this._byKind.set(kind, [...(this._byKind.get(kind) ?? []), i]);
      }
    });
    const tiers = [...TAG_TIERS, ...this._forms.map(() => COMMON_TIER)];
    this._codec = new AnyCodec(
      this,
      members(tiers.length, { weights: tiers }, 'p.any'),
      tagNodes(
        ANY_INT,
        ANY_FLOAT,
        ANY_STRING,
        new PArray<AnyValue>(this),
        new PCollection(RECORD, ANY_STRING, this),
        new PCollection(MAP, this, this),
        new PCollection(SET, this),
        this._forms
      )
    );
  }

  /** The values through the similarity predictor, which lands in the next stage. */
  adaptive(): PAny {
    throw new Error('p.any().adaptive() lands in stage 2');
  }

  /** This message's state on `side`. */
  private _message(side: Encoder | Decoder): Message {
    return side.state(this, () => ({ depth: 0 }));
  }

  /**
   * Runs `code`, the coding of a value of tag `tag`, one level deeper when
   * the tag's value may hold `p.any`.
   */
  _nest<T>(side: Encoder | Decoder, tag: number, code: () => T): T {
    if (!nests(tag)) {
      return code();
    }
    const message = this._message(side);
    // A value that contains itself is infinitely deep, so this also stops cycles.
    if (message.depth === MAX_DEPTH) {
      if (side instanceof Encoder) {
        // Every level would add a segment to the path, so the message leaves it out.
        throw unlocated(new RangeError(`p.any nests deeper than ${MAX_DEPTH} levels`));
      }
      // The encoder never nests deeper, and deeper input could overflow the stack.
      throw unlocated(new CorruptInputError(`p.any input nests deeper than ${MAX_DEPTH} levels`));
    }
    message.depth++;
    try {
      return code();
    } finally {
      message.depth--;
    }
  }

  _write(enc: Encoder, value: AnyValue): void {
    this._codec._write(enc, value);
  }

  _read(dec: Decoder): AnyValue {
    return this._codec._read(dec);
  }

  /**
   * The tag `value` travels under on `enc`: the first hint that takes it,
   * else its built-in tag; on an encoder trying a hint, its built-in tag.
   */
  _tagOf(enc: Encoder, value: unknown): number {
    const kind = kindOf(value);
    if (kind === 'date' && isNaN((value as Date).getTime())) {
      throw new TypeError('p.any expected a valid Date, got Invalid Date');
    }
    for (const i of trials.has(enc) ? [] : (this._byKind.get(kind) ?? [])) {
      if (this._takes(i, value)) {
        return TAG_COUNT + i;
      }
    }
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

  /**
   * Whether hint `i` writes `value` without throwing and reads it back
   * unchanged, written to an encoder of its own and read back off its log.
   */
  private _takes(i: number, value: unknown): boolean {
    const form = this._forms[i];
    const trial = new Encoder();
    trials.add(trial);
    try {
      form._write(trial, value);
      const replay = new ReplayDecoder(trial);
      const back: unknown = form._read(replay);
      replay.finalize();
      return sameValue(back, value);
    } catch {
      return false;
    }
  }
}
