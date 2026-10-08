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

| Payload        |         JSON |  MessagePack |       Protobuf | Polynar url-safe |  Polynar binary |
| -------------- | -----------: | -----------: | -------------: | ---------------: | --------------: |
| User profile   |  62.8 (64.3) |  44.6 (48.4) |    20.2 (24.2) |      17.8 (21.8) | **13.7** (17.7) |
| GPS position   |  32.0 (36.0) |  27.0 (31.0) |     9.8 (13.8) |       9.0 (13.0) |  **7.0** (11.0) |
| Chat message   |  95.5 (89.3) |  69.1 (71.1) |    48.6 (51.1) |      39.4 (43.3) | **29.9** (33.9) |
| Sensor reading |  53.8 (55.9) |  39.9 (43.7) |    10.6 (14.6) |       6.0 (10.0) |   **5.0** (9.0) |
| Shopping cart  | 124.4 (67.0) |  85.1 (61.9) |    37.2 (40.8) |      17.4 (21.4) | **13.2** (17.2) |
| Status feed    | 521.8 (63.4) | 323.8 (60.4) |   102.0 (27.8) |      10.4 (14.4) |  **7.9** (11.9) |
| Lorem ipsum    |   1375 (641) |   1372 (631) | 1372 (**629**) |        980 (764) |       741 (745) |

JSON and MessagePack also encode the key name; Protobuf and Polynar read from a schema instead, and are both told the same decimal steps and bounds. The difference is that Protobuf rounds every field up to whole bytes and tags it, while Polynar spends fractional bits with no implicit tags.

The url-safe column is `encodeString(value, CharSets.urlSafe)` — text you can drop straight into a URL, cookie or query parameter; which still beats the other formats' _binary_ output.

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
  nickname: p.optional(p.string()),
});

type User = Infer<typeof User>;

const bytes = User.encode({ name: 'Ada', age: 36, active: true, role: 'admin' });
const user = User.decode(bytes); // typed as User
```

## API

Refinements return fresh nodes. One rule throughout: the factory takes what the type is, chained refinements say what values are allowed. A value that breaks a declared bound, step, length or list throws; the TypeScript types are the contract for everything else, and object keys outside the shape are left out.

### Numbers

```typescript
p.int(); // any integer, signed
p.int().min(0).max(100); // bounds pack denser; fractional bounds round inward
p.int()
  .min(0)
  .max(100)
  .cdf((v) => v * v); // tell it which values are common; here high ones pack cheap
