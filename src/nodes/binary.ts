import { Encoder, Decoder, CorruptInputError } from '../packer';
import { typedArrayKind, type Kind, type TypedArray } from './guards';
import { checkUnset, type LengthBounds } from './lattice';
import type { Cdf } from './weights';
import type { LearningOptions } from './adaptive';
import { MethodNode, type MethodSet } from './methods';
import { BYTES_METHODS, Sequence, type Symbols } from './sequence';

/**
 * A typed-array class: its element width and a way to build it on a buffer.
 * The element type comes from `prototype`, which keeps the plain class
 * (`Int16Array`) rather than the buffer-specific one its constructor returns.
 */
export interface TypedArrayClass<A extends TypedArray> {
  readonly prototype: A;
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer): TypedArray;
}

/** Whether this machine stores multi-byte numbers low byte first. */
const LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

/**
 * A typed array's bytes, each item one byte in wire order: an element's low
 * byte first on every machine.
 */
class Bytes<A extends TypedArray> implements Symbols<A> {
  readonly who = 'p.binary';
  /** Every element width, as each spells its bytes alike. */
  readonly pool = 'bytes';
  readonly size = 256;
  readonly start = 0;
  readonly noun = 'length';
  readonly item = 'byte';
  readonly tailless = true;
  readonly order = 0;
  /** Bytes per element. */
  private readonly width: number;

  constructor(private readonly type: TypedArrayClass<A>) {
    this.width = type.BYTES_PER_ELEMENT;
  }

  count(value: A): number {
    return value.length;
  }

  span(count: number): number {
    return count * this.width;
  }

  check(count: number): void {
    // No buffer holds more than 2^53 - 1 bytes, so a larger length was never
    // written, and below it the byte count stays a safe integer.
    if (count > Number.MAX_SAFE_INTEGER / this.width) {
      throw new CorruptInputError(`Binary length ${count} is above the largest possible buffer`);
    }
  }

  items(value: A): number[] {
    const raw = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const width = this.width;
    const bytes: number[] = [];
    for (let at = 0; at < raw.length; at += width) {
      for (let b = 0; b < width; b++) {
        bytes.push(raw[LITTLE_ENDIAN ? at + b : at + width - 1 - b]);
      }
    }
    return bytes;
  }

  units(): number {
    return 1;
  }

  symbol(byte: number): number {
    return byte;
  }

  tail(): void {}

  tails(): number {
    return 1;
  }

  untail(_dec: Decoder, byte: number): number {
    return byte;
  }

  row(): number {
    return 0;
  }

  build(bytes: number[]): A {
    // The bytes are read before the buffer is allocated, so a corrupt length
    // prefix runs out of input as corrupt data instead of requesting an
    // absurd buffer.
    const raw = Uint8Array.from(bytes);
    if (!LITTLE_ENDIAN) {
      for (let at = 0; at < raw.length; at += this.width) {
        raw.subarray(at, at + this.width).reverse();
      }
    }
    return new this.type(raw.buffer) as A;
  }

  subject(value: A): string {
    return `Binary length ${value.length}`;
  }

  copy(value: A): A {
    return value.slice() as A;
  }
}

/**
 * A typed array as its raw bits: a length prefix counting elements, then each
 * element's bytes, low byte first on every machine. Nothing interprets the
 * values, so every element round-trips bit-exact, NaN payloads and -0
 * included, at exactly its width. `p.binary`, a `Uint8Array` by default.
 */
export class PBinary<A extends TypedArray> extends MethodNode<A> {
  readonly _kinds: readonly Kind[];

  private readonly _type: TypedArrayClass<A>;
  private readonly _bounds: LengthBounds;
  /** The methods the node has, declared or open. */
  readonly _methods: MethodSet;
  readonly _methodNames = BYTES_METHODS;
  private readonly _sequence: Sequence<A>;

  constructor(type: TypedArrayClass<A>, bounds: LengthBounds = {}, methods: MethodSet = {}) {
    super();
    this._type = type;
    this._bounds = bounds;
    this._methods = methods;
    this._sequence = new Sequence(new Bytes(type), bounds, methods);
    this._kinds = [typedArrayKind(new type(new ArrayBuffer(0)))];
  }

  /** A floor on the element count; the prefix then counts up from it. */
  min(n: number): PBinary<A> {
    checkUnset(this._bounds.min, 'p.binary', 'min');
    return this._with({ ...this._bounds, min: n });
  }

  max(n: number): PBinary<A> {
    checkUnset(this._bounds.max, 'p.binary', 'max');
    return this._with({ ...this._bounds, max: n });
  }

