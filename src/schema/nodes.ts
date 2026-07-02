/**
 * Schema node classes.
 *
 * Each node is an immutable, typed wrapper that produces one `EncodingOptions`
 * value (`_buildOptions()`) and does the schema-side normalization the codec does
 * not (`_normalize()`: truncate integers, reject non-finite numbers, ...).
 * `encode` / `decode` delegate to the codec via `write` / `read`.
 *
 * Because nodes are immutable (every refinement returns a fresh node), the codec
 * options are built once and memoized by `_options()`.
 */
import { Encoder } from '../encoder';
import { Decoder } from '../decoder';
import { registerAllModules } from '../modules';
import { isArray, isObject } from '../utils';
import { UTF16_RANGE } from '../constants';
import type { Charset, EncodingOptions } from '../types';
import type { InferShape } from './infer';

// Register the built-in codec modules explicitly and idempotently
// (registerAllModules skips any name already registered). Doing it here, rather
// than relying on a side-effect import of the codec barrel, keeps the schema
// layer working even if the codec imports are reordered or tree-shaken.
registerAllModules();

/** Options for length-prefixing `encodeMany` output: a non-negative integer. */
const COUNT_OPTIONS: EncodingOptions = { type: 'number', min: 0, max: false, step: 1 };

/** Base class for every schema node. `_t` is a phantom carrying the output type. */
export abstract class PNode<TOut> {
  declare readonly _t: TOut;

  private _cachedOptions?: EncodingOptions;

  /** Build the codec options for this node. Called at most once (see `_options`). */
  protected abstract _buildOptions(): EncodingOptions;

  /** Memoized codec options. Nodes are immutable, so this is computed once. */
  _options(): EncodingOptions {
    return (this._cachedOptions ??= this._buildOptions());
  }

  /** Coerce/validate a value before it reaches the codec. Default: pass through. */
  _normalize(value: unknown): unknown {
    return value;
  }

  encode(value: TOut): Uint8Array {
    const encoder = new Encoder();
    encoder.write(this._normalize(value), this._options());
    return encoder.toUint8Array();
  }

  decode(bytes: Uint8Array): TOut {
    const decoder = new Decoder(bytes);
    return decoder.read(this._options()) as TOut;
  }

  /**
   * Encode many values of this node's type into one compact, self-describing
   * buffer (length-prefixed). Far cheaper than calling `encode` per value: the
   * options are validated once and a single Encoder is reused.
   */
  encodeMany(values: TOut[]): Uint8Array {
    const encoder = new Encoder();
    encoder.write(values.length, COUNT_OPTIONS);
    if (values.length > 0) {
      encoder.write(
        values.map((v) => this._normalize(v)),
        this._options()
      );
    }
    return encoder.toUint8Array();
  }

  /** Decode a buffer produced by `encodeMany`. */
  decodeMany(bytes: Uint8Array): TOut[] {
    const decoder = new Decoder(bytes);
    const count = decoder.read(COUNT_OPTIONS) as number;
    if (count === 0) return [];
    const items = decoder.read(this._options(), count);
    // The codec unwraps a single-element read into the bare item. Re-wrap it.
    return (count === 1 ? [items] : items) as TOut[];
  }

  /** Mark this node optional. Only meaningful as a `p.object` field. */
  optional(): POptional<TOut> {
    return new POptional<TOut>(this);
  }
}

/** Wraps a node, adding the object-field presence bit. */
export class POptional<TOut> extends PNode<TOut> {
  declare readonly _optional: true;

  constructor(private readonly inner: PNode<TOut>) {
    super();
  }

  protected _buildOptions(): EncodingOptions {
    // `optional: true` is the single source of truth the object module reads to
    // emit a presence bit for this field.
    return { ...this.inner._options(), optional: true } as EncodingOptions;
  }

  _normalize(value: unknown): unknown {
    return value == null ? value : this.inner._normalize(value);
  }

  private _rejectNull(value: unknown): void {
    if (value == null) {
      throw new TypeError(
        '.optional() is only meaningful on object fields; a top-level optional cannot encode null/undefined'
      );
    }
  }

  encode(value: TOut): Uint8Array {
    this._rejectNull(value);
    // Delegate to the wrapped node so its own encode override runs (e.g. PAny's
    // single-value array wrap). The presence bit is only emitted inside an
    // object via `_options().optional`, so a top-level optional encodes exactly
    // as its inner node would.
    return this.inner.encode(value);
  }

  encodeMany(values: TOut[]): Uint8Array {
    // Keep the guard consistent with `encode`: the presence bit only exists
    // inside an object, so a null/undefined in a top-level batch is misuse.
    for (const value of values) this._rejectNull(value);
    return this.inner.encodeMany(values);
  }
}

/** Integer (truncated). `p.int` / `p.number`. */
export class PInt extends PNode<number> {
  private readonly _min: number | false;
  private readonly _max: number | false;

  constructor(min: number | false = false, max: number | false = false) {
    super();
    // number.ts requires integral bounds (so (value - min) / step stays
    // integral). Round each bound INWARD (ceil the min, floor the max) so a
    // fractional bound never widens the declared range: p.int(10.9, 100) admits
    // 11..100, not 10.
    this._min = typeof min === 'number' ? Math.ceil(min) : min;
    this._max = typeof max === 'number' ? Math.floor(max) : max;
  }

  min(n: number): PInt {
    return new PInt(n, this._max);
  }

