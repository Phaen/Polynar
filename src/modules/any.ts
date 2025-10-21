/**
 * Any type encoding module
 */

import { registerModule } from './registry';
import { isDate } from '../utils';

export function registerAnyModule() {
  registerModule(
    'any',
    false,
    function (items) {
      for (const i in items) {
        const item = items[i];

        switch (typeof item) {
          case 'undefined':
            this.compose(0, 6);
            break;

          case 'number':
            this.compose(1, 6);
            this.write(item, { type: 'fraction' });
            break;

          case 'string':
            this.compose(2, 6);
            this.write(item, { type: 'string' });
            break;

          case 'boolean':
            this.compose(3, 6);
            this.write(item, { type: 'boolean' });
            break;

          case 'object':
            if (isDate(item)) {
              this.compose(4, 6);
              this.write(item, { type: 'date' });
            } else {
              this.compose(5, 6);
              this.write(item, { type: 'object' });
            }
            break;

          default:
            throw new TypeError(`Type '${typeof item}' not supported`);
        }
      }
    },
    function (_options, count) {
      const items: any[] = [];
      for (let i = 0; i < count; i++) {
        switch (this.parse(6)) {
          case 0:
            items.push(undefined);
            break;
          case 1:
            items.push(this.read({ type: 'fraction' }));
            break;
          case 2:
            items.push(this.read({ type: 'string' }));
            break;
          case 3:
            items.push(this.read({ type: 'boolean' }));
            break;
          case 4:
            items.push(this.read({ type: 'date' }));
            break;
          case 5:
            items.push(this.read({ type: 'object' }));
            break;
        }
      }
      return items;
    }
  );
}
