import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { typedArrayKind, type Kind, type TypedArray } from './guards';
import { LengthPrefix, type LengthBounds } from './lattice';

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
  private readonly _length: LengthPrefix;

  constructor(type: TypedArrayClass<A>, bounds: LengthBounds = {}) {
    super();
    this._type = type;
    this._size = type.BYTES_PER_ELEMENT;
    this._length = new LengthPrefix(bounds, 'p.binary');
    this._kinds = [typedArrayKind(new type(new ArrayBuffer(0)))];
  }

  /** A floor on the element count; the prefix then counts up from it. */
  min(n: number): PBinary<A> {
    return new PBinary(this._type, { ...this._length.bounds, min: n });
  }

  max(n: number): PBinary<A> {
    return new PBinary(this._type, { ...this._length.bounds, max: n });
  }

  /** Fix the exact element count. The prefix then costs zero bits on the wire. */
  length(n: number): PBinary<A> {
    return new PBinary(this._type, { ...this._length.bounds, length: n });
  }

  _write(enc: Encoder, value: A): void {
    this._length.write(enc, value.length, 'Binary');
    const raw = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const size = this._size;
    for (let at = 0; at < raw.length; at += size) {
      for (let b = 0; b < size; b++) {
        enc.compose(raw[LITTLE_ENDIAN ? at + b : at + size - 1 - b], 256);
      }
    }
  }

  _read(dec: Decoder): A {
    // Read before allocating: a tampered length prefix then runs out of
    // input as corrupt data instead of requesting an absurd buffer.
    const count = this._length.read(dec) * this._size;
    const bytes: number[] = [];
    for (let i = 0; i < count; i++) {
      bytes.push(dec.parse(256));
    }
    const raw = Uint8Array.from(bytes);
    if (!LITTLE_ENDIAN) {
      for (let at = 0; at < raw.length; at += this._size) {
        raw.subarray(at, at + this._size).reverse();
      }
    }
    return new this._type(raw.buffer) as A;
  }
}
