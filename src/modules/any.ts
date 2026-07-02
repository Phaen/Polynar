/**
 * Any type encoding module
 */

import { registerModule } from './registry';
import { UTF16_RANGE } from '../constants';
import { isArray, isDate } from '../utils';

// Type tags. `null` and `array` are distinct from `undefined`/`object` so they
// round-trip faithfully. There are 8 tags, so each is packed against radix 8.
const TAG_COUNT = 8;
const TAG_UNDEFINED = 0;
const TAG_NUMBER = 1;
const TAG_STRING = 2;
const TAG_BOOLEAN = 3;
const TAG_DATE = 4;
const TAG_OBJECT = 5;
const TAG_NULL = 6;
const TAG_ARRAY = 7;

export function registerAnyModule() {
  registerModule(
    'any',
    false,
    function (items) {
      // Indexed iteration, not for-in: a sparse array's holes must encode (as
      // `undefined`) so the count stays consistent with `items.length`.
      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // `null` and arrays both report `typeof 'object'`, so handle them before
        // the switch. Otherwise null would hit Object.keys(null) and an array
        // would be silently spread by `write` into several separate values.
        if (item === null) {
          this.compose(TAG_NULL, TAG_COUNT);
          continue;
        }

        if (isArray(item)) {
          this.compose(TAG_ARRAY, TAG_COUNT);
          this.composeTerm(item.length);
          for (let j = 0; j < item.length; j++) {
            // Wrap each element so `write` treats it as ONE value even when it is
            // itself an array (otherwise nested arrays would be spread).
            this.write([item[j]], { type: 'any' });
          }
          continue;
        }

        switch (typeof item) {
          case 'undefined':
            this.compose(TAG_UNDEFINED, TAG_COUNT);
            break;

          case 'number':
            this.compose(TAG_NUMBER, TAG_COUNT);
            this.write(item, { type: 'fraction' });
            break;

          case 'string':
            this.compose(TAG_STRING, TAG_COUNT);
            this.write(item, { type: 'string', charset: UTF16_RANGE });
            break;

          case 'boolean':
            this.compose(TAG_BOOLEAN, TAG_COUNT);
            this.write(item, { type: 'boolean' });
            break;

          case 'object':
            if (isDate(item)) {
              this.compose(TAG_DATE, TAG_COUNT);
              this.write(item, { type: 'date' });
            } else {
              this.compose(TAG_OBJECT, TAG_COUNT);
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
        switch (this.parse(TAG_COUNT)) {
          case TAG_UNDEFINED:
            items.push(undefined);
            break;
          case TAG_NUMBER:
            items.push(this.read({ type: 'fraction' }));
            break;
          case TAG_STRING:
            items.push(this.read({ type: 'string', charset: UTF16_RANGE }));
            break;
          case TAG_BOOLEAN:
            items.push(this.read({ type: 'boolean' }));
            break;
          case TAG_DATE:
            items.push(this.read({ type: 'date' }));
            break;
          case TAG_OBJECT:
            items.push(this.read({ type: 'object' }));
            break;
          case TAG_NULL:
            items.push(null);
            break;
          case TAG_ARRAY: {
            const len = this.parseTerm();
            const arr: any[] = [];
            for (let j = 0; j < len; j++) {
              arr.push(this.read({ type: 'any' }));
            }
            items.push(arr);
            break;
          }
        }
      }
      return items;
    }
  );
}
