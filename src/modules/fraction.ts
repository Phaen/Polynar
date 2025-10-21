/**
 * Fraction encoding module
 */

import { registerModule } from './registry';

export function registerFractionModule() {
  registerModule(
    'fraction',
    function (options) {
      if (options.precision == null) {
        options.precision = 1.0e-15;
      } else if (typeof options.precision !== 'number' || options.precision < 0) {
        throw new TypeError('Invalid fraction precision');
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

        let a = Math.floor(item);
        let h1 = 1;
        let k1 = 0;
        let h = a;
        let k = 1;

        while (item - a > options.precision * k * k) {
          item = 1 / (item - a);
          a = Math.floor(item);
          const h2 = h1;
          h1 = h;
          const k2 = k1;
          k1 = k;
          h = h2 + a * h1;
          k = k2 + a * k1;
        }

        this.compose(+(h < 0), 2);
        this.composeTerm(Math.abs(h));
        this.composeTerm(k - 1);
      }
    },
    function (_options, count) {
      const items: number[] = [];
      for (let i = 0; i < count; i++) {
        items.push(((this.parse(2) ? -1 : 1) * this.parseTerm()) / (this.parseTerm() + 1));
      }
      return items;
    }
  );
}