p.int().min(1).max(5).weights([5, 2, 3, 10, 80]); // or as a histogram, lowest value first
p.decimal(0.01); // exact multiples of a step; off-grid values throw
p.decimal(0.01).min(0).max(100); // a price in cents: 2 bytes
p.float(); // any finite double, bit-exact; 0.1, 1/3 or 6.02e23 cost 2-6 bytes, noise costs 8
```

`p.int` for whole numbers, `p.decimal` for a known step (values must already sit on it, so round first: `0.1 + 0.2` throws on step 0.1), `p.float` for arbitrary doubles. All bit-exact, except that `p.int` and `p.decimal` store `-0` as `0`; NaN and Infinity throw everywhere. Huge values are fine as long as the arithmetic stays exact: `p.int().min(0).encode(2 ** 60)` round-trips, while `p.int().min(1).encode(2 ** 53 + 6)` throws because `2 ** 53 + 5` isn't a double. A pair of bounds can't span more than 2^53 values, and `p.decimal` stops where `value / step` passes 2^53.

`.cdf()` tells the encoder which values are common. Hand it a running total: `cdf(v)` returns how much weight sits below `v` as a safe integer, so a value's own weight is `cdf(v + 1) - cdf(v)`. Common values cost fewer bits, rare ones more, zero-weight ones throw. You don't need to normalize anything — only the ratios matter — but the function must never go down; if it does, encoding a value in that stretch throws. Works the same on `p.decimal`, `p.date` and `p.array`, called with the grid index (`k` for the k-th multiple of the step), the bucket counted from `min`, and the item count. Encoder and decoder must get identical numbers out of it, so use BigInt or plain `+ - * /` — `Math.exp` and friends round differently per engine. And don't inflate the weights for sport: the last value in a message pays extra for a big total. On all four, `.weights([...])` takes the histogram directly instead, one positive integer per value from the lower bound up.

### Strings

```typescript
p.string(); // any text, length-prefixed; ~7 bits per ASCII character
p.string().max(40); // a bounded length packs smaller
p.string().min(8).max(12); // a floor narrows it further
p.string().length(2); // a fixed length costs nothing
p.string().prose(); // weighted for natural language; ~4 bits per character
p.string().prose(buildProseModel(sample)); // or for your own language, counted from sample text
p.string().charset('0123456789'); // restrict the alphabet for density
```

Any JS string round-trips bit-exact, lone surrogates included — where UTF-8-based formats substitute U+FFFD, Polynar returns what went in. Lengths count UTF-16 code units, as `.length` does.

`.prose()` weights each character by the one before it — common characters drop to 2–5 bits, `u` after `q` to under one; anything outside the model — other scripts, emoji — pays a small escape on top. Every string still encodes. You can't combine it with `.charset()`; both decide the alphabet.

The built-in model is English. Any other is a matrix: `{ alphabet, weights }`, where `weights[row][col]` says how likely the character in column `col` is after the one in row `row`. Both run over `alphabet` plus one extra: the last row is for after a character outside the alphabet, the last column is the escape. A string starts in the space's row, or the last one if the alphabet has no space. `buildProseModel(corpus)` counts a model from sample text and returns plain JSON; characters it sees only once are left to the escape, which `{ minCount }` or an explicit `{ alphabet }` changes.

### Binary

```typescript
p.binary(); // a Uint8Array, eight bits per byte plus its length
p.binary().length(32); // a hash or key: exactly 32 bytes on the wire
p.binary(Int16Array).length(1024); // any typed array: 16 bits per element here
```

Elements go on the wire as their raw bits, so floats keep NaN payloads and `-0`. Takes `.min()`, `.max()` and `.length()` like a string, counting elements, and decodes to a fresh array of the given class.

### Booleans and enums

```typescript
p.bool();
p.bool().weights([1, 20]); // a flag that is nearly always true
p.enum(['red', 'green', 'blue']); // one base-3 slot
p.enum([256, 512, 1024]); // numbers too
p.enum([Strategy.fast, Strategy.safe]); // any value, matched by identity
p.enum(['ok', 'warn', 'error']).weights([90, 9, 1]); // 'ok' costs 0.15 bits
```

The list order is the encoding, so keep it stable if old bytes must keep decoding. Membership is `===`, so objects and functions work as members; decode returns the listed reference itself.

`.weights()` says how likely each value is, as positive integers in list order (`[false, true]` for booleans). It never rejects anything: rare values still encode, they just cost more. The weights are part of the wire format.

### Unions

```typescript
p.union([p.string(), p.int(), p.array(p.string())]); // string | number | string[]
p.nullable(p.string()); // string | null, short for p.union([p.string(), p.null()])
p.nullable(p.string()).weights([1, 99]); // [value, null]: nearly always null
```

The member is picked by the value's kind: string, number, boolean, null, date, array, object, or the class of a typed array. Each kind can belong to one member, so two array or two object members throw, and so does `p.enum(['bold', 'italic'])` next to `p.string()`: an enum has the kind of its members. The tag costs log2(members) bits, or whatever `.weights()` says.

```typescript
p.tagged('type', {
  move: p.object({ x: p.int(), y: p.int() }),
  chat: p.object({ text: p.string().max(200) }),
}); // { type: 'move'; x: number; y: number } | { type: 'chat'; text: string }
```

Object shapes go in `p.tagged`: the tag field picks the member, costs log2(members) bits (or whatever `.weights()` says), and is never written as text. A tagged union is of kind object, so it mixes with other kinds in `p.union`.

### Dates

```typescript
p.date(); // lossless to the ms
p.date().min(new Date('2020-01-01')).max(new Date('2030-01-01'));
p.date().precision('day'); // coarser, smaller, lossy
p.date().precision('minute', 15);
p.date().precision('month');
```

`precision` takes `'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'` and floors each date to the start of its UTC bucket: weeks start on Monday, months and years are calendar months and years, and a step groups units, so `('month', 3)` is quarters. A min in the middle of a bucket admits that whole bucket, so a date can decode to before the min.

### Objects

```typescript
p.object({
  x: p.int().min(-1000).max(1000),
  label: p.optional(p.string()), // one presence bit; only undefined means absent
  nick: p.optional(p.string()).weights([1, 99]), // [absent, present]: a 99%-present field pays ~0.015 bits
});
```

### Arrays

```typescript
p.array(p.int()); // any count, length-prefixed
p.array(p.int()).min(1).max(4); // a bounded count packs denser
p.array(p.float()).length(3); // a fixed count costs zero bits
p.array(p.array(p.bool())); // arrays nest
```

`.length` is both bounds at once, so combining it with `.min` or `.max` throws. Items can't be `p.optional(...)`; make the array itself optional.

### Recursion

```typescript
type Block = { type: 'paragraph'; text: string } | { type: 'list'; items: Block[] };

