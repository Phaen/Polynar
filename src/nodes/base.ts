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
import { Encoder, Decoder } from '../packer';
import type { CodecOptions, DecodeOptions, OutputType } from '../packer';
import type { Kind } from './guards';
import type { Learning } from './adaptive';
import type { MethodName } from './methods';

/** One run of values, written or read one after another, each against the ones before it. */
export interface Run<T> {
  write(enc: Encoder, value: T): void;
  read(dec: Decoder): T;
}

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
   * Set when the node writes exactly one `compose(digit, _radix)` and reads
   * exactly one `parse(_radix)`, `_fromDigit` mapping the digit to its value
   * without throwing. Containers then read runs of such values with one
   * `parseMany`.
   */
  readonly _radix?: number;

  /** The value a digit read in `_radix` stands for; present whenever `_radix` is. */
  _fromDigit?(digit: number): TOut;

  /**
   * The digit `_write` composes for `value`, throwing exactly as `_write`
   * would; present whenever `_radix` is. Digits follow the node's value
   * order, which lets containers code ascending or distinct runs of values
   * by their digits.
   */
  _toDigit?(value: TOut): number;

  /**
   * A run of the node's values, which containers code ascending by JS `<`
   * when their order is restricted, each value written against the run's
   * earlier ones; distinct by `<` and `>` when `unique`. Present on nodes
   * that spell such a run in less than its values one by one.
   */
  _run?(unique: boolean): Run<TOut>;

  /**
   * Whether the node can write `undefined`, which lets an object leave the
   * field's key out. Read off `_kinds`, and true when they are undeclared:
   * a custom node is trusted, matching the types, where a key is optional
   * whenever its value type includes `undefined`.
   */
  _takesUndefined(): boolean {
    return this._kinds === undefined ? true : this._kinds.includes('undefined');
  }

  /**
   * Whether every value the node writes reads back as the same value, -0
   * as 0 aside, so a field's companions may take a value as the decoder
   * will get it without reading it back. False unless a node says so, as
   * one that rounds, floors or otherwise changes values must not.
   */
  get _exact(): boolean {
    return false;
  }

  /**
   * The node as `.adaptive(options)` leaves it, any of its methods named in
   * `except` left as they are: how `p.any` adapts the nodes it builds and
   * its hints. Present on nodes that adapt.
   */
  _open?(options: Learning, except?: readonly MethodName[]): PNode<TOut>;

  /** Validate one value and write its digits. The whole codec for this type. */
  abstract _write(enc: Encoder, value: TOut): void;

  /** Read one value back, in the exact order `_write` produced it. */
  abstract _read(dec: Decoder): TOut;

  /** Encode to bytes, or to text when `type` is `'text'`. Both sides must agree on the options. */
  encode(value: TOut, options: CodecOptions<'text'> & { type: 'text' }): string;
  encode(value: TOut, options?: CodecOptions<'binary'>): Uint8Array;
  encode(value: TOut, options?: CodecOptions<OutputType>): Uint8Array | string;
  encode(value: TOut, options?: CodecOptions<OutputType>): Uint8Array | string {
    const enc = new Encoder();
    this._write(enc, value);
    return enc.output(options);
  }

  /** Decode bytes or text produced by `encode` with the same options. */
  decode<I extends Uint8Array | string>(
    input: I,
    options?: DecodeOptions<
      I extends string ? 'text' : I extends Uint8Array ? 'binary' : OutputType
    >
  ): TOut {
    const dec = new Decoder(input, options);
    const value = this._read(dec);
    // The schema is the whole message, so the input must be exactly consumed:
    // leftover digits and trailing padding throw.
    dec.finalize();
    return value;
  }
}
