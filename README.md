# Polynar

[![npm version](https://badge.fury.io/js/polynar.svg)](https://www.npmjs.com/package/polynar)
[![Build Status](https://github.com/Phaen/Polynar/workflows/Tests/badge.svg)](https://github.com/Phaen/Polynar/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)

Polynar encodes typed data into compact bytes (or strings) and reads it back. It spends only the bits a value's constraints actually allow, so an integer you promise is between 0 and 100 costs well under a byte, and a field you promise is one of three names costs a fraction of one.

You describe the shape once with a small schema. Polynar packs values against it and decodes them back to the same types. There's a Zod-style layer (`p`) for everyday use, and a lower-level codec underneath when you want to drive the bit-packing yourself.

One caveat up front: this is not encryption. Anyone with the bytes can recover the data by analysis, with or without the schema. If you need secrecy, encrypt the output.

## How it packs so tight

A number has many representations. Decimal `9` is `1001` in binary. One decimal digit became four binary ones, and each of those four can only ever hold two states.

The waste shows up when your data doesn't fit a power of two. Say a field is `male`, `female`, or `unknown`. Two binary digits give you four slots and you throw one away. A single base-3 digit gives you exactly three.

Polynar mixes bases inside one number, a different base per piece of data, sized to that piece. A boolean rides in a base-2 slot, a three-way enum in a base-3 slot, a 0-to-99 integer in a base-100 slot. The whole message is packed as a single arbitrary-precision integer, so nothing is rounded up to a whole byte or character until the entire value is serialized — the output is always the information-theoretic minimum length for the schema. You give the constraints, Polynar does the arithmetic.

## Install

```bash
npm install polynar
```

Polynar ships CommonJS and ESM builds plus type declarations, so `require` and `import` both resolve to the right thing without config.

For the browser without a build step, import the ES module from a CDN that serves
the ESM build. Either esm.sh or jsdelivr's `/+esm` endpoint works:

```html
<script type="module">
  import { p } from 'https://esm.sh/polynar';
  // or: import { p } from 'https://cdn.jsdelivr.net/npm/polynar/+esm';
  const Age = p.int(0, 120);
  console.log(Age.decode(Age.encode(36)));
</script>
```

## Quick start

Build a schema with `p`, then call `encode` and `decode` on it.

```typescript
import { p, type Infer } from 'polynar';

const User = p.object({
  name: p.string().max(40),
  age: p.int(0, 120),
  active: p.bool(),
  role: p.enum(['admin', 'member', 'guest']),
  nickname: p.string().optional(),
});

type User = Infer<typeof User>;

const bytes = User.encode({
  name: 'Ada',
  age: 36,
  active: true,
  role: 'admin',
});

const user = User.decode(bytes); // typed as User
```

`encode` returns a `Uint8Array`. `decode` takes one back. The decoded value carries the type you inferred, no casting needed.

## The schema layer

Every node is immutable. Refinements like `.max(20)` return a fresh node rather than mutating the old one, so you can share and reuse schemas freely.

### Numbers

```typescript
p.int(0, 100)            // bounded, packed against base 101
p.int(10)                // lower bound only
p.int()                  // unbounded, signed
p.int().min(2).max(9)    // same as p.int(2, 9)
```

`p.int` stores integers. It truncates toward zero, so `3.7` becomes `3` and `-3.7` becomes `-3`. Fractional bounds round inward (`p.int(0.5, 10.5)` covers `1` through `10`) so the range you ask for is never quietly widened. Ask for a band that holds no integer, like `p.int(2.1, 2.9)`, and it throws instead of guessing.

`p.number` is an alias for `p.int`. It's integers too, despite the name, which trips people up. Reach for `p.float` when you need the decimals.

```typescript
p.float()                // approximate to ~1e-15
p.float().precision(1e-9)
```

`p.float` stores a value as a fraction found by continued-fraction approximation. It's lossy at roughly 1e-15 and it isn't dense, so it suits ordinary decimals rather than exact high-magnitude numbers. Set a coarser `precision` and you trade accuracy for smaller output.

### Strings

```typescript
p.string()                       // any UTF-16 text, length-prefixed
p.string().max(40)               // a bounded length packs smaller
p.string().charset('0123456789') // restrict the alphabet for density
```

The default covers the full UTF-16 range, so emoji and CJK text round-trip fine. Narrow the charset when you know the input stays inside one, like digits or hex. Each character then costs only what that smaller alphabet needs.

### Booleans and enums

```typescript
p.bool();
p.enum(['red', 'green', 'blue']); // stored as a sub-byte index
```

An enum packs against the length of its list, so three options cost a base-3 slot. The list order is the encoding, so keep it stable across versions if you want old bytes to keep decoding.

### Dates

```typescript
p.date();                                              // lossless to the ms
p.date(new Date('2020-01-01'), new Date('2030-01-01')); // bounded
p.date(min, max).interval('day');                       // coarser, smaller
```

Default precision is one millisecond, which round-trips a `Date` exactly. `interval` accepts a millisecond count or a name: `'second'`, `'minute'`, `'hour'`, `'day'`, `'week'`, `'month'`, or `'year'`. A coarser interval drops sub-interval precision and saves bytes. With a minimum bound set, a decoded date never lands before that minimum, even when the bound itself isn't interval-aligned.

### Objects

```typescript
const Point = p.object({
  x: p.int(-1000, 1000),
  y: p.int(-1000, 1000),
});
```

Fields are required by default. Mark one `.optional()` and it gets a single presence bit, so present and absent both round-trip. An optional field set to `undefined` decodes back to absent. Falsy-but-defined values like `0`, `''`, and `false` are kept as themselves, never mistaken for missing.

Objects nest. An optional nested object is all-or-nothing: either the whole sub-object is there or none of it is, and its own fields stay required regardless of the parent's optionality.

```typescript
const Account = p.object({
  id: p.int(0, 1_000_000),
  profile: p
    .object({ city: p.string().max(30), zip: p.int(0, 99999) })
    .optional(),
});
```

### Anything

```typescript
p.any(); // numbers, strings, booleans, dates, null, undefined, arrays, plain objects
```

`p.any` is the escape hatch for data whose shape you don't know ahead of time. It writes a type tag with every value, so it costs more than a precise node. Numbers go through the float path, which means integers come back intact but very large or very precise values can drift. When you do know the shape, name it. You'll get smaller output and a real static type.

### Batches

```typescript
const Reading = p.int(0, 1023);
const blob = Reading.encodeMany([512, 0, 1023, 7]);
const back = Reading.decodeMany(blob); // number[]
```

`encodeMany` validates the schema once and reuses a single encoder across the whole array, so it's cheaper than calling `encode` in a loop and the output is denser. It's the right tool for a column of same-typed values.

### Inferring types

`Infer<typeof Schema>` gives you the decoded type for any node. For an object schema it splits required and optional keys correctly, so the result matches a hand-written type.

```typescript
import { p, type Infer } from 'polynar';

const Event = p.object({
  kind: p.enum(['click', 'view']),
  at: p.date(),
  label: p.string().optional(),
});

type Event = Infer<typeof Event>;
// { kind: 'click' | 'view'; at: Date; label?: string }
```

## The lower-level codec

`p` is built on an `Encoder` and a `Decoder` you can use directly. This is the older surface. It's more verbose and you manage the read order yourself, but it exposes a few things the schema layer doesn't, like length-prefixed arrays and transform hooks.

```typescript
import { Encoder, Decoder } from 'polynar';

const enc = new Encoder();
enc.write(42, { type: 'number', min: 0, max: 100 });
enc.write('hello', { type: 'string', max: 20 });

const text = enc.toString(); // compact string
const bytes = enc.toUint8Array(); // or raw bytes

const dec = new Decoder(text);
dec.read({ type: 'number', min: 0, max: 100 }); // 42
dec.read({ type: 'string', max: 20 }); // 'hello'
```

Reads have to mirror writes: same order, same options. The buffer carries no field names or types of its own, which is exactly why it stays small.

### Strings vs bytes

`toUint8Array()` gives you raw bytes, the most compact form, ideal for a database BLOB or a binary WebSocket frame. `toString(charset?)` gives you text in a charset of your choice when you need something URL-safe or printable.

```typescript
const enc = new Encoder();
enc.write('data', { type: 'string' });

enc.toString(CharSets.Base64); // pick a charset for the string form
enc.toString(CharSets.urlSafe);

enc.toUint8Array(); // default byte range [0, 255]
enc.toUint8Array([32, 126]); // restrict to printable ASCII bytes
```

Bytes survive JSON if you need them to: `Array.from(bytes)` to write, `new Uint8Array(parsed)` to read back. To decode a custom byte range, pass the same range to the `Decoder`: `new Decoder(bytes, [32, 126])`.

### Write options

Every `write`/`read` call takes a `type` plus the options for that type.

`number`
- `min`, `max`: bounds, or `false` for unbounded. Default `0`.
- `step`: spacing between representable values. Default `1`.

`string`
- `max`: maximum length, or `false` for variable. Default `false`.
- `charset`: a charset string, a `[min, max]` code-unit range, or a number `n` for `[0, n]`.

`boolean`
- no extra options.

`fraction`
- `precision`: approximation tolerance. Default `1e-15`.

`date`
- `interval`: millisecond count or interval name. Default `1`.
- `min`, `max`: bounds as a `Date` or a timestamp.

`item`
- `list`: the array of allowed values.
- `sort`: sort the list before indexing. Default off.

`object`
- `template`: per-field options, or `false` for a self-describing object.
- `sort`: sort keys before packing. Default off.

`any`
- no extra options.

Three options apply to any type:
- `limit`: cap an array write and length-prefix it, so a matching `read` returns the array.
- `preProc`: transform each value before encoding.
- `postProc`: transform each value after decoding.

```typescript
const enc = new Encoder();
enc.write([1, 2, 3], {
  type: 'number',
  min: 0,
  max: 10,
  preProc: (x) => x * 2,
});

const dec = new Decoder(enc.toString());
dec.read({ type: 'number', min: 0, max: 10, postProc: (x) => x / 2 }, 3);
// [1, 2, 3]
```

## Character sets

| Name | Characters |
| --- | --- |
| `CharSets.digit` | `0123456789` |
| `CharSets.hex` | `0123456789ABCDEF` |
| `CharSets.lowalpha` | `a`–`z` |
| `CharSets.hialpha` | `A`–`Z` |
| `CharSets.alpha` | all letters |
| `CharSets.alphanumeric` | letters and digits |
| `CharSets.printable` | printable ASCII |
| `CharSets.htmlSafe` | HTML-safe characters |
| `CharSets.Base64` | standard Base64 |
| `CharSets.urlSafe` | URL-safe characters |

## Custom encoding types

The built-in types are registered through the same `registerModule` API you can call yourself. A module is a name, an optional validator, an encoder, and a decoder. The encoder calls `compose`/`composeTerm` to push values, the decoder calls `parse`/`parseTerm` to pull them back in the same order.

```typescript
import { registerModule, Encoder } from 'polynar';

registerModule(
  'color',
  false, // no validator
  function (items) {
    for (const i in items) {
      const c = items[i];
      this.compose(c.r, 256);
      this.compose(c.g, 256);
      this.compose(c.b, 256);
    }
  },
  function (_options, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push({ r: this.parse(256), g: this.parse(256), b: this.parse(256) });
    }
    return out;
  }
);

const enc = new Encoder();
enc.write({ r: 255, g: 0, b: 0 }, { type: 'color' });
```

See `examples/custom-module.ts` for a runnable version.

## Development

```bash
npm install
npm run build
npm test
```

Tests live in `src/__tests__/`, one file per module plus the schema suite. `npm run test:coverage` writes an HTML report to `coverage/lcov-report/index.html`.

## License

MIT © Pablo Kebees

## Contributing

Pull requests are welcome.
