# Polynar

[![npm version](https://badge.fury.io/js/polynar.svg)](https://www.npmjs.com/package/polynar)
[![Build Status](https://github.com/Phaen/Polynar/workflows/Tests/badge.svg)](https://github.com/Phaen/Polynar/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)

Polynar encodes typed data into compact bytes or strings and reads it back. You describe the shape once with a small Zod-style schema, and every value spends only the bits its constraints allow: an integer you promise stays between 0 and 100 costs well under a byte, and a field that is one of three names costs a fraction of one. Custom types are one subclass away.

One caveat up front: this is not encryption. Anyone with the bytes can recover the data by analysis, with or without the schema. If you need secrecy, encrypt the output.

## What are polynary numbers?

A number has many representations. Decimal 9 is 1001 in binary. One decimal digit became four binary ones, and each of those four can only ever hold two states.

The waste shows up when your data doesn't fit a power of two. Say a field is male, female, or unknown. Two binary digits give you four slots and you throw one away. A single base-3 digit gives you exactly three.

That idea is where the name comes from. Binary counts in base 2 and ternary in base 3; a polynary number mixes many bases inside one number, a different base for every piece of data, each sized to exactly that piece. A boolean rides in a base-2 slot, a three-way enum in a base-3 slot, a 0-to-99 integer in a base-100 slot, and nothing rounds up to a whole byte or character. Your data fits perfectly, without waste.

Under the hood, the message packs into arbitrary-precision integers in blocks of about two kilobits, so encoding stays fast and the output lands within a hair of the information-theoretic minimum. You give the constraints, Polynar does the arithmetic.

## Size in practice

Seven payload shapes, mean sizes in bytes over 250 seeded random payloads each (lorem is one fixed document), with the mean after brotli compression in parentheses and the smallest number in each row in bold. Every number comes from [`examples/size-comparison.ts`](examples/size-comparison.ts), generators included — run it to reproduce the table.

| Payload | JSON | MessagePack | Protobuf | Polynar url-safe | Polynar binary |
| --- | ---: | ---: | ---: | ---: | ---: |
| User profile — name, age, role, active | 62.8 (64.3) | 44.6 (48.4) | 20.2 (24.2) | 17.5 (21.5) | **13.7** (17.7) |
| GPS position — lat/lng at ~1 m precision | 32.0 (36.0) | 27.0 (31.0) | 9.8 (13.8) | 8.0 (12.0) | **7.0** (11.0) |
| Chat message — sender, timestamp, text as `.prose()` | 95.5 (89.3) | 69.1 (71.1) | 48.6 (51.1) | 38.6 (42.6) | **29.9** (33.9) |
| Sensor reading — id, temperature, battery, ok | 53.8 (55.9) | 39.9 (43.7) | 10.6 (14.6) | 6.0 (10.0) | **5.0** (9.0) |
| Shopping cart — 1-8 items, quantities under a `.cdf()` | 124.4 (67.0) | 85.1 (61.9) | 37.2 (40.8) | 17.0 (21.0) | **13.2** (17.2) |
| Status feed — 100 mostly-ok checks under `.weights()` | 521.8 (63.4) | 323.8 (60.4) | 102.0 (27.8) | 10.1 (14.1) | **7.9** (11.9) |
| Lorem ipsum — three paragraphs as `.prose()`, 1369 characters | 1375 (641) | 1372 (631) | 1372 (**629**) | 961 (773) | 741 (745) |

JSON and MessagePack pay for every key name; Protobuf and Polynar read from a schema instead, both told the same decimal steps and bounds. The difference is that Protobuf rounds every field up to whole bytes and tags it, while Polynar spends fractional bits with no tags.

The url-safe column is `encodeString(value, CharSets.urlSafe)` — text you can drop straight into a URL, cookie or query parameter. On the constrained payloads it beats even the other formats' *binary* output; long text is the one place the smaller alphabet costs more than it saves.

## Install

```bash
npm install polynar
```

Or straight from a CDN in the browser:

```html
<script type="module">
  import { p } from 'https://esm.sh/polynar'; // or jsdelivr's /+esm
</script>
```

## Quick start

```typescript
import { p, type Infer } from 'polynar';

const User = p.object({
  name: p.string().max(40),
  age: p.int().min(0).max(120),
  active: p.bool(),
  role: p.enum(['admin', 'member', 'guest']),
  nickname: p.string().optional(),
});

type User = Infer<typeof User>;

const bytes = User.encode({ name: 'Ada', age: 36, active: true, role: 'admin' });
const user = User.decode(bytes); // typed as User
```

## API

Refinements return fresh nodes. One rule throughout: the factory takes what the type is, chained refinements say what values are allowed. Every node is strict, so a value that doesn't fit the declared type throws.

### Numbers

```typescript
p.int()                         // any integer, signed
p.int().min(0).max(100)         // bounds pack denser; fractional bounds round inward
p.int().min(0).max(100).cdf((v) => v * v) // tell it which values are common; here high ones pack cheap
p.decimal(0.01)                 // exact multiples of a step; off-grid values throw
p.decimal(0.01).min(0).max(100) // a price in cents: 2 bytes
p.float()                       // any finite double, bit-exact; 0.1, 1/3 or 6.02e23 cost 2-6 bytes, noise costs 8
```

`p.int` for whole numbers, `p.decimal` for a known step, `p.float` for arbitrary doubles. All bit-exact; NaN and Infinity throw everywhere, and so does anything that can't round-trip exactly: ranges wider than 2^53, or a value farther than that from a lone bound.

`.cdf()` tells the encoder which values are common. Hand it a running total: `cdf(v)` returns how much weight sits below `v`, so a value's own weight is `cdf(v + 1) - cdf(v)`. Common values cost fewer bits, rare ones more, zero-weight ones throw. You don't need to normalize anything — only the ratios matter — but the function must never go down; if it does, encoding a value in that stretch throws. Works the same on `p.decimal` (called with grid values), `p.date` (bucket timestamps) and `p.array` (item counts). Encoder and decoder must get identical numbers out of it, so use BigInt or plain `+ - * /` — `Math.exp` and friends round differently per engine. And don't inflate the weights for sport: the last value in a message pays extra for a big total.

### Strings

```typescript
p.string()                       // any text, length-prefixed; ~7 bits per ASCII character
p.string().max(40)               // a bounded length packs smaller
p.string().prose()               // weighted for natural language; ~4 bits per character
p.string().charset('0123456789') // restrict the alphabet for density
```

Any JS string round-trips bit-exact, lone surrogates included — where UTF-8-based formats substitute U+FFFD, Polynar returns what went in.

`.prose()` weights each character by the one before it — common characters drop to 2–5 bits, `u` after `q` to under one; anything outside the model — other scripts, emoji — pays a small escape on top. Every string still encodes. You can't combine it with `.charset()`; both decide the alphabet.

### Booleans and enums

```typescript
p.bool();
p.bool().weights([1, 20]);                       // a flag that is nearly always true
p.enum(['red', 'green', 'blue']);                // one base-3 slot
p.enum([256, 512, 1024]);                        // numbers too
p.enum([Strategy.fast, Strategy.safe]);          // any value, matched by identity
p.enum(['ok', 'warn', 'error']).weights([90, 9, 1]); // 'ok' costs 0.15 bits
```

The list order is the encoding, so keep it stable if old bytes must keep decoding. Membership is `===`, so objects and functions work as members; decode returns the listed reference itself.

`.weights()` says how likely each value is, as positive integers in list order (`[false, true]` for booleans). It never rejects anything: rare values still encode, they just cost more. The weights are part of the wire format.

### Dates

```typescript
p.date()                 // lossless to the ms
p.date().min(new Date('2020-01-01')).max(new Date('2030-01-01'))
p.date().interval('day') // coarser, smaller, lossy
```

`interval` takes milliseconds or `'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'`. A decoded date never lands before the min bound.

### Objects

```typescript
p.object({
  x: p.int().min(-1000).max(1000),
  label: p.string().optional(),                    // one presence bit; only undefined means absent
  nick: p.string().optional().weights([1, 99]),    // a 99%-present field pays ~0.015 bits
});
```

Fields are required by default. Objects nest, and falsy-but-defined values are never mistaken for missing.

### Arrays

```typescript
p.array(p.int())               // any count, length-prefixed
p.array(p.int()).min(1).max(4) // a bounded count packs denser
p.array(p.float()).length(3)   // a fixed count costs zero bits
p.array(p.array(p.bool()))     // arrays nest
```

`.length` is both bounds at once, so combining it with `.min` or `.max` throws. Items can't be `.optional()`; make the array itself optional.

### Anything

```typescript
p.any(); // numbers, strings, booleans, dates, null, undefined, arrays, plain objects
```

Self-describing escape hatch: a type tag per value, everything round-trips bit-exact. Costs more than a precise node.

### Inference

`Infer<typeof Node>` is the decoded type of any node; `.optional()` fields become optional keys.

### Output

```typescript
node.encode(value);                         // Uint8Array
node.decode(bytes);
node.encodeString(value, CharSets.urlSafe); // text in a charset of your choice
node.decodeString(text, CharSets.urlSafe);
```

The charset defaults to Base64; any string of unique characters or a `[min, max]` code-unit range works too, on both the string form and `p.string().charset()`.

Decoding checks the input is exactly what the encoder would have produced for that data: tampering, truncation and padding throw a `CorruptInputError` (also matchable via `err.name`). Bytes survive JSON via `Array.from(bytes)` / `new Uint8Array(parsed)`.

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

### Custom types

Subclass `PNode`: `_write` validates one value and pushes its digits with `compose(integer, radix)` / `composeTerm(integer)` — or `composeWeighted(cum, freq, total)` when some values are more common than others — and `_read` mirrors it with `parse`/`parseTerm`/`parseWeighted` in the same order. The node then composes with `p.object`, `p.array` and `.optional()` like any built-in. See [`examples/custom-node.ts`](examples/custom-node.ts) for a runnable version.

```typescript
import { p, PNode, Encoder, Decoder } from 'polynar';

class PColor extends PNode<{ r: number; g: number; b: number }> {
  _write(enc: Encoder, c: { r: number; g: number; b: number }): void {
    enc.compose(c.r, 256);
    enc.compose(c.g, 256);
    enc.compose(c.b, 256);
  }
  _read(dec: Decoder): { r: number; g: number; b: number } {
    return { r: dec.parse(256), g: dec.parse(256), b: dec.parse(256) };
  }
}

const Theme = p.object({ name: p.string().max(20), accent: new PColor() });
```

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT © Pablo Kebees
