import { Encoder, Decoder, CorruptInputError } from '../packer';
import { isDate } from './guards';
import { PNode } from './base';
import { writeIndex, readIndex } from './lattice';
import { validateCdf, cdfBucket, locateCdf, type Cdf } from './weights';

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
  private readonly _min?: number;
  private readonly _max?: number;
  private readonly _interval: number;

  /** The user's timestamp-domain cdf and its bucket-domain adapter. */
  private readonly _cdf?: Cdf;
  private readonly _bucketCdf?: Cdf;
  private readonly _total?: number;

  constructor(
    min?: number | Date,
    max?: number | Date,
    interval: number | DateInterval = 1,
    cdf?: Cdf
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
      if (!(interval in DATE_INTERVALS)) {
        throw new TypeError('Invalid date interval');
      }
      interval = DATE_INTERVALS[interval as DateInterval];
    }
    // The interval is a divisor (ms per bucket). 0/negative/non-integer values
    // have no coherent meaning and an interval of 0 would divide by zero.
    if (typeof interval !== 'number' || !(interval > 0) || interval % 1 !== 0) {
      throw new TypeError('Invalid date interval');
    }
    this._interval = interval;
    // No span guard here: it would depend on the interval, which a chained
    // `.interval()` sets only after the bounds construct intermediate nodes.
    // The quantization check in `_write` catches drift per value instead.

    if (cdf !== undefined) {
      if (this._min === undefined || this._max === undefined) {
        throw new TypeError('p.date cdf requires both bounds');
      }
      const base = this._min;
      const interval = this._interval;
      const rebased = validateCdf(
        (bucket: number) => cdf(base + bucket * interval),
        0,
        this._bucketMax()!,
        'p.date'
      );
      this._bucketCdf = rebased.cdf;
      this._total = rebased.total;
      this._cdf = cdf;
    }
  }

  min(n: number | Date): PDate {
    return new PDate(n, this._max, this._interval, this._cdf);
  }

  max(n: number | Date): PDate {
    return new PDate(this._min, n, this._interval, this._cdf);
  }

  interval(i: number | DateInterval): PDate {
    return new PDate(this._min, this._max, i, this._cdf);
  }

  /**
   * Declare a prior over the bounded range as an integer CDF over
   * TIMESTAMPS: `fn(t)` is the cumulative weight of buckets starting below
   * `t` ms, evaluated at exact bucket starts. "Recent is likelier" costs a
   * skewed fn; a zero-weight bucket cannot encode.
   */
  cdf(fn: Cdf): PDate {
    return new PDate(this._min, this._max, this._interval, fn);
  }

  _write(enc: Encoder, value: Date): void {
    if (!isDate(value) || isNaN(value.getTime())) {
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

    if (this._bucketCdf === undefined) {
      writeIndex(enc, bucket, this._bucketMin(), this._bucketMax());
      return;
    }
    const [cum, freq] = cdfBucket(this._bucketCdf, bucket, 'p.date');
    enc.composeWeighted(cum, freq, this._total!);
  }

  _read(dec: Decoder): Date {
    const base = this._min ?? 0;
    const bucket =
      this._bucketCdf === undefined
        ? readIndex(dec, this._bucketMin(), this._bucketMax())
        : dec.parseWeighted(this._total!, locateCdf(this._bucketCdf, 0, this._bucketMax()!));
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
