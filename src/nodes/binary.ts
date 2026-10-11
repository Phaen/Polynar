import { Encoder, Decoder, CorruptInputError } from '../packer';
import { PNode } from './base';
import { typedArrayKind, type Kind, type TypedArray } from './guards';
import { IndexRange, checkUnset, lengthRange, type LengthBounds } from './lattice';
import type { Cdf } from './weights';

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
 * A typed array as its raw bits: a length prefix counting elements, then each
 * element's bytes, low byte first on every machine. Nothing interprets the
 * values, so every element round-trips bit-exact, NaN payloads and -0
 * included, at exactly its width. `p.binary`, a `Uint8Array` by default.
 */
export class PBinary<A extends TypedArray> extends PNode<A> {
  readonly _kinds: readonly Kind[];

  private readonly _type: TypedArrayClass<A>;
  private readonly _size: number;
  private readonly _bounds: LengthBounds;
  private readonly _length: IndexRange;

  constructor(type: TypedArrayClass<A>, bounds: LengthBounds = {}) {
    super();
    this._type = type;
    this._size = type.BYTES_PER_ELEMENT;
    this._bounds = bounds;
    this._length = lengthRange(bounds, 'p.binary', 'length');
    this._kinds = [typedArrayKind(new type(new ArrayBuffer(0)))];
  }

  /** A floor on the element count; the prefix then counts up from it. */
  min(n: number): PBinary<A> {
    checkUnset(this._bounds.min, 'p.binary', 'min');
    return new PBinary(this._type, { ...this._bounds, min: n });
  }

  max(n: number): PBinary<A> {
    checkUnset(this._bounds.max, 'p.binary', 'max');
    return new PBinary(this._type, { ...this._bounds, max: n });
  }

  /**
   * Fix the exact element count, the same as `.min(n).max(n)`. The prefix
   * then costs zero bits on the wire.
   */
  length(n: number): PBinary<A> {
    checkUnset(this._bounds.min, 'p.binary', 'min');
    checkUnset(this._bounds.max, 'p.binary', 'max');
    return new PBinary(this._type, { ...this._bounds, min: n, max: n });
  }

  /**
   * Declare a prior over the element COUNT as an integer CDF: `fn(n)` is the
   * cumulative weight of counts below `n`. Requires a max; a zero-weight
   * count cannot encode.
   */
  cdf(fn: Cdf): PBinary<A> {
    return new PBinary(this._type, { ...this._bounds, prior: fn });
  }

  /**
   * Declare how likely each element count from min (or 0) to max is, lowest
   * first. Same prior as `.cdf()`, given as the histogram instead of its
   * running total.
   */
  weights(w: readonly number[]): PBinary<A> {
    return new PBinary(this._type, { ...this._bounds, prior: w });
  }

  _write(enc: Encoder, value: A): void {
    this._length.write(enc, value.length, () => `Binary length ${value.length}`);
    const raw = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const size = this._size;
    for (let at = 0; at < raw.length; at += size) {
      for (let b = 0; b < size; b++) {
        enc.compose(raw[LITTLE_ENDIAN ? at + b : at + size - 1 - b], 256);
      }
    }
  }

  _read(dec: Decoder): A {
    const length = this._length.read(dec);
    // No buffer holds more than 2^53 - 1 bytes, so a larger length was never
    // written, and below it the byte count stays a safe integer.
    if (length > Number.MAX_SAFE_INTEGER / this._size) {
      throw new CorruptInputError(`Binary length ${length} is above the largest possible buffer`);
    }
    // Reading before allocating means a corrupt length prefix runs out of
    // input as corrupt data instead of requesting an absurd buffer.
    const raw = Uint8Array.from(dec.parseMany(256, length * this._size));
    if (!LITTLE_ENDIAN) {
      for (let at = 0; at < raw.length; at += this._size) {
        raw.subarray(at, at + this._size).reverse();
      }
    }
    return new this._type(raw.buffer) as A;
  }
}
