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
      for (const i in items) {
        let item = items[i];

        if (typeof item === 'string') {
          item = new Date(Date.parse(item));
        }

        if (!isDate(item) || isNaN(item.getTime())) {
          if (this.strict) {
            throw new TypeError(`Item '${item}' not a valid date`);
          } else {
            item = new Date(item);
          }
        }

        const timestamp = item.getTime();
        this.write(Math.floor(timestamp / options.interval), {
          type: 'number',
          min: options.min || false,
          max: options.max || false,
          step: 1,
        });
      }
    },
    function (options, count) {
      const items: Date[] = [];
      for (let i = 0; i < count; i++) {
        const timestamp = this.read({
          type: 'number',
          min: options.min || false,
          max: options.max || false,
          step: 1,
        }) as number;
        items.push(new Date(timestamp * options.interval));
      }
      return items;
    }
  );
}
