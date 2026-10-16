import { Encoder, Decoder, CorruptInputError, ReplayDecoder, type Journal } from '../packer';
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
import {
  Lineage,
  checkAdaptation,
  readLive,
  withLineage,
  withoutRecall,
  writeLive,
  type AdaptiveOptions,
} from './adaptive';
import { members, type Members } from './members';
import { PRecall, Recall, copy } from './recall';
import { Fenwick } from './fenwick';
import { Companion, Scope } from './companion';

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

/** The declared weight of a common tag, and of every hint's: a hint is declared, so it is common. */
const COMMON_TIER = 100;

/** The declared weight of a rare tag, and of the recall tag under `.adaptive()`. */
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

/**
 * How many key names get a codec of their own under `p.any().adaptive()`
 * in one message; later new keys share one, so a message of many distinct
 * keys keeps a bounded number of codecs.
 */
export const MAX_KEYS = 1024;

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

/** The tags whose node each key builds for itself under `.adaptive()`. */
const OWN_TAGS = [TAG_INT, TAG_FLOAT, TAG_STRING, TAG_ARRAY, TAG_OBJECT, TAG_MAP, TAG_SET];

/**
 * The nodes behind the tags, in tag order: the default scalars, then the
 * given int, float, string, array, record, map and set nodes, then the raw
 * bytes, then the hints. A node left out is built on first use.
 */
function tagNodes(
  int: PNode<number> | undefined,
  float: PNode<number> | undefined,
  text: PNode<string> | undefined,
  array: PNode<AnyValue[]> | undefined,
  record: PNode<{ [key: string]: AnyValue }> | undefined,
  map: PNode<Map<AnyValue, AnyValue>> | undefined,
  set: PNode<Set<AnyValue>> | undefined,
  hints: readonly PNode<any>[]
): (PNode<any> | undefined)[] {
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

/**
 * The identity a whole array or record is recalled under: its JSON with
 * every number in the form `String` gives, or null when anything in it is
 * not JSON (undefined, a hole, -0, a non-finite number, any other class)
 * or it nests past `MAX_DEPTH`. Each container's identity is kept in
 * `memo`; a container is null there while its own is worked out, so a
 * value holding itself is null too. Each entry made records its undo in
 * `journal`.
 */
export function treeKey(
  value: unknown,
  memo: WeakMap<object, string | null>,
  depth = 0,
  journal?: Journal
): string | null {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0) ? String(value) : null;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      break;
    default:
      return null;
  }
  if (value === null) {
    return 'null';
  }
  if (memo.has(value) || depth === MAX_DEPTH) {
    return memo.get(value) ?? null;
  }
  memo.set(value, null);
  if (journal?.active === true) {
    journal.drop(memo, value);
  }
  const parts: string[] = [];
  let key: string;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const part = treeKey(value[i], memo, depth + 1, journal);
      if (part === null) {
        return null;
      }
      parts.push(part);
    }
    key = `[${parts.join()}]`;
  } else if (isPlainObject(value)) {
    for (const name of Object.keys(value)) {
      const part = treeKey(value[name], memo, depth + 1, journal);
      if (part === null) {
        return null;
      }
      parts.push(`${JSON.stringify(name)}:${part}`);
    }
    key = `{${parts.join()}}`;
  } else {
    return null;
  }
  memo.set(value, key);
  return key;
}

/** Whether `value` is an array or a record holding nothing. */
const isEmpty = (value: object): boolean =>
  Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;

/**
 * What one side knows of the arrays and records coded in full so far in a
 * message: the encoder each one's member by identity, the decoder each one
 * by member, and both how often each was recalled.
 */
interface Listing {
  readonly memo: WeakMap<object, string | null>;
  readonly index: Map<string, number>;
  readonly values: unknown[];
  readonly counts: Fenwick;
}

/**
 * Every non-empty array and record `p.any().adaptive()` coded in full in
 * the message, in the order they were done, each one's count starting at 1
 * and rising each time it is recalled. The encoder finds a value among
 * them by its `treeKey`; one without a key is listed all the same, so both
 * sides list the same containers.
 */
class Trees {
  state(side: Encoder | Decoder): Listing {
    return side.state(this, () => ({
      memo: new WeakMap(),
      index: new Map(),
      values: [],
      counts: Fenwick.zeros(0, side.journal),
    }));
  }

