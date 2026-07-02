/**
 * Custom encoding type: register a new `type` with the same API the built-ins
 * use. The encoder pushes values with compose/composeTerm, the decoder pulls
 * them back in the same order with parse/parseTerm.
 * Run with: npx tsx examples/custom-module.ts
 */
import { Encoder, Decoder, registerModule } from 'polynar';

// A "color" type that packs RGB, plus an optional alpha channel, into byte slots.
registerModule(
  'color',

  // Validator, or `false` for none. Bad input always throws. There is no lenient mode.
  function (options) {
    if (options.alpha != null && typeof options.alpha !== 'boolean') {
      throw new TypeError('color: alpha option must be a boolean');
    }
  },

  // Encoder
  function (items, options) {
    for (const i in items) {
      const c = items[i];
      if (typeof c !== 'object' || c == null) {
        throw new TypeError('color: each item must be an { r, g, b } object');
      }
      this.compose(c.r, 256);
      this.compose(c.g, 256);
      this.compose(c.b, 256);
      if (options.alpha) {
        this.compose(Math.round(c.a * 255), 256);
      }
    }
  },

  // Decoder
  function (options, count) {
    const items: any[] = [];
    for (let i = 0; i < count; i++) {
      const c: any = { r: this.parse(256), g: this.parse(256), b: this.parse(256) };
      if (options.alpha) {
        c.a = this.parse(256) / 255;
      }
      items.push(c);
    }
    return items;
  }
);

const colors = [
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
];

const enc = new Encoder();
enc.write(colors, { type: 'color' } as any);
const encoded = enc.toString();
console.log('packed', colors.length, 'colors into', encoded.length, 'characters');
console.log('decoded:', new Decoder(encoded).read({ type: 'color' } as any, 3));

// Options flow through to the module, so the same type can carry alpha.
const enc2 = new Encoder();
const translucent = [
  { r: 255, g: 0, b: 0, a: 1 },
  { r: 0, g: 255, b: 0, a: 0.5 },
];
enc2.write(translucent, { type: 'color', alpha: true } as any);
console.log(
  'with alpha:',
  new Decoder(enc2.toString()).read({ type: 'color', alpha: true } as any, 2)
);
