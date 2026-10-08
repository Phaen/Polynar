import { Encoder, Decoder, CorruptInputError } from '../packer';
import { isDate, type Kind } from './guards';
import { PNode } from './base';
import { writeIndex, readIndex } from './lattice';
import {
  resolvePrior,
  priorKind,
  cdfBucket,
  locateCdf,
  atIndexCdf,
  type Cdf,
  type Prior,
} from './weights';

export type DateUnit =
  | 'millisecond'
  | 'second'
  | 'minute'
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'year';

/** Units of one fixed length in UTC, where every day is 86 400 000 ms. */
const FIXED_MS = {
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

const WEEK_MS = 604_800_000;

/** A timestamp in an error message: ISO when it is a valid Date, else the number. */
const iso = (ts: number): string => {
  const date = new Date(ts);
  return isNaN(date.getTime()) ? String(ts) : date.toISOString();
};
/** Monday 1969-12-29 00:00 UTC, the start of the ISO week holding the epoch. */
const WEEK_ORIGIN = -259_200_000;

/**
 * A bucketing of the UTC timeline: `index` maps a timestamp to its bucket,
 * `start` maps a bucket back to the timestamp of its first instant. The bucket
 * holding 1970-01-01 is index 0 for every unit.
 */
interface Calendar {
  index(ts: number): number;
  start(index: number): number;
}

/** The first instant of a UTC month; years 0–99 stay literal instead of 1900–1999. */
const utcMonthStart = (year: number, month: number): number => {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 1);
  return date.getTime();
};

// Every valid timestamp and its offset from the week origin stay below 2^53,
// so each floored division and each in-range bucket start is exact.
const calendar = (unit: DateUnit, step: number): Calendar => {
  if (unit === 'week') {
    const size = WEEK_MS * step;
    return {
      index: (ts) => Math.floor((ts - WEEK_ORIGIN) / size),
      start: (index) => index * size + WEEK_ORIGIN,
    };
  }
  if (unit === 'month') {
    const epoch = Math.floor((1970 * 12) / step);
    return {
      index: (ts) => {
        const date = new Date(ts);
        return Math.floor((date.getUTCFullYear() * 12 + date.getUTCMonth()) / step) - epoch;
      },
      start: (index) => {
        const months = (index + epoch) * step;
        const year = Math.floor(months / 12);
        return utcMonthStart(year, months - year * 12);
      },
    };
  }
  if (unit === 'year') {
    const epoch = Math.floor(1970 / step);
    return {
      index: (ts) => Math.floor(new Date(ts).getUTCFullYear() / step) - epoch,
      start: (index) => utcMonthStart((index + epoch) * step, 0),
    };
  }
  const size = FIXED_MS[unit] * step;
  return {
    index: (ts) => Math.floor(ts / size),
    start: (index) => index * size,
  };
};

/**
 * Date, bucketed on the UTC calendar. `p.date`.
 *
 * Encoding floors a date to the start of its bucket, so the default
 * `('millisecond', 1)` is lossless and coarser precisions are lossy. Units up
 * to `day` align to the epoch, weeks start on Monday (ISO), and months and
 * years are calendar months and years. A step groups that many units, with
 * multiples aligned to the start of year 0: `('month', 3)` is calendar
 * quarters, `('year', 10)` decades. The bounds admit the buckets from min's
 * through max's, so a min inside a bucket decodes to that bucket's start,
 * before min.
 */
export class PDate extends PNode<Date> {
  readonly _kinds: readonly Kind[] = ['date'];

  private readonly _min?: number;
  private readonly _max?: number;
  private readonly _unit: DateUnit;
  private readonly _step: number;
  private readonly _calendar: Calendar;
  private readonly _lo?: number;
  private readonly _hi?: number;

  /** The prior as declared, kept so a later bound change re-validates it. */
  private readonly _prior?: Prior;
  private readonly _cdf?: Cdf;
  private readonly _total?: number;

  constructor(
    min?: number | Date,
    max?: number | Date,
    unit: DateUnit = 'millisecond',
    step = 1,
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
      throw new RangeError(
        `p.date minimum ${iso(this._min)} is after the maximum ${iso(this._max)}`
      );
    }

