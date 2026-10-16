import { Encoder, Decoder, CorruptInputError } from '../packer';
import { PNode } from './base';
import { typedArrayKind, type Kind, type TypedArray } from './guards';
import { checkUnset } from './lattice';
import type { Cdf } from './weights';
import type { AdaptiveOptions } from './adaptive';
import { withMethod } from './methods';
import {
  Sequence,
  withSequenceMethod,
  type SequenceBounds,
  type SequenceSpelling,
  type Symbols,
} from './sequence';

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
export class PBinary<A extends TypedArray> extends PNode<A> {
  readonly _kinds: readonly Kind[];

  private readonly _type: TypedArrayClass<A>;
  private readonly _bounds: SequenceBounds;
  /** The declared methods. */
  private readonly _spelling: SequenceSpelling;
  private readonly _sequence: Sequence<A>;

  constructor(
    type: TypedArrayClass<A>,
    bounds: SequenceBounds = {},
    spelling: SequenceSpelling = {}
  ) {
    super();
    this._type = type;
    this._bounds = bounds;
    this._spelling = spelling;
    this._sequence = new Sequence(new Bytes(type), bounds, spelling);
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
   * Let the node learn from the message. Each byte is priced by the four
   * bytes before it, as the message so far has followed them, falling back
   * to a prior over the bytes that learns too; a stretch of bytes that
   * already occurred in the message is referred back to instead of spelled
   * again; and the element count learns, on the magnitude scale from the
   * min when there is no max. The bytes
   * learn together with those of every other adaptive binary of the message
   * with the same window, whatever its element type, and the count's prior
   * may start from what its kin learned, unless `separate`. The declared
   * weights, or even ones when none are, are where the count's prior
   * starts. `window` is how many observations a prior's counts hold before
   * they halve, so the newest weigh most (1024 when left out, and raised to
   * the number of values they count when smaller). From its second value
   * on, each prior spends one bit to stay static, or a few to name the
   * learning rate that paid off. The element count takes weights, not a
   * cdf; part of the wire format, like the weights. Unless `.recall()` is
   * declared, an array the node already wrote may be recalled as under it,
   * at learned odds, whenever that costs less than spelling it.
   */
  adaptive(options?: AdaptiveOptions): PBinary<A> {
    return this._with({ ...this._bounds, adaptive: options ?? {} });
  }

  /**
   * Spell each array after the node's first by the start it shares with
   * the node's previous array: after the element count, how many of its
   * leading bytes are the previous array's (every count up to the shorter
   * byte length alike, or learned under `.adaptive()`), then only the bytes
   * after them, priced as following that start. Under `.adaptive()` without
   * it, each array picks the plain spelling or this one by a learned mode.
   */
  delta(): PBinary<A> {
    return this._with(this._bounds, withMethod(this._spelling, 'delta', 'p.binary'));
  }

  /**
   * Spell an array this node already wrote in the message by its place
   * among the distinct arrays it wrote, and a new one as an escape and then
   * in full: with n arrays seen, a repeat costs log2(n + 1) bits, or under
   * `.adaptive()` less the more often it recurs. The message's first array
   * costs nothing extra, and a repeat decodes as a copy of the array first
   * decoded.
   */
  recall(): PBinary<A> {
    return this._with(this._bounds, withMethod(this._spelling, 'recall', 'p.binary'));
  }

  /**
   * Copy a stretch of bytes this node already wrote in the message instead
   * of spelling it again: each array spends one bit on whether it copies
   * any, and one that does a bit at each position on whether a copy starts
   * there, and for a copy how far back it starts and how long it runs.
   * Under `.adaptive()` the odds learn and arrays copy whether or not this
   * is declared.
   */
  repeats(): PBinary<A> {
    return this._with(this._bounds, withSequenceMethod(this._spelling, 'repeats', 'p.binary'));
  }

  /**
   * Spell no length: the end of the buffer is one more symbol after its
   * bytes, priced like them. The bounds still hold, and a typed array ends
   * only after a whole element. Under `.adaptive()` without it, a node
   * spells its buffers' ends while those have lately cost less than their
   * lengths would. Not with a length `.cdf()` or `.weights()`.
   */
  terminated(): PBinary<A> {
    return this._with(this._bounds, withSequenceMethod(this._spelling, 'terminated', 'p.binary'));
  }

  /** This node with `bounds` and `spelling`, of the same element type. */
  private _with(bounds: SequenceBounds, spelling = this._spelling): PBinary<A> {
    return new PBinary(this._type, bounds, spelling);
  }

  _write(enc: Encoder, value: A): void {
    this._sequence.write(enc, value);
  }

  _read(dec: Decoder): A {
    return this._sequence.read(dec);
  }
}
