/**
 * Date encoding module
 */

import { registerModule } from './registry';
import { dates, dateInts } from '../constants';
import { isDate, multiply } from '../utils';

export function registerDateModule() {
  registerModule(
    'date',
    function (options) {
      if (options.interval == null) {
        options.interval = 1;
      } else if (typeof options.interval !== 'number' || options.interval % 1 !== 0) {
        if (typeof options.interval === 'string') {
          const idx = dates.indexOf(options.interval as any);
          if (idx !== -1) {
            options.interval = (dateInts.slice(0, idx + 1) as number[]).reduce(multiply);
          } else {
            throw new TypeError('Invalid date interval');
          }
        } else {
          throw new TypeError('Invalid date interval');
        }
      }

      // The interval is a divisor (ms per bucket). 0/negative/non-integer values
      // have no coherent meaning and an interval of 0 would divide by zero into
      // an infinite encode loop.
      if (!(options.interval > 0) || (options.interval as number) % 1 !== 0) {
        throw new TypeError('Invalid date interval');
      }

      if (isDate(options.min)) {
        options.min = options.min.getTime();
      }

      if (isDate(options.max)) {
        options.max = options.max.getTime();
      }

      if (
        (options.min != null && (typeof options.min !== 'number' || options.min % 1 !== 0)) ||
        (options.max != null && (typeof options.max !== 'number' || options.max % 1 !== 0))
      ) {
        throw new TypeError('Invalid range bound');
      }
    },
    function (items, options) {
      // Quantize relative to `base` (the min bound, or epoch when unbounded
      // below). Anchoring at min (rather than at epoch and flooring the bound)
      // guarantees every in-range date is representable AND that no decoded date
      // falls below the declared minimum (decoded = base + bucket * interval).
      const base = options.min != null ? options.min : 0;
      const max = options.max != null ? Math.floor((options.max - base) / options.interval) : false;

      for (const i in items) {
        let item = items[i];

        if (typeof item === 'string') {
          item = new Date(Date.parse(item));
        }

        if (!isDate(item) || isNaN(item.getTime())) {
          throw new TypeError(`Item '${item}' not a valid date`);
        }

        const timestamp = item.getTime();

        if (options.min != null && timestamp < options.min) {
          throw new RangeError(`Date '${item.toISOString()}' is before the minimum bound`);
        }
        if (options.max != null && timestamp > options.max) {
          throw new RangeError(`Date '${item.toISOString()}' is after the maximum bound`);
        }

        this.write(Math.floor((timestamp - base) / options.interval), {
          type: 'number',
          min: options.min != null ? 0 : false,
          max,
          step: 1,
        });
      }
    },
    function (options, count) {
      const base = options.min != null ? options.min : 0;
      const max = options.max != null ? Math.floor((options.max - base) / options.interval) : false;

      const items: Date[] = [];
      for (let i = 0; i < count; i++) {
        const bucket = this.read({
          type: 'number',
          min: options.min != null ? 0 : false,
          max,
          step: 1,
        }) as number;
        items.push(new Date(base + bucket * options.interval));
      }
      return items;
    }
  );
}
