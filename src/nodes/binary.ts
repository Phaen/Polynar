import { Encoder, Decoder, CorruptInputError } from '../packer';
import { checkCompress, resolve } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import type { CompressOptions } from '../predictor/types';
import { PNode } from './base';
import { typedArrayKind, type Kind, type TypedArray } from './guards';
import { checkUnset, type LengthBounds } from './lattice';
import type { Cdf } from './weights';
import { Learned, PlainText, type Symbols } from './text';
import { markerOfKind } from './markers';

/**
 * A typed-array class: its element width and a way to build it on a buffer.
 * The element type comes from `prototype`, which keeps the plain class
 * (`Int16Array`) rather than the buffer-specific one its constructor returns.
 */
export interface TypedArrayClass<A extends TypedArray = TypedArray> {
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
export class Bytes<A extends TypedArray> implements Symbols<A> {
  readonly who = 'p.binary';
  readonly size = 256;
  readonly start = 0;
  readonly noun = 'length';
  readonly item = 'byte';
  readonly tailless = true;
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
  private readonly _bounds: LengthBounds;
  /** The options `.compress()` set, which hand the bytes to the predictor. */
  readonly _compress?: CompressOptions;
  private readonly _plain: PlainText<A>;
  /** The bytes through the predictor, under `.compress()`. */
  private readonly _learned?: Learned<A>;

  constructor(type: TypedArrayClass<A>, bounds: LengthBounds = {}, compress?: CompressOptions) {
    super();
    this._type = type;
    this._bounds = bounds;
    this._compress = compress;
    const bytes = new Bytes(type);
    this._plain = new PlainText(bytes, bounds);
    this._kinds = [typedArrayKind(new type(new ArrayBuffer(0)))];
    if (compress === undefined) {
      return;
    }
    if (bounds.prior !== undefined) {
      throw new TypeError(
        'p.binary compress cannot weigh the length: a compressed binary ends with a symbol'
      );
    }
    const options = resolve(compress, loadedPriors.text, 'p.binary');
    this._learned = new Learned(bytes, this, options, 'bytes', bounds);
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
   * count cannot encode. Not with `.compress()`.
   */
  cdf(fn: Cdf): PBinary<A> {
    checkUnset(this._bounds.prior, 'p.binary', 'prior');
    return this._with({ ...this._bounds, prior: fn });
  }

  /**
   * Declare how likely each element count from min (or 0) to max is, lowest
   * first. Same prior as `.cdf()`, given as the histogram instead of its
   * running total. Not with `.compress()`.
   */
  weights(w: readonly number[]): PBinary<A> {
    checkUnset(this._bounds.prior, 'p.binary', 'prior');
    return this._with({ ...this._bounds, prior: w });
  }

  _adapted(options: CompressOptions): PBinary<A> {
    return this._compress !== undefined ? this : this.compress(options);
  }

  _marker(): number {
    return markerOfKind(this._kinds[0]);
  }

  _markers(): ReadonlySet<number> {
    return new Set([this._marker()]);
  }

  /**
   * Code the bytes through the similarity predictor: each byte is predicted
   * from the bytes before it in the message and the node's own past arrays,
   * and the array ends with a symbol of its own, only ever after a whole
   * element, instead of a length. An array the node already wrote costs a
   * few bits. The bounds still hold. Set once.
   */
  compress(options?: CompressOptions): PBinary<A> {
    if (this._compress !== undefined) {
      throw new TypeError('p.binary compress is already set');
    }
    return new PBinary(this._type, this._bounds, checkCompress(options, 'p.binary'));
  }

  /** This node with `bounds`, of the same element type and compress options. */
  private _with(bounds: LengthBounds): PBinary<A> {
    return new PBinary(this._type, bounds, this._compress);
  }

  _write(enc: Encoder, value: A): void {
    if (this._learned === undefined) {
      this._plain.write(enc, value);
    } else {
      this._learned.write(enc, value);
    }
  }

  _read(dec: Decoder): A {
    return this._learned === undefined ? this._plain.read(dec) : this._learned.read(dec);
  }
}
