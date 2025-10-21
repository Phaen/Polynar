/**
 * Number encoding module
 */

import { registerModule } from './registry';

export function registerNumberModule() {
  registerModule(
    'number',
    function (options) {
      if (options.step == null) {
        options.step = 1;
      } else if (typeof options.step !== 'number' || options.step < 0) {
        throw new TypeError('Invalid step size');
      }

      if (options.min == null) options.min = 0;
      if (options.max == null) options.max = 0;

      if (
        (typeof options.min !== 'number' &&
          typeof options.min !== 'boolean' &&
          options.min !== false) ||
        (typeof options.max !== 'number' &&
          typeof options.max !== 'boolean' &&
          options.max !== false)
      ) {
        throw new TypeError('Invalid range bound');
      }

      if (options.max !== false && options.min !== false) {
        if (options.min > options.max) {
          [options.min, options.max] = [options.max, options.min];
        }

        if (((options.max - options.min) / options.step) % 1 > 0.0000000000000001) {
          throw new TypeError('Range bound outside step range');
        }
      }
    },
    function (items, options) {
      for (const i in items) {
        let item = items[i];

        if (typeof item !== 'number') {
          if (this.strict) {
            throw new TypeError(`Item '${item}' not a number`);
          } else {
            item = Number(item) || 0;
          }
        }

        if (options.max === false || options.min === false) {
          let sign = 0;

          if (options.min === false && options.max === false) {
            if (item < 0) sign++;
            item = Math.abs(item);
          } else if (options.min === false) {
            item = -1 * item + options.max;
          } else {
            item -= options.min;
          }

          if (this.strict === false) {
            item = Math.max(0, item);
          } else if (item < 0) {
            throw new RangeError(`Item '${item}' exceeds range bounds`);
          }

          item /= options.step;

          if (this.strict && item % 1 > 0.0000000000000001) {
            throw new RangeError(`Item '${items[i]}' outside step range`);
          }

          this.composeTerm(Math.floor(item));

          if (options.min === false && options.max === false) {
            this.compose(sign, 2);
          }
        } else {
          if (this.strict === false) {
            item = Math.min(options.max, Math.max(options.min, item));
          } else if (item < options.min || item > options.max) {
            throw new RangeError(`Item '${item}' exceeds range bounds`);
          }

          item = (item - options.min) / options.step;

          if (this.strict && item % 1 > 0.0000000000000001) {
            throw new RangeError(`Item '${items[i]}' outside step range`);
          }

          this.compose(Math.floor(item), (options.max - options.min) / options.step + 1);
        }
      }
    },
    function (options, count) {
      const items: number[] = [];
      if (options.max === false || options.min === false) {
        for (let i = 0; i < count; i++) {
          let item = this.parseTerm();
          item *= options.step;

          if (options.max === false && options.min === false) {
            if (this.parse(2)) item *= -1;
          } else if (options.max === false) {
            item += options.min;
          } else {
            item = -1 * item - options.max;
          }

          items.push(item);
        }
      } else {
        for (let i = 0; i < count; i++) {
          items.push(
            this.parse((options.max - options.min) / options.step + 1) * options.step + options.min
          );
        }
      }
      return items;
    }
  );
}
