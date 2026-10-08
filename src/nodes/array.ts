import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { atPath } from './path';
import type { Kind } from './guards';
import { writeIndex, readIndex } from './lattice';
import { resolvePrior, priorKind, cdfBucket, locateCdf, type Cdf, type Prior } from './weights';

/** Count constraints for an array node: min/max bounds, or a fixed length. */
interface ArrayBounds {
  min?: number;
  max?: number;
  length?: number;
  prior?: Prior;
}

/**
 * Array of one item type. The count travels through the shared integer
 * lattice with bounds `[min ?? 0, max]`: unbounded counts are term-prefixed,
 * bounded counts pack against their range, and a fixed `.length(n)` collapses
 * the range to one state — the count then costs zero bits on the wire.
 */
export class PArray<TItem> extends PNode<TItem[]> {
  readonly _kinds: readonly Kind[] = ['array'];

  private readonly _item: PNode<TItem>;
  private readonly _min?: number;
  private readonly _max?: number;
  private readonly _length?: number;
  /** The prior as declared, kept so a later bound change re-validates it. */
  private readonly _prior?: Prior;
  /** A prior over the item count; undefined means uniform. */
  private readonly _cdf?: Cdf;
  private readonly _total?: number;

  constructor(item: PNode<TItem>, bounds: ArrayBounds = {}) {
    super();
    this._item = item;

    // A fixed length IS both bounds; combining the two spellings is a
    // contradiction, so it throws instead of silently merging.
    if (bounds.length != null && (bounds.min != null || bounds.max != null)) {
      throw new TypeError('p.array length cannot be combined with min or max');
    }

    if (bounds.length != null) {
      // No inward rounding here: no count satisfies a fractional length, so
      // either rounding direction would invent a contract never declared.
      if (!Number.isInteger(bounds.length) || bounds.length < 0) {
        throw new RangeError(
          `p.array length must be a non-negative integer count, got ${bounds.length}`
        );
      }
      this._length = bounds.length;
    }
    // Like p.int bounds, round each bound INWARD (ceil the min, floor the
    // max) so a fractional bound never admits a count beyond itself.
    if (bounds.min != null) {
      this._min = Math.ceil(bounds.min);
      if (!Number.isInteger(this._min) || this._min < 0) {
        throw new RangeError(`p.array min must be a non-negative count, got ${bounds.min}`);
      }
    }
    if (bounds.max != null) {
      this._max = Math.floor(bounds.max);
      if (!Number.isInteger(this._max) || this._max < 0) {
        throw new RangeError(`p.array max must be a non-negative count, got ${bounds.max}`);
      }
    }
    if (this._min !== undefined && this._max !== undefined && this._min > this._max) {
      throw new RangeError(`p.array range is empty: min ${this._min} exceeds max ${this._max}`);
    }

    const prior = bounds.prior;
    if (prior !== undefined) {
      if (this._length !== undefined) {
        throw new TypeError(`p.array ${priorKind(prior)} is meaningless on a fixed length`);
      }
      if (this._max === undefined) {
        throw new TypeError(`p.array ${priorKind(prior)} requires a max count`);
      }
      this._prior = prior;
      const resolved = resolvePrior(prior, this._countMin(), this._max, 'p.array');
      this._cdf = resolved.cdf;
      this._total = resolved.total;
    }
  }

  /** Require at least `n` items. A raised floor packs the count denser. */
  min(n: number): PArray<TItem> {
    return new PArray<TItem>(this._item, {
      min: n,
      max: this._max,
      length: this._length,
      prior: this._prior,
    });
  }

  /** Cap the item count. A capped count packs denser than the uncapped prefix. */
  max(n: number): PArray<TItem> {
    return new PArray<TItem>(this._item, {
      min: this._min,
      max: n,
      length: this._length,
      prior: this._prior,
    });
  }

  /** Fix the exact item count. The count then costs zero bits on the wire. */
  length(n: number): PArray<TItem> {
    return new PArray<TItem>(this._item, { min: this._min, max: this._max, length: n });
  }

  /**
   * Declare a prior over the item COUNT as an integer CDF: `fn(n)` is the
   * cumulative weight of counts below `n`. Requires a max; a zero-weight
   * count cannot encode.
   */
  cdf(fn: Cdf): PArray<TItem> {
    return new PArray<TItem>(this._item, {
      min: this._min,
      max: this._max,
      length: this._length,
      prior: fn,
    });
  }

  /**
   * Declare how likely each count from min (or 0) to max is, lowest first.
   * Same prior as `.cdf()`, given as the histogram instead of its running
   * total.
   */
  weights(w: readonly number[]): PArray<TItem> {
    return new PArray<TItem>(this._item, {
      min: this._min,
      max: this._max,
      length: this._length,
      prior: w,
    });
  }

  _write(enc: Encoder, value: TItem[]): void {
    const count = value.length;

    if (this._length !== undefined && count !== this._length) {
      throw new RangeError(`Array length ${count} differs from the fixed length ${this._length}`);
    }
    if (this._min !== undefined && count < this._min) {
      throw new RangeError(`Array length ${count} is below the minimum ${this._min}`);
    }
    if (this._max !== undefined && count > this._max) {
      throw new RangeError(`Array length ${count} is above the maximum ${this._max}`);
    }

    if (this._cdf === undefined) {
      writeIndex(enc, count, this._countMin(), this._countMax());
    } else {
      const [cum, freq] = cdfBucket(this._cdf, count, 'p.array', () => `Array length ${count}`);
      enc.composeWeighted(cum, freq, this._total!);
    }

    // Indexed iteration, not for-of over holes: a sparse array's holes read as
    // undefined and must fail the item's own validation rather than be skipped,
    // or the element count would desync from the length prefix.
    let i = 0;
    try {
      for (; i < count; i++) {
        this._item._write(enc, value[i]);
      }
    } catch (error) {
      throw atPath(error, i);
    }
  }

  _read(dec: Decoder): TItem[] {
    const count =
      this._cdf === undefined
        ? readIndex(dec, this._countMin(), this._countMax())
        : dec.parseWeighted(this._total!, locateCdf(this._cdf, this._countMin(), this._max!));
    const value: TItem[] = [];
    for (let i = 0; i < count; i++) {
      value.push(this._item._read(dec));
    }
    return value;
  }

  /** A count is never negative, so the lattice floor defaults to 0. */
  private _countMin(): number {
    return this._length ?? this._min ?? 0;
  }

  private _countMax(): number | undefined {
    return this._length ?? this._max;
  }
}
