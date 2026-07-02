/**
 * Boolean encoding module
 */

import { registerModule } from './registry';

export function registerBooleanModule() {
  registerModule(
    'boolean',
    false,
    function (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (typeof item !== 'boolean') {
          throw new TypeError(`Item '${item}' not boolean`);
        }

        this.compose(+item, 2);
      }
    },
    function (_options, count) {
      const items: boolean[] = [];
      for (let i = 0; i < count; i++) {
        items.push(Boolean(this.parse(2)));
      }
      return items;
    }
  );
}
