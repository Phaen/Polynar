import { Encoder, Decoder, CorruptInputError } from '../packer';
import { isDate, type Kind } from './guards';
import { PNode } from './base';
import { writeIndex, readIndex } from './lattice';
import { resolvePrior, priorKind, cdfBucket, locateCdf, type Cdf, type Prior } from './weights';

/**
 * Named date intervals in milliseconds. `month` is the mean Gregorian month
 * (30.4375 days) and `year` is twelve of them (365.25 days) — fixed-length
 * approximations for bucketing, not calendar arithmetic.
 */
export const DATE_INTERVALS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_800_000,
  year: 31_557_600_000,
} as const;

export type DateInterval = keyof typeof DATE_INTERVALS;

/** Date. Default interval is 1ms (lossless); larger intervals are lossy. `p.date`. */
export class PDate extends PNode<Date> {
  readonly _kinds: readonly Kind[] = ['date'];

  private readonly _min?: number;
  private readonly _max?: number;
  private readonly _interval: number;

  /** The prior as declared, kept so a later bound change re-validates it. */
  private readonly _prior?: Prior;
  private readonly _cdf?: Cdf;
  private readonly _total?: number;

  constructor(
    min?: number | Date,
    max?: number | Date,
    interval: number | DateInterval = 1,
    prior?: Prior
  ) {
    super();
    this._min = isDate(min) ? min.getTime() : (min ?? undefined);
    this._max = isDate(max) ? max.getTime() : (max ?? undefined);

    if (
      (this._min !== undefined && !Number.isInteger(this._min)) ||
      (this._max !== undefined && !Number.isInteger(this._max))
    ) {
      throw new TypeError('p.date bounds must be Dates or integer timestamps');
    }
    // Swapping the bounds silently would accept dates before the declared
    // minimum and reject dates the caller declared valid.
    if (this._min !== undefined && this._max !== undefined && this._min > this._max) {
      throw new RangeError('p.date minimum exceeds maximum');
    }

    if (typeof interval === 'string') {
      interval = DATE_INTERVALS[interval];
    }
    // The interval is a divisor (ms per bucket). 0/negative/non-integer values
    // have no coherent meaning and an interval of 0 would divide by zero.
    if (!(interval > 0) || interval % 1 !== 0) {
      throw new TypeError('Invalid date interval');
    }
    this._interval = interval;
    // No span guard here: it would depend on the interval, which a chained
    // `.interval()` sets only after the bounds construct intermediate nodes.
    // The quantization check in `_write` catches drift per value instead.

    if (prior !== undefined) {
      if (this._min === undefined || this._max === undefined) {
        throw new TypeError(`p.date ${priorKind(prior)} requires both bounds`);
      }
      this._prior = prior;
      const resolved = resolvePrior(prior, 0, this._bucketMax()!, 'p.date');
      this._cdf = resolved.cdf;
      this._total = resolved.total;
    }
  }

  min(n: number | Date): PDate {
    return new PDate(n, this._max, this._interval, this._prior);
  }

  max(n: number | Date): PDate {
    return new PDate(this._min, n, this._interval, this._prior);
  }

  interval(i: number | DateInterval): PDate {
    return new PDate(this._min, this._max, i, this._prior);
  }

  /**
   * Declare a prior over the bounded range as an integer CDF over bucket
   * indices: `fn(b)` is the cumulative weight of buckets below the b-th,
   * counted from the min bound's bucket at 0. "Recent is likelier" costs a
   * skewed fn; a zero-weight bucket cannot encode.
   */
  cdf(fn: Cdf): PDate {
    return new PDate(this._min, this._max, this._interval, fn);
  }

  /**
   * Declare how likely each bucket from min to max is, earliest first. Same
   * prior as `.cdf()`, given as the histogram instead of its running total.
   */
  weights(w: readonly number[]): PDate {
    return new PDate(this._min, this._max, this._interval, w);
  }

  _write(enc: Encoder, value: Date): void {
    if (isNaN(value.getTime())) {
      throw new TypeError(`p.date expected a valid Date, got ${String(value)}`);
    }
    const timestamp = value.getTime();

    if (this._min !== undefined && timestamp < this._min) {
      throw new RangeError(`Date '${value.toISOString()}' is before the minimum bound`);
    }
    if (this._max !== undefined && timestamp > this._max) {
      throw new RangeError(`Date '${value.toISOString()}' is after the maximum bound`);
    }

    // Quantize relative to the min bound (or epoch when unbounded below).
    // Anchoring at min guarantees every in-range date is representable AND
    // that no decoded date falls below the declared minimum. Buckets count
    // from 0 when a min exists, so the index bounds are [0, maxBucket].
    const base = this._min ?? 0;
    const bucket = Math.floor((timestamp - base) / this._interval);

    // The bucket must land within one interval below the timestamp; float
    // drift in the offset arithmetic past 2^53 would miss that silently.
    const reconstructed = base + bucket * this._interval;
    if (reconstructed > timestamp || timestamp - reconstructed >= this._interval) {
      throw new RangeError(
        `Date '${value.toISOString()}' is too far from its bound to quantize exactly`
      );
    }

    if (this._cdf === undefined) {
      writeIndex(enc, bucket, this._bucketMin(), this._bucketMax());
      return;
    }
    const [cum, freq] = cdfBucket(this._cdf, bucket, 'p.date');
    enc.composeWeighted(cum, freq, this._total!);
  }

  _read(dec: Decoder): Date {
    const base = this._min ?? 0;
    const bucket =
      this._cdf === undefined
        ? readIndex(dec, this._bucketMin(), this._bucketMax())
        : dec.parseWeighted(this._total!, locateCdf(this._cdf, 0, this._bucketMax()!));
    const date = new Date(base + bucket * this._interval);
    // A bucket beyond the ±8.64e15 ms Date range can only come from a
    // corrupted input; the encoder requires a valid Date.
    if (isNaN(date.getTime())) {
      throw new CorruptInputError('Date is outside the representable time range');
    }
    return date;
  }

  private _bucketMin(): number | undefined {
    return this._min === undefined ? undefined : 0;
  }

  private _bucketMax(): number | undefined {
    return this._max === undefined
      ? undefined
      : Math.floor((this._max - (this._min ?? 0)) / this._interval);
  }
}