  /** The member of a listed array or record equal to `value`, if any. */
  find(enc: Encoder, value: unknown): number | undefined {
    const { memo, index } = this.state(enc);
    if (index.size === 0 || typeof value !== 'object' || value === null) {
      return undefined;
    }
    const key = treeKey(value, memo, 0, enc.journal);
    return key === null ? undefined : index.get(key);
  }

  /** Lists an array or record just coded in full, unless it is empty. */
  list(side: Encoder | Decoder, value: object): void {
    if (isEmpty(value)) {
      return;
    }
    const state = this.state(side);
    const member = state.counts.size;
    state.counts.push(1);
    if (side instanceof Encoder) {
      const key = treeKey(value, state.memo, 0, side.journal);
      // A container equal to a listed one is recalled, not coded in full,
      // so its key is new to the index.
      if (key !== null) {
        state.index.set(key, member);
        if (side.journal.active) {
          side.journal.drop(state.index, key);
        }
      }
    } else {
      state.values.push(value);
    }
  }

  /**
   * Writes listed member `member`: its place in `local`, the containers
   * one key recalled before, or an escape and then its place among all.
   */
  write(enc: Encoder, local: Recall<number>, member: number): void {
    const { counts } = this.state(enc);
    local.write(enc, String(member), () => writeLive(enc, counts, member));
    counts.add(member, 1);
  }

  /** Reads a member `write` wrote, as a copy of the container it stands for. */
  read(dec: Decoder, local: Recall<number>): unknown {
    const { values, counts } = this.state(dec);
    const member = local.read(dec, () => {
      // The encoder recalls only a listed container.
      if (counts.size === 0) {
        throw new CorruptInputError('p.any recalls a container before any was coded');
      }
      return readLive(dec, counts);
    });
    counts.add(member, 1);
    return copy(values[member]);
  }
}

/**
 * A tag table and the node behind each tag: all of a plain `p.any`, or one
 * key's under `.adaptive()`, which `make` builds a node of the first time
 * its tag comes up. There, `local` is set too: a whole array or record
 * equal to one coded in full earlier takes the tag past the hints, then
 * its place among those this key recalled, or an escape and its place
 * among all. A key's own codec there has a companion too, whose flag,
 * when offered, comes first and on a hit stands for the whole value.
 */
class AnyCodec extends PNode<AnyValue> {
  companion?: Companion;

  constructor(
    private readonly any: PAny,
    private readonly tags: Members,
    private readonly nodes: (PNode<any> | undefined)[],
    private readonly make?: (tag: number) => PNode<any>,
    private readonly local?: Recall<number>
  ) {
    super();
  }

  /** The node behind `tag`, built now if it is not yet. */
  node(tag: number): PNode<any> {
    return (this.nodes[tag] ??= (this.make as (tag: number) => PNode<any>)(tag));
  }

  _write(enc: Encoder, value: AnyValue): void {
    const { companion } = this;
    if (companion === undefined) {
      this.writeValue(enc, value);
      return;
    }
    const turn = companion.write(enc, value, () => this.writeValue(enc, value));
    companion.learn(turn, value, enc.journal);
  }

  _read(dec: Decoder): AnyValue {
    const { companion } = this;
    if (companion === undefined) {
      return this.readValue(dec);
    }
    const turn = companion.read(dec);
    const value = turn.hit ? (turn.prediction as AnyValue) : this.readValue(dec);
    companion.learn(turn, value);
    return value;
  }

  /** Writes `value` by its tag, or as a recalled container. */
  private writeValue(enc: Encoder, value: AnyValue): void {
    const { any, local } = this;
    const trees = any._trees;
    if (trees !== undefined && local !== undefined) {
      const member = trees.find(enc, value);
      if (member !== undefined) {
        this.tags.write(enc, this.nodes.length);
        trees.write(enc, local, member);
        any._recalled(enc, value);
        return;
      }
    }
    const tag = any._tagOf(enc, value);
    this.tags.write(enc, tag);
    any._nest(enc, tag, () => this.node(tag)._write(enc, value));
    if (trees !== undefined && (tag === TAG_ARRAY || tag === TAG_OBJECT)) {
      trees.list(enc, value as object);
    }
  }

  /** Reads a value `writeValue` wrote. */
  private readValue(dec: Decoder): AnyValue {
    const { any, local } = this;
    const trees = any._trees;
    const tag = this.tags.read(dec);
    if (trees !== undefined && local !== undefined && tag === this.nodes.length) {
      const value = trees.read(dec, local) as AnyValue;
      any._recalled(dec, value);
      return value;
    }
    const value = any._nest(dec, tag, () => this.node(tag)._read(dec) as AnyValue);
    if (trees !== undefined && (tag === TAG_ARRAY || tag === TAG_OBJECT)) {
      trees.list(dec, value as object);
    }
    return value;
  }
}

