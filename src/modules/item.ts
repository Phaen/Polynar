/**
 * Item list encoding module
 */

import { registerModule } from './registry';
import { isArray } from '../utils';

export function registerItemModule() {
  registerModule(
    'item',
    function (options) {
      if (options.list == null || !isArray(options.list) || options.list.length === 0) {
        throw new TypeError('Invalid or empty list');
      }

      if (typeof options.sort === 'boolean' && options.sort === true) {
        options.list = options.list.slice(0).sort();
      }
    },
    function (items, options) {
      for (const i in items) {
        const pos = options.list.indexOf(items[i]);

        if (pos === -1) {
          throw new Error(`Item '${items[i]}' not found in list`);
        }

        this.compose(pos, options.list.length);
      }
    },
    function (options, count) {
      const items: any[] = [];
      for (let i = 0; i < count; i++) {
        items.push(options.list[this.parse(options.list.length)]);
      }
      return items;
    }
  );
}
