# Polynar

[![npm version](https://badge.fury.io/js/polynar.svg)](https://www.npmjs.com/package/polynar)
[![Build Status](https://github.com/Phaen/Polynar/workflows/Tests/badge.svg)](https://github.com/Phaen/Polynar/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)

> Efficient data encoding library for serializing various data types into compact string representations

Polynar is a powerful JavaScript/TypeScript library that provides efficient encoding and decoding of various data types (numbers, strings, booleans, dates, objects, and more) into compact string representations using polynary (multi-base) number encoding. Originally created in 2014, now modernized with TypeScript support.

## What are Polynary Numbers?

Polynary numbers, or multi-state numbers, are the secret behind Polynar's efficiency. Any number has multiple representations in different numeral systems. Where we have a decimal **9**, we could have **1001** in binary (base two). Notice how a single digit becomes four separate digits, each able to hold a different value.

But what happens when you want to store a gender as either *male*, *female*, or *unknown*? You could use two binary digits (allowing for 4 values, wasting one), or you could use a base-3 digit. This is where polynary numbers shine: by using **multiple bases for different parts of the same number**, we can perfectly fit our data without waste.

For example, you could represent data as base 2-2-3, where:
- First digit (base 2): `true` or `false`
- Second digit (base 2): `yes` or `no`
- Third digit (base 3): `male`, `female`, or `unknown`

This eliminates the storage waste of traditional binary encoding while maintaining easy composition and parsing. **Polynar automatically handles all the math**, so you just specify your constraints and get maximally efficient encoding.

> **Note**: Polynar is **not encryption**. Encoded data can be recovered without knowledge of encoding options through analysis. Use proper encryption if security is needed.

## Features

- 📦 **Multiple data types**: Supports numbers, strings, booleans, dates, objects, arrays, and more
- 🎯 **Type-safe**: Full TypeScript support with comprehensive type definitions
- 🔧 **Flexible encoding**: Multiple character sets (Base64, alphanumeric, custom, etc.)
- 📏 **Compact output**: Efficient encoding minimizes output size
- 🌐 **Universal**: Works in Node.js and browsers
- 🔒 **Strict mode**: Optional strict validation for encoding/decoding

## Installation

```bash
npm install polynar
```

## Quick Start

```typescript
import { Encoder, Decoder, CharSets } from 'polynar';

// Encode numbers
const encoder = new Encoder();
encoder.write(42, { type: 'number', min: 0, max: 100 });
const encoded = encoder.toString(); // Compact string representation

// Decode numbers
const decoder = new Decoder(encoded);
const decoded = decoder.read({ type: 'number', min: 0, max: 100 }); // 42
```

## Usage Examples

### Encoding Numbers

```typescript
import { Encoder } from 'polynar';

const enc = new Encoder();

// Simple range
enc.write(50, { type: 'number', min: 0, max: 100 });

// With step size
enc.write(2.5, { type: 'number', min: 0, max: 10, step: 0.5 });

// Unbounded numbers
enc.write(-42, { type: 'number', min: false, max: false });

const result = enc.toString();
```

### Encoding Strings

```typescript
import { Encoder, CharSets } from 'polynar';

const enc = new Encoder();

// String with max length
enc.write('hello', { type: 'string', max: 20 });

// String with custom charset
enc.write('ABC123', {
  type: 'string',
  charset: CharSets.alphanumeric
});

// Variable length string
enc.write('dynamic', { type: 'string', max: false });

const result = enc.toString();
```

### Encoding Booleans

```typescript
import { Encoder } from 'polynar';

const enc = new Encoder();
enc.write([true, false, true], { type: 'boolean' });
const result = enc.toString();
```

### Encoding Dates

```typescript
import { Encoder } from 'polynar';

const enc = new Encoder();

// Date with day precision
enc.write(new Date(), {
  type: 'date',
  interval: 'day',
  min: new Date('2020-01-01'),
  max: new Date('2030-12-31')
});

// Date with millisecond precision
enc.write(new Date(), {
  type: 'date',
  interval: 1  // milliseconds
});

const result = enc.toString();
```

### Encoding Objects

```typescript
import { Encoder } from 'polynar';

const enc = new Encoder();

// Object with template
const user = { name: 'John', age: 30, active: true };
enc.write(user, {
  type: 'object',
  template: {
    name: { type: 'string', max: 50 },
    age: { type: 'number', min: 0, max: 150 },
    active: { type: 'boolean' }
  }
});

const result = enc.toString();
```

### Encoding Arrays of Items

```typescript
import { Encoder } from 'polynar';

const enc = new Encoder();

// Encode from predefined list
const colors = ['red', 'green', 'blue'];
enc.write('green', {
  type: 'item',
  list: colors
});

const result = enc.toString();
```

### Encoding Mixed Types

```typescript
import { Encoder } from 'polynar';

const enc = new Encoder();

// The 'any' type automatically handles different types
enc.write([42, 'hello', true, new Date()], { type: 'any' });

const result = enc.toString();
```

### Decoding

```typescript
import { Decoder } from 'polynar';

// Decode single value
const dec = new Decoder(encodedString);
const value = dec.read({ type: 'number', min: 0, max: 100 });

// Decode multiple values
const dec2 = new Decoder(encodedString);
const values = dec2.read({ type: 'boolean' }, 3); // Read 3 booleans
```

### Using Custom Character Sets

```typescript
import { Encoder, Decoder, CharSets } from 'polynar';

const enc = new Encoder();
enc.write('data', { type: 'string' });

// Use different charset for output
const base64 = enc.toString(CharSets.Base64);
const urlSafe = enc.toString(CharSets.urlSafe);
const hex = enc.toString(CharSets.hex);

// Decode with same charset
const dec = new Decoder(urlSafe, CharSets.urlSafe);
const result = dec.read({ type: 'string' });
```

### Strict Mode

```typescript
import { Encoder, Decoder } from 'polynar';

// Strict mode throws errors on invalid data
const strictEnc = new Encoder(true);
strictEnc.write(150, { type: 'number', min: 0, max: 100 }); // Throws!

// Non-strict mode coerces values
const lenientEnc = new Encoder(false);
lenientEnc.write(150, { type: 'number', min: 0, max: 100 }); // Clamps to 100
```

### Pre/Post Processing

```typescript
import { Encoder, Decoder } from 'polynar';

const enc = new Encoder();

// Transform data before encoding
enc.write([1, 2, 3], {
  type: 'number',
  min: 0,
  max: 10,
  preProc: (x) => x * 2  // Doubles each number
});

const dec = new Decoder(enc.toString());

// Transform data after decoding
const values = dec.read({
  type: 'number',
  min: 0,
  max: 10,
  postProc: (x) => x / 2  // Halves each number
}, 3);
```

## Available Character Sets

- `CharSets.digit` - `0123456789`
- `CharSets.hex` - `0123456789ABCDEF`
- `CharSets.lowalpha` - `abcdefghijklmnopqrstuvwxyz`
- `CharSets.hialpha` - `ABCDEFGHIJKLMNOPQRSTUVWXYZ`
- `CharSets.alpha` - All letters
- `CharSets.alphanumeric` - Letters and digits
- `CharSets.printable` - All printable ASCII characters
- `CharSets.htmlSafe` - HTML-safe characters
- `CharSets.Base64` - Standard Base64 characters
- `CharSets.urlSafe` - URL-safe characters

## API Reference

### `Encoder`

```typescript
class Encoder {
  constructor(strict?: boolean);
  write(items: any | any[], options: EncodingOptions): void;
  toString(charset?: Charset): string;
}
```

### `Decoder`

```typescript
class Decoder {
  constructor(str: string, charset?: Charset, strict?: boolean);
  read(options: EncodingOptions, count?: number): any;
}
```

### Encoding Options

#### NumberOptions
- `type: 'number'`
- `min?: number | false` - Minimum value (false for unbounded)
- `max?: number | false` - Maximum value (false for unbounded)
- `step?: number` - Step size (default: 1)

#### StringOptions
- `type: 'string'`
- `max?: number | false` - Max length (false for variable)
- `charset?: Charset` - Character set to use

#### BooleanOptions
- `type: 'boolean'`

#### DateOptions
- `type: 'date'`
- `interval?: number | string` - Time interval ('second', 'minute', 'hour', 'day', 'week', 'month', 'year', or milliseconds)
- `min?: number | Date` - Minimum date
- `max?: number | Date` - Maximum date

#### ObjectOptions
- `type: 'object'`
- `template?: ObjectTemplate | false` - Object structure template
- `optional?: boolean` - Allow optional properties
- `sort?: boolean` - Sort keys

#### ItemOptions
- `type: 'item'`
- `list: any[]` - Array of possible values
- `sort?: boolean` - Sort the list

#### AnyOptions
- `type: 'any'` - Automatically handles any supported type

## Custom Encoding Modules

Polynar allows you to create your own encoding types using the same `registerModule` API used internally:

```typescript
import { registerModule, Encoder, Decoder } from 'polynar';

// Register a custom "color" encoding type
registerModule(
  'color',

  // Validator (optional - use false if not needed)
  function (options) {
    // Validate options
  },

  // Encoder
  function (items, options) {
    for (const i in items) {
      const color = items[i];
      this.compose(color.r, 256);  // Red: 0-255
      this.compose(color.g, 256);  // Green: 0-255
      this.compose(color.b, 256);  // Blue: 0-255
    }
  },

  // Decoder
  function (options, count) {
    const items = [];
    for (let i = 0; i < count; i++) {
      items.push({
        r: this.parse(256),
        g: this.parse(256),
        b: this.parse(256),
      });
    }
    return items;
  }
);

// Now use it!
const enc = new Encoder();
enc.write({ r: 255, g: 0, b: 0 }, { type: 'color' });
```

See `examples/custom-module.ts` for a complete working example.

## Development

### Building

```bash
npm install
npm run build
```

### Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage report
npm run test:coverage
```

Tests are organized by module in `src/__tests__/`. Each encoding module has its own test file. Run `npm run test:coverage` to see detailed coverage statistics and generate an HTML report in `coverage/lcov-report/index.html`.

## License

MIT © Pablo Kebees

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
