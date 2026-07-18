/**
 * Base class for every schema node. A node IS the codec for its type:
 * `_write` validates one value and pushes its digits through the packer
 * primitives (`compose`, `composeTerm`), `_read` pulls them back in the
 * same order. There is no intermediate description format — the node tree is
 * the schema, the wire format, and the validator in one place.
 *
 * Nodes are immutable: every refinement returns a fresh node, and all
 * configuration is validated eagerly in the constructor, so an invalid schema
 * fails where it is defined rather than on first use.
 *
 * Custom types are nodes too: subclass `PNode`, implement `_write`/`_read`
 * against the same primitives, and the node composes with `p.object`,
 * `p.array` and `.optional()` like any built-in.
 */
import { Encoder, Decoder } from '../packer';
import type { Charset } from '../packer';

/** Base class for every schema node. `_t` is a phantom carrying the output type. */
export abstract class PNode<TOut> {
  declare readonly _t: TOut;

  /** Validate one value and write its digits. The whole codec for this type. */
  abstract _write(enc: Encoder, value: TOut): void;

  /** Read one value back, in the exact order `_write` produced it. */
  abstract _read(dec: Decoder): TOut;

  encode(value: TOut): Uint8Array {
    const enc = new Encoder();
    this._write(enc, value);
    return enc.toUint8Array();
  }

  decode(bytes: Uint8Array): TOut {
    const dec = new Decoder(bytes);
    const value = this._read(dec);
    // The schema is the whole message, so the input must be exactly consumed.
    // This rejects tampered digits and trailing padding instead of silently
    // decoding them into plausible-looking values.
    dec.finalize();
    return value;
  }

  /** Encode to text instead of bytes. Both sides must agree on the charset. */
  encodeString(value: TOut, charset?: Charset): string {
    const enc = new Encoder();
    this._write(enc, value);
    return enc.toString(charset);
  }

  /** Decode text produced by `encodeString` with the same charset. */
  decodeString(str: string, charset?: Charset): TOut {
    const dec = new Decoder(str, charset);
    const value = this._read(dec);
    // Same exhaustion check as `decode`: the text is the whole message.
    dec.finalize();
    return value;
  }

  /** Mark this node optional. Only meaningful as a `p.object` field. */
  optional(): POptional<TOut> {
    return new POptional<TOut>(this);
  }
}

/** Wraps a node, adding the object-field presence bit. */
export class POptional<TOut> extends PNode<TOut> {
  declare readonly _optional: true;

  /** A prior on presence as `[absent, present]`; undefined means one bit. */
  readonly presence?: readonly [number, number];

  constructor(
    readonly inner: PNode<TOut>,
    presence?: readonly [number, number]
  ) {
    super();
    if (presence !== undefined) {
      const [absent, present] = presence;
      if (
        !Number.isInteger(absent) ||
        !Number.isInteger(present) ||
        absent < 1 ||
        present < 1 ||
        !Number.isSafeInteger(absent + present)
      ) {
        throw new TypeError('.optional() weights must be positive integers [absent, present]');
      }
      this.presence = [absent, present];
    }
  }

  /**
   * Declare how likely the field is to be there, as `[absent, present]`
   * weights: a 99%-present field costs ~0.015 bits instead of a full bit.
   * A prior, not a constraint, and part of the wire format.
   */
  weights(w: readonly [number, number]): POptional<TOut> {
    return new POptional<TOut>(this.inner, w);
  }

  _write(enc: Encoder, value: TOut): void {
    // The presence bit is emitted by PObject, which unwraps this node; a
    // direct write means top-level use, where absence has no slot to live in.
    if (value == null) {
      throw new TypeError(
        '.optional() is only meaningful on object fields; a top-level optional cannot encode null/undefined'
      );
    }
    this.inner._write(enc, value);
  }

  _read(dec: Decoder): TOut {
    return this.inner._read(dec);
  }

  optional(): POptional<TOut> {
    // Optionality is a single presence bit; wrapping twice would change
    // nothing but make PObject's one-level unwrap miss the real node.
    return this;
  }
}
