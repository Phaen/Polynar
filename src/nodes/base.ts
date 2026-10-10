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
import type { CodecOptions } from '../packer';
import type { Kind } from './guards';
import { buildWeights, writeTable, readTable, type WeightTable } from './weights';

/** Base class for every schema node. `_t` is a phantom carrying the output type. */
export abstract class PNode<TOut> {
  declare readonly _t: TOut;

  /**
   * The JS kinds this node's values can have, which `p.union` uses to pick a
   * member. Undefined means undeclared: a custom node sets it to be usable in
   * a union.
   */
  readonly _kinds?: readonly Kind[];

  /**
   * Whether the node can write `undefined`, which lets an object leave the
   * field's key out. Read off `_kinds`; a custom node that returns
   * `undefined` overrides it.
   */
  _takesUndefined(): boolean {
    return this._kinds?.includes('undefined') ?? false;
  }

  /** Validate one value and write its digits. The whole codec for this type. */
  abstract _write(enc: Encoder, value: TOut): void;

  /** Read one value back, in the exact order `_write` produced it. */
  abstract _read(dec: Decoder): TOut;

  /** Encode to bytes, or to text when `type` is `'text'`. Both sides must agree on the options. */
  encode(value: TOut, options: CodecOptions<'text'> & { type: 'text' }): string;
  encode(value: TOut, options?: CodecOptions<'binary'>): Uint8Array;
  encode(value: TOut, options?: CodecOptions): Uint8Array | string;
  encode(value: TOut, options?: CodecOptions): Uint8Array | string {
    const enc = new Encoder();
    this._write(enc, value);
    return enc.output(options);
  }

  /** Decode bytes or text produced by `encode` with the same options. */
  decode(input: Uint8Array, options?: CodecOptions<'binary'>): TOut;
  decode(input: string, options?: CodecOptions<'text'>): TOut;
  decode(input: Uint8Array | string, options?: CodecOptions): TOut {
    const dec =
      typeof input === 'string'
        ? new Decoder(input, options as CodecOptions<'text'>)
        : new Decoder(input, options as CodecOptions<'binary'>);
    const value = this._read(dec);
    // The schema is the whole message, so the input must be exactly consumed:
    // leftover digits and trailing padding throw.
    dec.finalize();
    return value;
  }
}

/**
 * A value or `undefined`, at the cost of one presence bit. `p.optional`.
 * Only `undefined` means absent; `null` reaches the inner node.
 */
export class POptional<TOut> extends PNode<TOut | undefined> {
  /**
   * The inner node's kinds plus `'undefined'`, or undeclared when the inner
   * node is, so an optional node is a union member whenever its inner node is.
   */
  declare readonly _kinds?: readonly Kind[];

  /** A prior as `[present, absent]` weights; undefined means one bit. */
  private readonly _weights?: WeightTable;

  constructor(
    readonly inner: PNode<TOut>,
    weights?: readonly [number, number]
  ) {
    super();
    if (inner._kinds !== undefined) {
      this._kinds = [...new Set<Kind>([...inner._kinds, 'undefined'])];
    }
    if (weights !== undefined) {
      this._weights = buildWeights(weights, 2, 'p.optional');
    }
  }

  _takesUndefined(): boolean {
    return true;
  }

  /**
   * Declare how likely the value is to be there, as `[present, absent]`
   * weights: a 99%-present value costs ~0.015 bits instead of a full bit.
   * A prior, not a constraint, and part of the wire format.
   */
  weights(w: readonly [number, number]): POptional<TOut> {
    return new POptional<TOut>(this.inner, w);
  }

  _write(enc: Encoder, value: TOut | undefined): void {
    if (this._weights === undefined) {
      // The plain bit is 1 for present, 0 for absent.
      enc.compose(value === undefined ? 0 : 1, 2);
    } else {
      writeTable(enc, this._weights, value === undefined ? 1 : 0);
    }
    if (value !== undefined) {
      this.inner._write(enc, value);
    }
  }

  _read(dec: Decoder): TOut | undefined {
    const there =
      this._weights === undefined ? dec.parse(2) === 1 : readTable(dec, this._weights) === 0;
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