  max(n: number): PInt {
    return new PInt(this._min, n);
  }

  protected _buildOptions(): EncodingOptions {
    // After inward rounding a fractional band can invert (e.g. p.int(2.1, 2.9)
    // -> [3, 2]) when it contains no integer. Reject it here rather than letting
    // the number module silently swap the bounds back into a WIDER range that
    // would admit values below the declared minimum.
    if (typeof this._min === 'number' && typeof this._max === 'number' && this._min > this._max) {
      throw new RangeError(
        `p.int range is empty: no integer lies within the requested bounds (rounded to [${this._min}, ${this._max}])`
      );
    }
    return { type: 'number', min: this._min, max: this._max, step: 1 };
  }

  _normalize(value: unknown): unknown {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`p.int expected a finite number, got ${String(value)}`);
    }
    // Truncate toward zero so negatives behave like positives (-3.7 -> -3).
    // `+ 0` normalizes -0 to 0 so the sign isn't lost by the codec.
    return Math.trunc(value) + 0;
  }
}

/** Decimal. Fraction-only (lossy ~1e-15, not dense). */
export class PFloat extends PNode<number> {
  constructor(private readonly _precision?: number) {
    super();
  }

  precision(n: number): PFloat {
    return new PFloat(n);
  }

  protected _buildOptions(): EncodingOptions {
    return this._precision == null
      ? { type: 'fraction' }
      : { type: 'fraction', precision: this._precision };
  }

  _normalize(value: unknown): unknown {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`p.float expected a finite number, got ${String(value)}`);
    }
    return value;
  }
}

/** UTF-16 string. Default charset is the full `[0, 65535]` range. */
export class PString extends PNode<string> {
  private readonly _charset: Charset;

  constructor(
    private readonly _max: number | false = false,
    charset: Charset = UTF16_RANGE
  ) {
    super();
    // Copy array charsets so later caller mutation can't change the node.
    this._charset = isArray(charset) ? [...charset] : charset;
  }

  max(n: number): PString {
    return new PString(n, this._charset);
  }

  charset(c: Charset): PString {
    return new PString(this._max, c);
  }

  protected _buildOptions(): EncodingOptions {
    // Copy array charsets. validateCharset may reverse them in place.
    const charset = isArray(this._charset) ? ([...this._charset] as Charset) : this._charset;
    return { type: 'string', max: this._max, charset };
  }
}

/** Boolean. */
export class PBool extends PNode<boolean> {
  protected _buildOptions(): EncodingOptions {
    return { type: 'boolean' };
  }
}

/** Enum: a fixed list of string literals, packed as a sub-byte index. */
export class PEnum<T extends string> extends PNode<T> {
  private readonly _list: readonly T[];

  constructor(list: readonly T[]) {
    super();
    if (list.length === 0) {
      throw new TypeError('p.enum requires a non-empty list');
    }
    this._list = [...list]; // copy so later caller mutation can't change the node
  }

  protected _buildOptions(): EncodingOptions {
    return { type: 'item', list: [...this._list] };
  }
}

/** Date. Default interval is 1ms (lossless). Larger intervals are lossy. */
export class PDate extends PNode<Date> {
  constructor(
    private readonly _min?: number | Date,
    private readonly _max?: number | Date,
    private readonly _interval: number | string = 1
  ) {
    super();
  }

  interval(i: number | string): PDate {
    return new PDate(this._min, this._max, i);
  }

  protected _buildOptions(): EncodingOptions {
    const options: EncodingOptions = { type: 'date', interval: this._interval };
    if (this._min != null) options.min = this._min;
    if (this._max != null) options.max = this._max;
    return options;
  }
}

/** Self-describing escape hatch. Output type `unknown`. */
export class PAny extends PNode<unknown> {
  protected _buildOptions(): EncodingOptions {
    return { type: 'any' };
  }

  encode(value: unknown): Uint8Array {
    const encoder = new Encoder();
    // Wrap in a single-element array so `write` encodes the value as ONE `any`
    // even when it is itself an array. Otherwise a top-level array would be
    // spread into N writes that `decode` (which reads one value) can't recover.
    encoder.write([this._normalize(value)], this._options());
    return encoder.toUint8Array();
  }
}

/** Object with a fixed shape. Nested objects are emitted as `{type:'object'}` leaves. */
export class PObject<S extends Record<string, PNode<any>>> extends PNode<InferShape<S>> {
  private readonly _shape: S;

  constructor(shape: S) {
    super();
    this._shape = { ...shape }; // copy so later caller mutation can't change the node
  }

  protected _buildOptions(): EncodingOptions {
    const template: Record<string, EncodingOptions> = {};
    for (const key of Object.keys(this._shape)) {
      // Each field carries its own optionality: POptional contributes
      // `optional: true`, required fields omit it. The object module defaults a
      // missing `optional` to false and never inherits the parent object's flag,
      // so a `.optional()` wrapper around a nested object can't leak optionality
      // onto that object's sub-fields.
      template[key] = this._shape[key]._options();
    }
    return { type: 'object', template };
  }

  _normalize(value: unknown): unknown {
    if (!isObject(value) || isArray(value)) {
      throw new TypeError('p.object expected an object');
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(this._shape)) {
      const v = (value as Record<string, unknown>)[key];
      // Leave absent values as-is. The object module handles the presence bit.
      out[key] = v == null ? v : this._shape[key]._normalize(v);
    }
    return out;
  }
}