/**
 * The values of one key under `p.any().adaptive()`, through that key's
 * codec in the message: the shared one past `MAX_KEYS` when `key` is
 * undefined.
 */
class AnyKey extends PNode<AnyValue> {
  constructor(
    private readonly any: PAny,
    private readonly key: string | undefined
  ) {
    super();
  }

  _write(enc: Encoder, value: AnyValue): void {
    this.any._scoped(enc, () => this.any._child(enc, this.key)._write(enc, value));
  }

  _read(dec: Decoder): AnyValue {
    return this.any._scoped(dec, () => this.any._child(dec, this.key)._read(dec));
  }
}

/**
 * A plain object under `p.any().adaptive()`: its key list, then each value
 * in that order, through the codec of its key. The key list is the object's
 * own key order, so the empty object is the empty list.
 */
class AnyRecord extends PNode<{ [key: string]: AnyValue }> {
  constructor(
    private readonly _shape: PNode<string[]>,
    private readonly _any: PAny
  ) {
    super();
  }

  _write(enc: Encoder, value: { [key: string]: AnyValue }): void {
    const keys = Object.keys(value);
    this._shape._write(enc, keys);
    for (const key of keys) {
      try {
        this._any._child(enc, key)._write(enc, value[key]);
      } catch (error) {
        throw atPath(error, key);
      }
    }
  }

  _read(dec: Decoder): { [key: string]: AnyValue } {
    const keys = this._shape._read(dec);
    const entries = new Map<unknown, unknown>();
    for (const key of keys) {
      entries.set(key, this._any._child(dec, key)._read(dec));
    }
    return RECORD.build(entries);
  }
}

/** The options `p.any().adaptive()` takes: a window, as no node of it learns apart. */
type AnyAdaptiveOptions = Pick<AdaptiveOptions, 'window'>;

/** What every key's codec under `p.any().adaptive()` shares. */
interface Learning {
  /** The options as declared, which every key's nodes adapt by. */
  readonly options: AdaptiveOptions;
  /** The lineage the tag table of every key starts from. */
  readonly tagRoot: Lineage;
  /** The lineage the node of each tag in `OWN_TAGS` of every key starts from, by tag. */
  readonly roots: ReadonlyMap<number, Lineage>;
  /** The tag weights: the tiers, the hints, then the recall tag. */
  readonly tiers: readonly number[];
  /** Record keys: recalled among every key, a new one spelled by one shared string node. */
  readonly key: PNode<string>;
  /** Every string value, which a key's own recall escapes to. */
  readonly texts: Recall<string>;
  /** Every key list, which a key's own recall escapes to. */
  readonly shapes: Recall<string[]>;
  /** The hints as every key codes them: adaptive where they can be, a string-only one recalled. */
  readonly hints: readonly PNode<any>[];
  /** Whether each hint takes only strings, and so each key recalls its values first. */
  readonly textual: readonly boolean[];
}