  /**
   * Fix the exact element count, the same as `.min(n).max(n)`. The prefix
   * then costs zero bits on the wire.
   */
  length(n: number): PBinary<A> {
    checkUnset(this._bounds.min, 'p.binary', 'min');
    checkUnset(this._bounds.max, 'p.binary', 'max');
    return this._with({ ...this._bounds, min: n, max: n });
  }

  /**
   * Declare a prior over the element COUNT as an integer CDF: `fn(n)` is the
   * cumulative weight of counts below `n`. Requires a max; a zero-weight
   * count cannot encode.
   */
  cdf(fn: Cdf): PBinary<A> {
    return this._with({ ...this._bounds, prior: fn });
  }

  /**
   * Declare how likely each element count from min (or 0) to max is, lowest
   * first. Same prior as `.cdf()`, given as the histogram instead of its
   * running total.
   */
  weights(w: readonly number[]): PBinary<A> {
    return this._with({ ...this._bounds, prior: w });
  }

  /**
   * Let the node's own priors learn from the message: the bytes' odds,
   * every byte alike to start, and the element count's, on the magnitude
   * scale from the min when there is no max. The bytes learn together with
   * those of every other binary of the message with the same window,
   * whatever its element type, unless `separate`. The declared count
   * weights, or even ones when none are, are where the count's prior
   * starts; from its second value on, each prior spends one bit to stay
   * static, or a few to name the learning rate that paid off. The count
   * takes weights, not a cdf.
   */
  learn(): PBinary<A> {
    return this._declare('learn', 'p.binary');
  }

  /**
   * What the node's learning goes by, for `.learn()` and the methods that
   * learn: `window` is how many observations a table's counts hold before
   * they halve, so the newest weigh most (1024 when left out, and raised to
   * the number of values counted when smaller), and `separate` keeps the
   * bytes and repeats apart from the other binaries' and the node's tables
   * from starting where others of their kind got to. Set once.
   */
  learning(options: LearningOptions): PBinary<A> {
    return this._learning(options, 'p.binary');
  }

  /**
   * Price each byte by the four before it, as the message so far has
   * followed them, falling back to the bytes' learned odds, which this
   * turns on. The contexts price nothing until the message holds 64 bytes,
   * and after that only once they would have cost less than the odds alone.
   */
  contexts(): PBinary<A> {
    return this._declare('contexts', 'p.binary');
  }

  /**
   * Learn with every method the node has: `.learn()`, `.contexts()` and
   * `.repeats()` on, and `.delta()`, `.recall()` and `.terminated()` open
   * to a choice per value unless declared, under `options` as
   * `.learning()` takes them.
   */
  adaptive(options?: LearningOptions): PBinary<A> {
    return this._adapt(options, 'p.binary');
  }

  /**
   * Spell each array after the node's first by the start it shares with
   * the node's previous array: after the element count, how many of its
   * leading bytes are the previous array's, at learned odds, then only the
   * bytes after them, priced as following that start. Under `.adaptive()` without
   * it, each array picks the plain spelling or this one by a learned mode.
   */
  delta(): PBinary<A> {
    return this._declare('delta', 'p.binary');
  }

  /**
   * Spell an array this node already wrote in the message by its place
   * among the distinct arrays it wrote, and a new one as an escape and then
   * in full, at learned odds: an array that keeps recurring soon costs a
   * bit or two. The message's first array costs nothing extra, and a repeat
   * decodes as a copy of the array first decoded.
   */
  recall(): PBinary<A> {
    return this._declare('recall', 'p.binary');
  }

  /**
   * Copy a stretch of bytes this node already wrote in the message instead
   * of spelling it again: each array spends one bit on whether it copies
   * any, and one that does a bit at each position on whether a copy starts
   * there, and for a copy how far back it starts and how long it runs, all
   * at learned odds, from the message's 64th byte on. The binaries of one
   * window copy from each other's, unless `separate`.
   */
  repeats(): PBinary<A> {
    return this._declare('repeats', 'p.binary');
  }

  /**
   * Spell no length: the end of the buffer is one more symbol after its
   * bytes, priced like them. The bounds still hold, and a typed array ends
   * only after a whole element. Under `.adaptive()` without it, a node
   * spells its buffers' ends while those have lately cost less than their
   * lengths would. Not with a length `.cdf()` or `.weights()`.
   */
  terminated(): PBinary<A> {
    return this._declare('terminated', 'p.binary');
  }

  /** This node with `methods` in place of its own. */
  _withMethods(methods: MethodSet): PBinary<A> {
    return this._with(this._bounds, methods);
  }

  /** This node with `bounds` and `methods`, of the same element type. */
  private _with(bounds: LengthBounds, methods = this._methods): PBinary<A> {
    return new PBinary(this._type, bounds, methods);
  }

  _write(enc: Encoder, value: A): void {
    this._sequence.write(enc, value);
  }

  _read(dec: Decoder): A {
    return this._sequence.read(dec);
  }
}
