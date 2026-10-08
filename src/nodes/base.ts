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
 * `p.array` and `p.optional` like any built-in; declaring `_kinds` makes it
 * a valid `p.union` member too.
 */
import { Encoder, Decoder, CorruptInputError } from '../packer';
import type { Charset, ByteRange } from '../packer';
import type { Kind } from './guards';

/** Base class for every schema node. `_t` is a phantom carrying the output type. */
export abstract class PNode<TOut> {
  declare readonly _t: TOut;

  /**
   * The JS kinds this node's values can have, which `p.union` uses to pick a
   * member. Undefined means undeclared: a custom node sets it to be usable in
   * a union.
   */
  readonly _kinds?: readonly Kind[];

  /** Validate one value and write its digits. The whole codec for this type. */
  abstract _write(enc: Encoder, value: TOut): void;

  /** Read one value back, in the exact order `_write` produced it. */
  abstract _read(dec: Decoder): TOut;

  /** Encode to bytes. A `[min, max]` range restricts which byte values appear. */
  encode(value: TOut, range?: ByteRange): Uint8Array {
    const enc = new Encoder();
    this._write(enc, value);
    return enc.toUint8Array(range);
  }

  /** Decode bytes produced by `encode` with the same range. */
  decode(bytes: Uint8Array, range?: ByteRange): TOut {
    const dec = new Decoder(bytes, range);
    const value = this._read(dec);
    // The schema is the whole message, so the input must be exactly consumed:
    // leftover digits and trailing padding throw.
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
}

/**
 * A value or `undefined`, at the cost of one presence bit. `p.optional`.
 * Only `undefined` means absent; `null` reaches the inner node.
 */
export class POptional<TOut> extends PNode<TOut | undefined> {
  declare readonly _optional: true;

  /**
   * The inner node's kinds plus `'undefined'`, or undeclared when the inner
   * node is, so an optional node is a union member whenever its inner node is.
   */
  declare readonly _kinds?: readonly Kind[];

  /** A prior on presence as `[absent, present]`; undefined means one bit. */
  readonly presence?: readonly [number, number];

  constructor(
    readonly inner: PNode<TOut>,
    presence?: readonly [number, number]
  ) {
    super();
    if (inner._kinds !== undefined) {
      this._kinds = [...new Set<Kind>([...inner._kinds, 'undefined'])];
    }
    if (presence !== undefined) {
      const [absent, present] = presence;
      if (
        !Number.isInteger(absent) ||
        !Number.isInteger(present) ||
        absent < 1 ||
        present < 1 ||
        !Number.isSafeInteger(absent + present)
      ) {
        throw new TypeError(
          `p.optional weights must be positive integers [absent, present], got [${absent}, ${present}]`
        );
      }
      this.presence = [absent, present];
    }
  }

  /**
   * Declare how likely the value is to be there, as `[absent, present]`
   * weights: a 99%-present value costs ~0.015 bits instead of a full bit.
   * A prior, not a constraint, and part of the wire format.
   */
  weights(w: readonly [number, number]): POptional<TOut> {
    return new POptional<TOut>(this.inner, w);
  }

  _write(enc: Encoder, value: TOut | undefined): void {
    const presence = this.presence;
    if (value === undefined) {
      if (presence === undefined) {
        enc.compose(0, 2);
      } else {
        enc.composeWeighted(0, presence[0], presence[0] + presence[1], 0, 2);
      }
      return;
    }
    if (presence === undefined) {
      enc.compose(1, 2);
    } else {
      enc.composeWeighted(presence[0], presence[1], presence[0] + presence[1], 1, 2);
    }
    this.inner._write(enc, value);
  }

  _read(dec: Decoder): TOut | undefined {
    const presence = this.presence;
    const there =
      presence === undefined
        ? dec.parse(2) === 1
        : dec.parseWeighted(
            presence[0] + presence[1],
            (r) => (r < presence[0] ? [false, 0, presence[0]] : [true, presence[0], presence[1]]),
            2,
            (i) => (i === 0 ? [false, 0, presence[0]] : [true, presence[0], presence[1]])
          );
    if (!there) {
      return undefined;
    }
    const value = this.inner._read(dec);
    // `undefined` is spelled by the absent bit, so a present value decoding
    // to it (an inner `any`'s undefined tag) has no canonical encoding.
    if (value === undefined) {
      throw new CorruptInputError(
        'Present optional value decoded as undefined, which is not encodable'
      );
    }
    return value;
  }
}
