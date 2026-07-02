/**
 * Object encoding module
 */

import { registerModule } from './registry';
import { UTF16_RANGE } from '../constants';
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
            // Keys can hold any character, and a value may itself be an array.
            // Wrap it so `write` encodes it as ONE `any` value instead of
            // spreading it into several.
            this.write(key, { type: 'string', charset: UTF16_RANGE });
            this.write([obj[key]], { type: 'any' });
          } else {
            // A field is optional only when its own template entry says so. The
            // parent object's `optional` (its presence bit in ITS parent) must not
            // bleed down as a default, or it would silently make every sub-field
            // of an optional nested object optional too.
            const optional = tpl[key].optional === true;

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
              // Wrap in a single-element array so `write` encodes the value as
              // ONE item even when it is itself an array (e.g. an `any` field
              // holding an array). Otherwise the array is spread into several
              // writes that decode (which reads one value) cannot recover.
              this.write([obj[key]], tpl[key]);
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
            obj[this.read({ type: 'string', charset: UTF16_RANGE }) as string] = this.read({
              type: 'any',
            });
          }
        } else {
          const keys = Object.keys(tpl);

          if (options.sort) {
            keys.sort();
          }

          for (const k in keys) {
            const key = keys[k];

            // Mirror the encoder: optionality comes only from the field's own
            // template entry, never inherited from the parent object.
            const optional = tpl[key].optional === true;

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
          // A plain-object base is a template of default values. Deep-clone it
          // per item so neither decoded records nor their nested sub-objects
          // alias (and mutate in place) one shared instance across the batch.
          base = structuredClone(options.base);
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
