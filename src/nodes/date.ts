import { Encoder, Decoder, CorruptInputError } from '../packer';
import { isDate, type Kind } from './guards';
import { PNode } from './base';
import { describe } from './path';
import { IndexMethods, IndexRange, checkUnset } from './lattice';
import type { Cdf, Prior } from './weights';
import type { AdaptiveOptions } from './adaptive';
import { withMethod, type Spelling } from './methods';

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

/**
 * A timestamp in an error message: ISO when it is a valid Date, else the
 * number, as for the start of a bucket that straddles the earliest Date.
 */
export const iso = (ts: number): string => {
  const date = new Date(ts);
  return isNaN(date.getTime()) ? String(ts) : date.toISOString();
};
/** The largest timestamp magnitude a Date holds. */
const MAX_TIMESTAMP = 8.64e15;

/** Refuses a bound outside the Date range; NaN lies outside it too. */
export const checkInRange = (bound: number | undefined, which: string): void => {
  if (bound !== undefined && !(Math.abs(bound) <= MAX_TIMESTAMP)) {
    throw new RangeError(`p.date ${which} ${bound} is outside the Date range ±${MAX_TIMESTAMP}`);
  }
};

/** Monday 1969-12-29 00:00 UTC, the start of the ISO week holding the epoch. */
const WEEK_ORIGIN = -259_200_000;

/**
 * A bucketing of the UTC timeline: `index` maps a timestamp to its bucket,
 * `start` maps a bucket back to the timestamp of its first instant. The bucket
 * holding 1970-01-01 is index 0 for every unit. `index` takes a valid Date
 * timestamp, as PDate checks before asking; `start` takes any integer index
 * and gives a timestamp that may lie outside the Date range, NaN for months
 * and years past it.
 */
export interface Calendar {
  index(ts: number): number;
  start(index: number): number;
}

/**
 * The first instant of a UTC month; years 0–99 stay literal instead of
 * 1900–1999. A month outside 0–11 rolls into a neighbouring year, a
 * fractional year or month counts its whole part, and a month outside the
 * Date range is NaN, all as `Date.setUTCFullYear` does.
 */
export const utcMonthStart = (year: number, month: number): number => {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 1);
  return date.getTime();
};

