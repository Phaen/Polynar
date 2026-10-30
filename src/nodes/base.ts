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
import type { MarkerPrior } from '../predictor/session';
import type { CompressOptions } from '../predictor/types';
import type { Kind } from './guards';
import { kindMarker } from './markers';

/** One run of values, written or read one after another, each against the ones before it. */
export interface Run<T> {
  write(enc: Encoder, value: T): void;
  read(dec: Decoder): T;
}

/** Refuses, as `never`, options whose `type` names the one form `input` isn't. */
type FormOf<I, T> = [T] extends [never]
  ? unknown
  : [T] extends ['text']
    ? [I] extends [Uint8Array]
      ? never
      : unknown
    : [T] extends ['binary']
      ? [I] extends [string]
        ? never
        : unknown
      : unknown;

/** The method Node's `util.inspect`, and with it `console.log`, calls to show a value. */
const INSPECT: unique symbol = Symbol.for('nodejs.util.inspect.custom');

/** Base class for every schema node. `_t` is a phantom carrying the output type. */
export abstract class PNode<TOut> {
  declare readonly _t: TOut;

  /** Shows the node's class in place of its internals. */
  [INSPECT](): string {
    return this.constructor.name;
  }

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

  /** The options of `.compress()` on a node that codes through the predictor. */
  readonly _compress?: CompressOptions;

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
   * The node under a container's `.compress(options)`: itself where it has
   * `.compress()` or `.adapt()` already, else with `options` on itself and
   * on the nodes below it. `memo` maps each node already adapted to its
   * adapted form. Present on nodes the sugar reaches.
   */
  _adapted?(options: CompressOptions, memo: Map<PNode<any>, PNode<any>>): PNode<TOut>;

  /**
   * Whether the node or one below it codes through the predictor, so the
   * containers around it keep record and list scopes.
   */
  get _holdsCompress(): boolean {
    return this._compress !== undefined;
  }

  /**
   * The first structure symbol of `value`'s spelling, which a parent on the
   * predictor codes before the value: its kind's, as `p.any` tags it, unless
   * the node spells values otherwise. Never throws; `_write` refuses a value
   * the node does not take.
   */
  _marker(value: unknown): number {
    return kindMarker(value);
  }

  /** Every structure symbol `_marker` can return; undefined when any can. */
  _markers(): ReadonlySet<number> | undefined {
    return undefined;
  }

  /** The declared weights as prior counts of the node's structure symbols, where it has them. */
  _markerPrior(): MarkerPrior | undefined {
    return undefined;
  }

  /** Validate one value and write its digits. The whole codec for this type. */
  abstract _write(enc: Encoder, value: TOut): void;

  /** Read one value back, in the exact order `_write` produced it. */
  abstract _read(dec: Decoder): TOut;

  /** Encode to bytes, or to text when `type` is `'text'`. Both sides must agree on the options. */
  encode(value: TOut, options: CodecOptions<'text'>): string;
  encode(value: TOut, options?: CodecOptions<'binary'>): Uint8Array;
  encode(value: TOut, options?: CodecOptions<OutputType>): Uint8Array | string;
  encode(value: TOut, options?: CodecOptions<OutputType>): Uint8Array | string {
    const enc = new Encoder();
    this._write(enc, value);
    return enc.output(options);
  }

  /** Decode bytes or text produced by `encode` with the same options. */
  decode<I extends Uint8Array | string, T extends OutputType = never>(
    input: I,
    options?: DecodeOptions<T> & FormOf<I, T>
  ): TOut {
    const dec = new Decoder(input, options);
    const value = this._read(dec);
    // The schema is the whole message, so the input must be exactly consumed:
    // leftover digits and trailing padding throw.
    dec.finalize();
    return value;
  }
}

/** `node` under a container's `.compress(options)`, adapted once per `memo`. */
export function adapt<T>(
  node: PNode<T>,
  options: CompressOptions,
  memo: Map<PNode<any>, PNode<any>>
): PNode<T> {
  const done = memo.get(node);
  if (done !== undefined) {
    return done as PNode<T>;
  }
  const out = node._adapted?.(options, memo) ?? node;
  memo.set(node, out);
  return out;
}