/** One message's state of a `p.any` on one side. */
interface Message {
  /** How many values that may hold `p.any` the value being coded sits in. */
  depth: number;
  /** Under `.adaptive()`, each of the first `MAX_KEYS` keys' codec, built on first sight. */
  readonly children: Map<string, AnyCodec>;
  /** Under `.adaptive()`, the codec every later key shares, built on first sight. */
  overflow?: AnyCodec;
  /** Under `.adaptive()`, the values a key's companion may be predicted from. */
  readonly scope: Scope;
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

/** The identity of a string. */
const same = (text: string): string => text;

/** The identity of a key list. */
const listed = (keys: string[]): string => JSON.stringify(keys);

/** A hint's form under `.adaptive()`: its own `.adaptive(options)` when it has one. */
function adapted(hint: PNode<any>, options: AdaptiveOptions): PNode<any> {
  const adapt = (hint as { adaptive?: unknown }).adaptive;
  return typeof adapt === 'function' ? (adapt.call(hint, options) as PNode<any>) : hint;
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

  /** The hints as declared. */
  private readonly _hints: readonly PNode<any>[];
  /** The hints that take each kind, by index, in declared order. */
  private readonly _byKind = new Map<Kind, number[]>();
  /** The hints as values are tried against and coded by them. */
  private readonly _forms: readonly PNode<any>[];
  /** Without `.adaptive()`: the one codec every value goes through. */
  private readonly _codec?: AnyCodec;
  /** Under `.adaptive()`: what every key's codec shares. */
  private readonly _learning?: Learning;
  /** Under `.adaptive()`: the arrays and records coded in full, for recall. */
  readonly _trees?: Trees;

  constructor(hints: readonly PNode<any>[] = [], adaptive?: AnyAdaptiveOptions) {
    super();
    this._hints = [...hints];
    this._hints.forEach((hint, i) => {
      if (hint._kinds === undefined) {
        throw new TypeError('p.any hints must declare their kinds');
      }
      for (const kind of new Set(hint._kinds)) {
        this._byKind.set(kind, [...(this._byKind.get(kind) ?? []), i]);
      }
    });
    const tiers = [...TAG_TIERS, ...this._hints.map(() => COMMON_TIER)];
    if (adaptive === undefined) {
      this._forms = this._hints;
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
          this._hints
        )
      );
      return;
    }
    const options = checkAdaptation(adaptive, 'p.any');
    this._forms = this._hints.map((hint) => {
      // Every hint declares its kinds, checked above.
      const textual = (hint._kinds as readonly Kind[]).every((kind) => kind === 'string');
      return textual
        ? new PRecall<string>(adapted(hint, withoutRecall(options)), same)
        : adapted(hint, options);
    });
    this._learning = {
      options,
      tagRoot: new Lineage(),
      roots: new Map(OWN_TAGS.map((tag) => [tag, new Lineage()])),
      tiers: [...tiers, RARE_TIER],
      // A lineage of the key's own, so its tables learn apart from any
      // declared string's.
      key: new PRecall<string>(
        new PString().adaptive(withLineage(withoutRecall(options), new Lineage())),
        same
      ),
      texts: new Recall<string>(true),
      shapes: new Recall<string[]>(true),
      hints: this._forms,
      textual: this._forms.map((form) => form instanceof PRecall),
    };
    this._trees = new Trees();
    // A key's codec with every node built now, never used: its tables root
    // the lineages.
    const root = this._build('', true);
    for (const tag of OWN_TAGS) {
      root.node(tag);
    }
  }

  /**
   * Learns as the message goes on, a schema built on the fly: each key name
   * gets its own tag table, ints, floats, strings, arrays, records, maps
   * and sets, all adaptive, the first time it appears, and keeps them wherever it
   * appears again; an array's items sit under its key with `[]` added, and
   * values outside any record under a key of their own. A key's tables
   * start from what every key learned so far. Ints, floats and strings
   * each pick their plain spelling or the difference from the key's previous
   * one, as their nodes' `.adaptive()` does, and floats learn their decimal
   * places; strings, key lists and whole arrays and records equal to an earlier one
   * are recalled, from the key's own first, then from every key's, and the
   * characters of new strings and keys learn across the whole message, as
   * under `p.string().adaptive()`. A value a key had the last time an
   * earlier key of its record, or of a record around it, had its current
   * value, or that is that key's value, costs a learned flag once the key's
   * own values show that earlier key predicting it. Hints are used in their own adaptive
   * form where they have one, and a hint taking only strings recalls them
   * as `p.any` does its own. `window` is how many observations each table
   * holds before its counts halve, so the newest weigh most (1024 when left
   * out). Encoding and decoding take 5 to 40 times as long as without. Part
   * of the wire format.
   */
  adaptive(options?: AnyAdaptiveOptions): PAny {
    return new PAny(this._hints, options ?? {});
  }

  /** This message's state on `side`. */
  private _message(side: Encoder | Decoder): Message {
    return side.state(this, () => ({ depth: 0, children: new Map(), scope: new Scope() }));
  }

  /**
   * The codec of key `key` in this message on `side`, built on first
   * sight: its own for the first `MAX_KEYS` keys, and for every later one,
   * or an undefined key, the one they share.
   */
  _child(side: Encoder | Decoder, key: string | undefined): AnyCodec {
    const message = this._message(side);
    const { children } = message;
    let child = key === undefined ? undefined : children.get(key);
    if (child === undefined) {
      const { journal } = side;
      if (key !== undefined && children.size < MAX_KEYS) {
        child = this._build(key);
        child.companion = new Companion(message.scope, journal);
        children.set(key, child);
        if (journal?.active === true) {
          journal.drop(children, key);
        }
      } else if (message.overflow === undefined) {
        child = this._build(undefined);
        message.overflow = child;
        if (journal?.active === true) {
          journal.call(() => {
            message.overflow = undefined;
          });
        }
      } else {
        child = message.overflow;
      }
    }
    return child;
  }

  /**
   * The codec of key `key`, or the shared one past `MAX_KEYS` when
   * undefined, its adaptive tables starting from the roots' lineages, or
   * rooting them when `roots`. Its int, float, string, array, record, map
   * and set nodes are built on first use; the shared codec's arrays, maps and sets
   * hold values of the shared codec too.
   */
  private _build(key: string | undefined, roots = false): AnyCodec {
    const learning = this._learning as Learning;
    const { tiers, texts, shapes } = learning;
    const options = (root: Lineage): AdaptiveOptions =>
      withLineage(learning.options, roots ? root : new Lineage(root));
    const make = (tag: number): PNode<any> => {
      // Strings, key lists and containers are recalled by the codec, and an
      // int's recall saves next to nothing on top of its companion, so the
      // nodes open no recall of their own.
      const adaptive = withoutRecall(options(learning.roots.get(tag) as Lineage));
      switch (tag) {
        case TAG_INT:
          return new PInt().adaptive(adaptive);
        case TAG_FLOAT:
          return new PFloat().adaptive(adaptive);
        case TAG_STRING:
          return new PRecall(new PRecall(new PString().adaptive(adaptive), same, texts), same);
        case TAG_ARRAY:
          return new PArray<AnyValue>(
            new AnyKey(this, key === undefined ? undefined : `${key}[]`)
          ).adaptive(adaptive);
        case TAG_OBJECT: {
          const list = new PArray(learning.key).adaptive(adaptive);
          return new AnyRecord(new PRecall(new PRecall(list, listed, shapes), listed), this);
        }
        case TAG_MAP: {
          const here = new AnyKey(this, key);
          return new PCollection<Map<AnyValue, AnyValue>>(MAP, here, here).adaptive(adaptive);
        }
        default:
          // The last of OWN_TAGS, the only tags left unbuilt.
          return new PCollection<Set<AnyValue>>(SET, new AnyKey(this, key)).adaptive(adaptive);
      }
    };
    return new AnyCodec(
      this,
      members(tiers.length, { weights: tiers, adaptive: options(learning.tagRoot) }, 'p.any'),
      tagNodes(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        learning.hints.map((hint, i) => (learning.textual[i] ? new PRecall(hint, same) : hint))
      ),
      make,
      new Recall<number>(true)
    );
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
      throw new CorruptInputError(`p.any input nests deeper than ${MAX_DEPTH} levels`);
    }
    message.depth++;
    try {
      return code();
    } finally {
      message.depth--;
    }
  }

  /**
   * Runs `code`, the coding under `.adaptive()` of a value standing on its
   * own: an array item, a map entry's key or value, a set item or a
   * top-level value, whose values leave the scope when it is done.
   */
  _scoped<T>(side: Encoder | Decoder, code: () => T): T {
    const { scope } = this._message(side);
    const base = scope.open();
    const result = code();
    scope.close(base, side.journal);
    return result;
  }

  /**
   * Puts the strings and numbers of `value`, a recalled container, in the
   * scope under their keys as if coded one by one: those of a record and
   * of the records in it.
   */
  _recalled(side: Encoder | Decoder, value: unknown): void {
    if (Array.isArray(value)) {
      return;
    }
    const { scope } = this._message(side);
    const record = value as { [key: string]: unknown };
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (typeof item === 'string' || typeof item === 'number') {
        const codec = this._child(side, key);
        if (codec.companion !== undefined) {
          scope.push(codec.companion, item, side.journal);
        }
      } else if (isPlainObject(item)) {
        this._recalled(side, item);
      }
    }
  }

  get _exact(): boolean {
    return true;
  }

  _write(enc: Encoder, value: AnyValue): void {
    if (this._codec !== undefined) {
      this._codec._write(enc, value);
    } else {
      this._scoped(enc, () => this._child(enc, '')._write(enc, value));
    }
  }

  _read(dec: Decoder): AnyValue {
    if (this._codec !== undefined) {
      return this._codec._read(dec);
    }
    return this._scoped(dec, () => this._child(dec, '')._read(dec));
  }

  /**
   * The tag `value` travels under on `enc`: the first hint that takes it,
   * else its built-in tag; on an encoder trying a hint, its built-in tag.
   */
  _tagOf(enc: Encoder, value: unknown): number {
    const kind = kindOf(value);
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
