/**
 * Object encoding module
 */

import { registerModule } from './registry';
import { isObject, isArray } from '../utils';
import type { Encoder } from '../encoder';
import type { Decoder } from '../decoder';

export function registerObjectModule() {
  registerModule(
    'object',
    function (options) {
      if (options.template == null) {
        options.template = false;
      }

      if (
        (typeof options.template !== 'boolean' || options.template !== false) &&
        !isObject(options.template)
      ) {
        throw new TypeError('Invalid object template');
      }

      if (
        options.base != null &&
        !isArray(options.base) &&
        !isObject(options.base) &&
        typeof options.base !== 'function'
      ) {
        throw new TypeError('Invalid object base');
      }
    },
    function (items, options) {
      const workTpl = function (this: Encoder, obj: any, tpl: any): void {
        const keys = Object.keys(tpl === false ? obj : tpl);

        if (options.sort) {
          keys.sort();
        }

        if (tpl === false) {
          this.composeTerm(keys.length);
        }

        for (const k in keys) {
          const key = keys[k];

          if (tpl === false) {
            this.write(key, { type: 'string' });
            this.write(obj[key], { type: 'any' });
          } else {
            const optional = tpl[key].optional == null ? options.optional : tpl[key].optional;

            if (obj[key] == null) {
              if (optional) {
                this.compose(0, 2);
                continue;
              } else {
                throw new ReferenceError(`Object has no property '${key}'`);
              }
            }

            if (optional) {
              this.compose(1, 2);
            }

            if (typeof tpl[key].type === 'string') {
              this.write(obj[key], tpl[key]);
            } else if (isObject(tpl[key])) {
              workTpl.call(this, obj[key], tpl[key]);
            } else {
              throw new TypeError('Invalid object template');
            }
          }
        }
      };

      for (const i in items) {
        workTpl.call(this, items[i], options.template);
      }
    },
    function (options, count) {
      const items: any[] = [];

      if (isArray(options.base) && options.base.length !== count) {
        throw new Error('Items and base count mismatch');
      }

      const workTpl = function (this: Decoder, obj: any, tpl: any): void {
        if (tpl === false) {
          const keys = this.parseTerm();
          for (let key = 0; key < keys; key++) {
            obj[this.read({ type: 'string' }) as string] = this.read({ type: 'any' });
          }
        } else {
          const keys = Object.keys(tpl);

          if (options.sort) {
            keys.sort();
          }

          for (const k in keys) {
            const key = keys[k];

            const optional = tpl[key].optional == null ? options.optional : tpl[key].optional;

            if (optional && this.parse(2) === 0) {
              continue;
            }

            if (typeof tpl[key].type === 'string') {
              obj[key] = this.read(tpl[key]);
            } else if (isObject(tpl[key])) {
              if (obj[key] == null) {
                obj[key] = {};
              }
              workTpl.call(this, obj[key], tpl[key]);
            } else {
              throw new TypeError('Invalid object template');
            }
          }
        }
      };

      for (let i = 0; i < count; i++) {
        let base: any;

        if (options.base == null) {
          base = {};
        } else if (isArray(options.base)) {
          base = options.base[i];
        } else if (typeof options.base === 'function') {
          if (options.base.name === '') {
            base = options.base();
          } else {
            base = new options.base();
          }
        } else {
          base = options.base;
        }

        if (typeof base !== 'object') {
          throw new TypeError('Invalid object base');
        }

        workTpl.call(this, base, options.template);
        items.push(base);
      }

      return items;
    }
  );
}
