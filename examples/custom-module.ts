/**
 * Example: Creating and registering a custom encoding module
 *
 * This example shows how to create your own custom encoding type
 * using the same registerModule API that Polynar uses internally.
 */

import { Encoder, Decoder, registerModule } from '../src';

// Example: Create a custom "color" module that encodes RGB colors efficiently
registerModule(
  'color', // Type name

  // Validator function (optional - use false if no validation needed)
  function (options) {
    // Validate encoding options if needed
    if (options.alpha && typeof options.alpha !== 'boolean') {
      throw new TypeError('alpha option must be boolean');
    }
  },

  // Encoder function
  function (items, options) {
    for (const i in items) {
      const color = items[i];

      // Validate the color object
      if (typeof color !== 'object' || !color.r || !color.g || !color.b) {
        if (this.strict) {
          throw new TypeError('Item must be a color object with r, g, b properties');
        }
        continue;
      }

      // Encode RGB values (0-255)
      this.compose(color.r, 256);
      this.compose(color.g, 256);
      this.compose(color.b, 256);

      // Optionally encode alpha channel
      if (options.alpha && color.a !== undefined) {
        this.compose(Math.floor(color.a * 255), 256);
      }
    }
  },

  // Decoder function
  function (options, count) {
    const items: any[] = [];

    for (let i = 0; i < count; i++) {
      const color: any = {
        r: this.parse(256),
        g: this.parse(256),
        b: this.parse(256),
      };

      // Optionally decode alpha channel
      if (options.alpha) {
        color.a = this.parse(256) / 255;
      }

      items.push(color);
    }

    return items;
  }
);

// Now use the custom module!
console.log('=== Custom Color Module Example ===\n');

// Encode some colors
const encoder = new Encoder();
const colors = [
  { r: 255, g: 0, b: 0 },      // Red
  { r: 0, g: 255, b: 0 },      // Green
  { r: 0, g: 0, b: 255 },      // Blue
];

encoder.write(colors, { type: 'color' });
const encoded = encoder.toString();

console.log('Original colors:', colors);
console.log('Encoded:', encoded);
console.log('Encoded length:', encoded.length, 'characters');

// Decode the colors
const decoder = new Decoder(encoded);
const decoded = decoder.read({ type: 'color' }, 3);

console.log('Decoded colors:', decoded);
console.log();

// Example with alpha channel
console.log('=== With Alpha Channel ===\n');

const encoder2 = new Encoder();
const colorsWithAlpha = [
  { r: 255, g: 0, b: 0, a: 1.0 },    // Solid red
  { r: 0, g: 255, b: 0, a: 0.5 },    // Semi-transparent green
  { r: 0, g: 0, b: 255, a: 0.25 },   // Mostly transparent blue
];

encoder2.write(colorsWithAlpha, { type: 'color', alpha: true });
const encoded2 = encoder2.toString();

console.log('Colors with alpha:', colorsWithAlpha);
console.log('Encoded:', encoded2);

const decoder2 = new Decoder(encoded2);
const decoded2 = decoder2.read({ type: 'color', alpha: true }, 3);

console.log('Decoded:', decoded2);
console.log();

console.log('✓ Custom module works perfectly!');
console.log('  You can create modules for any data type you need:');
console.log('  - Custom binary formats');
console.log('  - Domain-specific types (coordinates, vectors, etc.)');
console.log('  - Optimized encodings for your use case');