// Every valid timestamp and its offset from the week origin stay below 2^53,
// so each floored division and each in-range bucket start is exact.
export const calendar = (unit: DateUnit, step: number): Calendar => {
  if (!Number.isInteger(step) || step < 1) {
    throw new RangeError(`p.date precision step must be a positive integer, got ${step}`);
  }
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
  /** Bucket indices on the UTC calendar, the epoch's bucket at 0. */
  private readonly _range: IndexRange;
  private readonly _spelling: Spelling;
  private readonly _methods: IndexMethods;
  declare readonly _radix?: number;

  constructor(
    min?: number | Date,
    max?: number | Date,
    unit: DateUnit = 'millisecond',
    step = 1,
    prior?: Prior,
    adaptive?: AdaptiveOptions,
    spelling: Spelling = {}
  ) {
    super();
    this._min = isDate(min) ? min.getTime() : min;
    this._max = isDate(max) ? max.getTime() : max;

    if (
      (this._min !== undefined && !Number.isInteger(this._min)) ||
      (this._max !== undefined && !Number.isInteger(this._max))
    ) {
      throw new TypeError('p.date bounds must be Dates or integer timestamps');
    }
    // Bounds lie within the Date range, like the dates they admit.
    checkInRange(this._min, 'min');
    checkInRange(this._max, 'max');
    // Two bounds in one bucket compare equal there, so an inverted pair is
    // caught on the raw timestamps.
    if (this._min !== undefined && this._max !== undefined && this._min > this._max) {
      throw new RangeError(
        `p.date range is empty: min ${iso(this._min)} exceeds max ${iso(this._max)}`
      );
    }

    this._unit = unit;
    this._step = step;
    this._calendar = calendar(unit, step);
    // Bounds compare buckets, so every decoded date, min's bucket start
    // included, encodes again.
    const lo = this._min === undefined ? undefined : this._calendar.index(this._min);
    const hi = this._max === undefined ? undefined : this._calendar.index(this._max);
    this._range = new IndexRange('p.date', lo, hi, prior, adaptive, (b) =>
      iso(this._calendar.start(b))
    );
    this._spelling = spelling;
    this._methods = new IndexMethods(this._range, spelling, 'p.date');
    // Bucket starts rise with the index and none starts after its bound,
    // which lies within the Date range, so when the first bucket starts
    // within it every bucket does, and reading a digit cannot fail. Only a
    // first bucket straddling the earliest Date starts before it.
    const fromDigit = this._range.fromDigit;
    if (
      this._methods.plain &&
      lo !== undefined &&
      fromDigit !== undefined &&
      !isNaN(new Date(this._calendar.start(lo)).getTime())
    ) {
      this._radix = this._range.radix;
      this._fromDigit = (digit) => new Date(this._calendar.start(fromDigit(digit)));
      const toDigit = this._range.toDigit;
      if (toDigit !== undefined) {
        this._toDigit = (value) =>
          toDigit(this._bucket(value), () => `Date ${value.toISOString()}`);
      }
    }
  }

  min(n: number | Date): PDate {
    checkUnset(this._min, 'p.date', 'min');
    return this._with({ min: n });
  }

  max(n: number | Date): PDate {
    checkUnset(this._max, 'p.date', 'max');
    return this._with({ max: n });
  }

  /** Coarsen to buckets of `step` UTC calendar units. */
  precision(unit: DateUnit, step = 1): PDate {
    return this._with({ unit, step });
  }

  /**
   * Declare a prior over the bounded range as an integer CDF over bucket
   * indices: `fn(b)` is the cumulative weight of buckets below the b-th,
   * counted on the UTC calendar with the epoch's bucket at 0, as p.int's
   * cdf gets the value itself. "Recent is likelier" costs a skewed fn; a
   * zero-weight bucket cannot encode.
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

  /**
   * Let the prior over the bounded range learn from the message: the declared
   * weights, or even ones when none are, are the starting point, and each
   * bucket coded counts as one observation, so a bucket that keeps recurring
   * gets cheaper as the message goes on. `window` is how many observations the
   * counts hold before they halve, so the newest weigh most (1024 when left
   * out, and raised to the number of values it counts when smaller). From its
   * second value on, the node spends one bit to stay static, or a few to name
   * the learning rate that paid off. Takes weights, not a cdf; part of the wire
   * format, like the weights. A range unbounded or wider than 65536 buckets
   * learns on the magnitude scale instead: buckets from the min's, else the
   * max's, else the epoch's, by bit-length class. From the second value on,
   * unless `.delta()` is declared, each value also spends a learned mode
   * symbol naming whether it is spelled plainly or as its difference from
   * the previous value, whichever the encoder prices cheaper.
   * Unless `.recall()` is declared, a value the node already wrote may
   * also be recalled as under it, at learned odds, whenever that costs
   * less than spelling it.
   */
  adaptive(options?: AdaptiveOptions): PDate {
    return this._with({ adaptive: options ?? {} });
  }

  /**
   * Spell every date after the node's first in the message as its
   * difference in buckets from the previous one: its side, unless the
   * bounds rule one out, the bit-length class of its size among the classes
   * the bounds reach, equally likely or learned under `.adaptive()`, then
   * the low bits. Timestamps a few seconds apart cost a few bits plus the
   * gap's own, bounded or not. The node's first date costs its plain
   * spelling. Takes no weights or cdf.
   */
  delta(): PDate {
    return this._with({ spelling: withMethod(this._spelling, 'delta', 'p.date') });
  }

  /**
   * Spell a date this node already wrote in the message by its place among
   * the distinct buckets it wrote, and a new one as an escape and then as
   * the node otherwise spells it: with n buckets seen, a repeat costs
   * log2(n + 1) bits, or under `.adaptive()` less the more often it
   * recurs. The message's first date costs nothing extra; a repeat decodes
   * as a new Date.
   */
  recall(): PDate {
    return this._with({ spelling: withMethod(this._spelling, 'recall', 'p.date') });
  }

  _write(enc: Encoder, value: Date): void {
    this._methods.write(enc, this._bucket(value), () => `Date ${value.toISOString()}`);
  }

  /** The bucket of `value`, refused when it is invalid or the decoder could not rebuild it. */
  private _bucket(value: Date): number {
    if (isNaN(value.getTime())) {
      throw new TypeError(`p.date expected a valid Date, got ${describe(value)}`);
    }
    const bucket = this._calendar.index(value.getTime());
    // The earliest Dates sit in a bucket that starts before the Date range,
    // so the decoder could never rebuild them.
    if (isNaN(new Date(this._calendar.start(bucket)).getTime())) {
      throw new RangeError(
        `Date ${value.toISOString()} falls in a bucket that starts before the earliest Date`
      );
    }
    return bucket;
  }

  _read(dec: Decoder): Date {
    const bucket = this._methods.read(dec);
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
    adaptive?: AdaptiveOptions;
    spelling?: Spelling;
  }): PDate {
    return new PDate(
      change.min ?? this._min,
      change.max ?? this._max,
      change.unit ?? this._unit,
      change.step ?? this._step,
      change.prior ?? this._range.declared,
      change.adaptive ?? this._range.adaptive,
      change.spelling ?? this._spelling
    );
  }
}