const Block: PNode<Block> = p.tagged('type', {
  paragraph: p.object({ text: p.string() }),
  list: p.object({ items: p.array(p.lazy(() => Block)) }),
});
```

`p.lazy` looks its node up on first use, so a schema can contain itself or refer to one defined further down; it costs nothing on the wire. TypeScript can't infer a type from its own definition, so the recursive const carries its type as an annotation. Its kinds are unknown until first use, so it can't be a `p.union` member.

### Versioning

```typescript
const User = p.versioned(p.object({ name: p.string().max(40) })); // day one

// later
const User = p.versioned(
  p.object({ name: p.string().max(40) }),
  p.object({ name: p.string().max(60) }), // a wider bound: old values fit as they are
  [
    p.object({ name: p.string().max(60), age: p.int().min(0).max(120) }),
    (user) => ({ ...user, age: 0 }), // a required field: how an old value becomes a new one
  ]
);
```

Data written by any listed version decodes, migrated step by step to the newest; the encoder always writes the newest. Data from a version the schema doesn't list throws `UnknownVersionError`. The version number costs a couple of bits. The wrapper has to be there before the first data is written: data written without it carries no version, and nothing can tell its versions apart later.

### Anything

```typescript
p.any(); // numbers, strings, booleans, dates, null, undefined, arrays, plain objects
```

Self-describing escape hatch: a type tag per value, everything round-trips bit-exact. Costs more than a precise node.

### Inference

`Infer<typeof Node>` is the decoded type of any node; `p.optional(...)` fields become optional keys.

### Output

```typescript
const bytes = User.encode(user); // Uint8Array
User.decode(bytes);

const link = User.encodeString(user, CharSets.urlSafe); // text, here safe to put in a URL
User.decodeString(link, CharSets.urlSafe);

const ascii = User.encode(user, [32, 126]); // bytes kept to printable ASCII; a range within 0–255, min < max
User.decode(ascii, [32, 126]);
```

The charset defaults to Base64, whose `+` and `/` don't survive URLs; `CharSets.urlSafe` does. Any string of unique characters or a `[min, max]` code-unit range works too, on both the string form and `p.string().charset()`.

| Name                    | Characters                 |
| ----------------------- | -------------------------- |
| `CharSets.digit`        | `0123456789`               |
| `CharSets.hex`          | `0123456789ABCDEF`         |
| `CharSets.lowalpha`     | `a`–`z`                    |
| `CharSets.hialpha`      | `A`–`Z`                    |
| `CharSets.alpha`        | all letters                |
| `CharSets.alphanumeric` | letters and digits         |
| `CharSets.printable`    | printable ASCII            |
| `CharSets.htmlSafe`     | HTML-safe characters       |
| `CharSets.Base64`       | standard Base64            |
| `CharSets.urlSafe`      | letters, digits and `-._~` |

Input that does not decode as the schema expects throws a `CorruptInputError` (also matchable via `err.name`), or its subclass `UnknownVersionError` when `p.versioned` meets data from a version it doesn't list. A value that can't encode throws with the path to it in front, like `filters[2].op: Value 'gt' not found in list`.

### Custom types

Subclass `PNode`: `_write` validates one value and pushes its digits with `compose(integer, radix)` / `composeTerm(integer)` — or `composeWeighted(cum, freq, total)` when some values are more common than others — and `_read` mirrors it with `parse`/`parseTerm`/`parseWeighted` in the same order. The node then composes with `p.object`, `p.array` and `p.optional` like any built-in; to use it in `p.union`, also set `_kinds` to the kinds its values have, e.g. `readonly _kinds = ['object'] as const`. See [`examples/custom-node.ts`](examples/custom-node.ts) for a runnable version.

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

### Encoder and Decoder

The primitives a custom node's `_write` and `_read` run against.

```typescript
const enc = new Encoder();
enc.compose(integer, radix); // integer in [0, radix)
enc.composeTerm(integer); // any non-negative integer
enc.composeWeighted(cum, freq, total); // the bucket [cum, cum + freq) of total
enc.toString(charset); // Base64 when omitted
enc.toUint8Array(range); // [min, max] byte range, the whole byte when omitted

const dec = new Decoder(input, charset); // a string with a Charset, or a Uint8Array with a [min, max] range
dec.parse(radix);
dec.parseTerm();
dec.parseWeighted(total, locate); // locate(residual) returns [symbol, cum, freq]
dec.finalize(); // throws CorruptInputError unless the input was consumed exactly
```

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT © Pablo Kebees
