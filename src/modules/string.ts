/**
 * String encoding module
 */

import { registerModule } from './registry';
import { CharSets } from '../constants';
import { validateCharset } from '../utils';

export function registerStringModule() {
  registerModule(
    'string',
    function (options) {
      if (options.max == null) {
        options.max = false;
      }

      if (
        (typeof options.max !== 'number' || options.max % 1 !== 0 || options.max < 0) &&
        (typeof options.max !== 'boolean' || options.max !== false)
      ) {
        throw new TypeError('Invalid string limit');
      }

      if (options.charset == null) {
        options.charset = CharSets.printable;
      } else {
        options.charset = validateCharset(options.charset);
      }
    },
    function (items, options) {
      let size: number | undefined;
      if (typeof options.charset !== 'string') {
        size = options.charset[1] - options.charset[0] + 1;
      }

      for (const i in items) {
        let item = items[i];

        if (typeof item !== 'string') {
          if (this.strict) {
            throw new TypeError(`Item '${item}' not string`);
          } else {
            item = String(item);
          }
        }

        if (options.max === false) {
          this.composeTerm(item.length);
        } else {
          if (item.length > options.max) {
            if (this.strict) {
              throw new RangeError(`Item '${item}' exceeds max length`);
            } else {
              item = item.substr(0, options.max);
            }
          }
          this.compose(item.length, options.max + 1);
        }

        for (let chr = 0; chr < item.length; chr++) {
          if (typeof options.charset === 'string') {
            const pos = options.charset.indexOf(item.charAt(chr));
            if (pos === -1) {
              throw new Error('String not compliant with character set');
            }
            this.compose(pos, options.charset.length);
          } else {
            const pos = item.charCodeAt(chr);
            if (pos < options.charset[0] || pos > options.charset[1]) {
              throw new Error('String not compliant with character set');
            }
            this.compose(pos - options.charset[0], size!);
          }
        }
      }
    },
    function (options, count) {
      const items: string[] = [];
      let size: number | undefined;
      if (typeof options.charset !== 'string') {
        size = options.charset[1] - options.charset[0] + 1;
      }

      for (let i = 0; i < count; i++) {
        const len = options.max === false ? this.parseTerm() : this.parse(options.max + 1);
        let item = '';

        for (let chr = 0; chr < len; chr++) {
          if (typeof options.charset === 'string') {
            item += options.charset.charAt(this.parse(options.charset.length));
          } else {
            item += String.fromCharCode(this.parse(size!) + options.charset[0]);
          }
        }

        items.push(item);
      }

      return items;
    }
  );
}