    if (!Number.isInteger(step) || step < 1) {
      throw new RangeError(`p.date precision step must be a positive integer, got ${step}`);
    }
    this._unit = unit;
    this._step = step;
    this._calendar = calendar(unit, step);
    this._lo = this._min === undefined ? undefined : this._calendar.index(this._min);
    this._hi = this._max === undefined ? undefined : this._calendar.index(this._max);

    if (prior !== undefined) {
      if (this._lo === undefined || this._hi === undefined) {
        throw new TypeError(`p.date ${priorKind(prior)} requires both bounds`);
      }
      this._prior = prior;
      const resolved = resolvePrior(prior, 0, this._hi - this._lo, 'p.date');
      this._cdf = resolved.cdf;
      this._total = resolved.total;
    }
  }

  min(n: number | Date): PDate {
    return this._with({ min: n });
  }

  max(n: number | Date): PDate {
    return this._with({ max: n });
  }

  /** Coarsen to buckets of `step` UTC calendar units. */
  precision(unit: DateUnit, step = 1): PDate {
    return this._with({ unit, step });
  }

  /**
   * Declare a prior over the bounded range as an integer CDF over bucket
   * indices: `fn(b)` is the cumulative weight of buckets below the b-th,
   * counted from the min bound's bucket at 0. "Recent is likelier" costs a
   * skewed fn; a zero-weight bucket cannot encode.
   */
  cdf(fn: Cdf): PDate {
    return this._with({ prior: fn });
  }

  /**
   * Declare how likely each bucket from min to max is, earliest first. Same
   * prior as `.cdf()`, given as the histogram instead of its running total.
   */
  weights(w: readonly number[]): PDate {
    return this._with({ prior: w });
  }

  _write(enc: Encoder, value: Date): void {
    if (isNaN(value.getTime())) {
      throw new TypeError(`p.date expected a valid Date, got ${String(value)}`);
    }
    const bucket = this._calendar.index(value.getTime());
    // The earliest Dates sit in a bucket that starts before the Date range,
    // so the decoder could never rebuild them.
    if (isNaN(new Date(this._calendar.start(bucket)).getTime())) {
      throw new RangeError(
        `Date '${value.toISOString()}' falls in a bucket that starts before the earliest Date`
      );
    }

    // Bounds compare buckets, so every decoded date, min's bucket start
    // included, encodes again.
    if (this._lo !== undefined && bucket < this._lo) {
      throw new RangeError(
        `Date '${value.toISOString()}' is before the minimum ${iso(this._min!)}`
      );
    }
    if (this._hi !== undefined && bucket > this._hi) {
      throw new RangeError(`Date '${value.toISOString()}' is after the maximum ${iso(this._max!)}`);
    }

    if (this._cdf === undefined) {
      writeIndex(enc, bucket, this._lo, this._hi, (b) => iso(this._calendar.start(b)));
      return;
    }
    const [cum, freq] = cdfBucket(
      this._cdf,
      bucket - this._lo!,
      'p.date',
      () => `Date '${value.toISOString()}'`
    );
    enc.composeWeighted(cum, freq, this._total!, bucket - this._lo!, this._hi! - this._lo! + 1);
  }

  _read(dec: Decoder): Date {
    const bucket =
      this._cdf === undefined
        ? readIndex(dec, this._lo, this._hi)
        : this._lo! +
          dec.parseWeighted(
            this._total!,
            locateCdf(this._cdf, 0, this._hi! - this._lo!),
            this._hi! - this._lo! + 1,
            atIndexCdf(this._cdf, 0)
          );
    const date = new Date(this._calendar.start(bucket));
    // A bucket starting beyond the ±8.64e15 ms Date range can only come from
    // a corrupted input or from a bucket that straddles the range's edge.
    if (isNaN(date.getTime())) {
      throw new CorruptInputError('Date is outside the representable time range');
    }
    return date;
  }

  private _with(change: {
    min?: number | Date;
    max?: number | Date;
    unit?: DateUnit;
    step?: number;
    prior?: Prior;
  }): PDate {
    return new PDate(
      change.min ?? this._min,
      change.max ?? this._max,
      change.unit ?? this._unit,
      change.step ?? this._step,
      change.prior ?? this._prior
    );
  }
}
