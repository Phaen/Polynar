# Polynar

[![npm version](https://badge.fury.io/js/polynar.svg)](https://www.npmjs.com/package/polynar)
[![Build Status](https://github.com/Phaen/Polynar/workflows/Tests/badge.svg)](https://github.com/Phaen/Polynar/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)

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

The url-safe column is `encodeString(value, CharSets.urlSafe)` — text you can drop straight into a URL, cookie or query parameter, and it still beats the other formats' _binary_ output.

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
import assert from 'node:assert';
import { p, CharSets, type Infer, type PNode } from 'polynar';

const User = p.object({
  name: p.string().max(40),
  age: p.int().min(0).max(120),
  active: p.bool(),
  role: p.enum(['admin', 'member', 'guest']),
  nickname: p.optional(p.string()),
});

type User = Infer<typeof User>;

const user: User = { name: 'Ada', age: 36, active: true, role: 'admin' };

const text = User.encodeString(user, CharSets.urlSafe); // 'ChxRoLA'
assert.deepStrictEqual(User.decodeString(text, CharSets.urlSafe), user);

const bytes = User.encode(user); // Uint8Array [176, 253, 162, 98, 3]
assert.deepStrictEqual(User.decode(bytes), user);
```

## API

Each `p.*` factory creates a node for one type, and the node's methods narrow which values it allows. Methods return a new node; they never change the one they're called on. A schema that contradicts itself, such as `.min(5).max(2)`, throws as soon as it's defined. A value outside a declared bound, step, length or list throws when it's encoded. Everything else, like a string where a number belongs, is left to TypeScript, and object keys outside the shape are dropped.

- [`p.int`](#pint)
- [`p.decimal`](#pdecimalstep-number)
- [`p.float`](#pfloat)
- [`p.string`](#pstring)
- [`p.binary`](#pbinarytype-typedarrayclass)
- [`p.bool`](#pbool)
- [`p.enum`](#penumlist-readonly-unknown)
- [`p.date`](#pdate)
- [`p.null`](#pnull)
- [`p.object`](#pobjectshape-recordstring-pnode)
- [`p.array`](#parrayitem-pnode)
- [`p.optional`](#poptionalnode-pnode)
- [`p.nullable`](#pnullablenode-pnode)
- [`p.union`](#punionmembers-pnode)
- [`p.tagged`](#ptaggedkey-string-members-recordstring-pobject)
- [`p.lazy`](#plazyresolve---pnode)
- [`p.versioned`](#pversionedfirst-pnode-later-pnode--pnode-previous--next)
- [`p.any`](#pany)
- [Priors: `.weights()`](#priors-weights)
- [Priors as a function: `.cdf()`](#priors-as-a-function-cdf)

### `p.int()`

An integer. Infers `number`. Non-integers, NaN and Infinity throw; `-0` is stored as `0`. Huge values are fine as long as the arithmetic stays exact: `p.int().min(0).encode(2 ** 60)` round-trips, while `p.int().min(1).encode(2 ** 53 + 6)` throws because `2 ** 53 + 5` isn't a double.

| Method                            | Description                                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                 | Lower bound; smaller values throw. A fractional bound rounds up, so `.min(10.9)` allows 11 and up.                                                                          |
| `.max(n: number)`                 | Upper bound; larger values throw. With both bounds the value takes exactly log2(max − min + 1) bits. The range can't span more than 2^53 values, and an empty range throws. |
| `.cdf(fn: (v: number) => number)` | Prior over the values from `min` to `max`, called with the value itself; needs both bounds.                                                                                 |
| `.weights(w: number[])`           | Prior: one weight per value from `min` to `max`, lowest first; needs both bounds.                                                                                           |

### `p.decimal(step: number)`

A number on a fixed decimal step, like `p.decimal(0.01)` for cents. Infers `number`. The step and both bounds must be exact decimals of at most 15 places (`1 / 3` throws). Values must already sit on the step, so round first: `0.1 + 0.2` throws on step 0.1. Values are stored exactly, except that `-0` becomes `0`. NaN and Infinity throw, and so do values too large to store exactly.

| Method                            | Description                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                 | Lower bound; smaller values throw. An off-step bound rounds up to the next step.                                                                                                                                                                           |
| `.max(n: number)`                 | Upper bound; larger values throw. An off-step bound rounds down. With both bounds the value takes a fixed number of bits: `p.decimal(0.01).min(0).max(100)` fits a price in 2 bytes. The range can't span more than 2^53 steps, and an empty range throws. |
| `.cdf(fn: (k: number) => number)` | Prior over the grid, called with `k` for the k-th multiple of the step (`value / step`); needs both bounds.                                                                                                                                                |
| `.weights(w: number[])`           | Prior: one weight per grid point from `min` to `max`, lowest first; needs both bounds.                                                                                                                                                                     |

### `p.float()`

Any finite double, bit-exact, `-0` included. Infers `number`. Short decimals and simple fractions like `0.1`, `1/3` or `6.02e23` take 2–6 bytes; arbitrary doubles take 8. NaN and Infinity throw. No methods.

### `p.string()`

Any text, stored with its length; about 7 bits per ASCII character. Infers `string`. Any JS string round-trips bit-exact, lone surrogates included — where UTF-8-based formats substitute U+FFFD, Polynar returns what went in. Lengths count UTF-16 code units, as `.length` does.

| Method                       | Description                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`            | Lower bound on the length; shorter strings throw.                                                                                                                                                                          |
| `.max(n: number)`            | Upper bound on the length; longer strings throw. With both bounds the length takes a fixed number of bits.                                                                                                                 |
| `.length(n: number)`         | Fixed length; costs zero bits. Can't be combined with `.min` or `.max`.                                                                                                                                                    |
| `.charset(c: Charset)`       | Limits the alphabet, so each character costs fewer bits: a string of unique characters or a `[min, max]` range of character codes. Other characters throw. Can't be combined with `.prose()`, since both set the alphabet. |
| `.prose(model?: ProseModel)` | Weighted for natural language, about 4 bits per character; English by default, or a model of your own. Every string still encodes.                                                                                         |

`.prose()` prices each character by the one before it: common characters drop to 2–5 bits, and `u` after `q` to under one. Characters outside the model, such as other scripts or emoji, cost a little extra.

The built-in model is English (`ProseModels.english`). Any other is a matrix: `{ alphabet, weights }`, where `weights[row][col]` says how likely the character in column `col` is after the one in row `row`. Rows and columns follow `alphabet`, plus one extra each: the last row is used after a character outside the alphabet, and the last column is the escape for such characters. A string's first character uses the space's row, or the last row if the alphabet has no space. `buildProseModel(corpus, options?)` builds a model from sample text and returns plain JSON. Characters it sees only once are left out of the alphabet; `{ minCount }` or an explicit `{ alphabet }` changes that.

### `p.binary(type?: TypedArrayClass)`

A typed array: a `Uint8Array` by default, or any typed array class, like `p.binary(Int16Array)`. Infers that class and decodes to a new array of it. Elements are stored as their raw bytes, plus the element count, so floats keep NaN payloads and `-0`.

| Method               | Description                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`    | Lower bound on the element count; shorter arrays throw.                                                         |
| `.max(n: number)`    | Upper bound on the element count; longer arrays throw. With both bounds the count takes a fixed number of bits. |
| `.length(n: number)` | Fixed element count; costs zero bits. Can't be combined with `.min` or `.max`.                                  |

### `p.bool()`

A boolean, one bit. Infers `boolean`.

| Method                  | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `.weights(w: number[])` | Prior: one weight per value, as `[false, true]`. |

### `p.enum(list: readonly unknown[])`

One value out of a fixed list: `p.enum(['red', 'green', 'blue'])` costs log2(3) ≈ 1.58 bits. Infers the union of the members' types. Members can be anything — strings, numbers, objects, functions — matched by identity (`===`), and decode returns the listed reference itself. The list must be non-empty with unique members, and NaN can't be one. A value outside the list throws. The order of the list is part of the encoding, so reordering it breaks old data unless the schema is wrapped in `p.versioned`.

| Method                  | Description                                  |
| ----------------------- | -------------------------------------------- |
| `.weights(w: number[])` | Prior: one weight per member, in list order. |

### `p.date()`

A `Date`, lossless to the millisecond by default. Infers `Date`. An invalid date throws.

| Method                                 | Description                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(d: Date \| number)`              | Lower bound, as a `Date` or an integer timestamp; earlier dates throw.                                                                                                                         |
| `.max(d: Date \| number)`              | Upper bound; later dates throw. With both bounds the date takes a fixed number of bits. A min above the max throws.                                                                            |
| `.precision(unit: DateUnit, step = 1)` | Rounds each date down to the start of its UTC bucket: smaller, but lossy. Weeks start on Monday, months and years follow the calendar, and `step` groups units, so `('month', 3)` is quarters. |
| `.cdf(fn: (b: number) => number)`      | Prior over the buckets, called with the bucket number, counting `min`'s bucket as 0; needs both bounds.                                                                                        |
| `.weights(w: number[])`                | Prior: one weight per bucket from `min` to `max`, earliest first; needs both bounds.                                                                                                           |

`DateUnit` is `'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'`. Bounds compare buckets, so a `min` in the middle of a bucket allows that whole bucket, and a date can decode to a time before `min`.

### `p.null()`

`null`, zero bits. Infers `null`. No methods.

### `p.object(shape: Record<string, PNode>)`

An object with a fixed shape: `p.object({ x: p.int(), label: p.optional(p.string()) })`. Infers the object type, with `p.optional` fields as optional keys. Fields are written in shape order; a required field that is `undefined` throws, and keys outside the shape are left out. No methods.

### `p.array(item: PNode)`

An array of one item type, stored with its length. Infers an array of the item's type. Arrays nest.

| Method                            | Description                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `.min(n: number)`                 | Lower bound on the item count; shorter arrays throw. A fractional bound rounds up.                           |
| `.max(n: number)`                 | Upper bound on the item count; longer arrays throw. With both bounds the count takes a fixed number of bits. |
| `.length(n: number)`              | Fixed item count; costs zero bits. Can't be combined with `.min` or `.max`.                                  |
| `.cdf(fn: (n: number) => number)` | Prior over the item count, called with the count; needs `.max` and no `.length`.                             |
| `.weights(w: number[])`           | Prior: one weight per count from `min` (or 0) to `max`, lowest first; needs `.max` and no `.length`.         |

### `p.optional(node: PNode)`

A value or `undefined`, at the cost of one bit: `p.optional(p.int())` is `number | undefined`. As an object field it infers an optional key, and an absent key and an `undefined` value both count as absent, so the field decodes with its key left out. Only `undefined` means absent; `null` is a value and goes to the inner node. Wrapping twice is the same as once.

| Method                          | Description                                |
| ------------------------------- | ------------------------------------------ |
| `.weights(w: [number, number])` | Prior on presence, as `[absent, present]`. |

### `p.nullable(node: PNode)`

A value or `null`: `p.nullable(p.string())` is `string | null`, short for `p.union([p.string(), p.null()])`.

| Method                  | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `.weights(w: number[])` | Prior: one weight per member, as `[value, null]`. |

### `p.union(members: PNode[])`

One of several members: `p.union([p.string(), p.int(), p.array(p.string())])` is `string | number | string[]`. The member is picked by the value's kind: string, number, boolean, null, undefined, date, array, object, or the class of a typed array. Each kind can belong to one member, so two array or two object members throw, and so does `p.enum(['bold', 'italic'])` next to `p.string()`: an enum has the kind of its members. Members must know their kinds, so `p.lazy` and custom nodes without `_kinds` can't be members. A value whose kind has no member throws. Recording which member was used costs log2(members) bits.

| Method                  | Description                                  |
| ----------------------- | -------------------------------------------- |
| `.weights(w: number[])` | Prior: one weight per member, in list order. |

### `p.tagged(key: string, members: Record<string, PObject>)`

Object shapes picked by a tag field:

```typescript
p.tagged('type', {
  move: p.object({ x: p.int(), y: p.int() }),
  chat: p.object({ text: p.string().max(200) }),
}); // { type: 'move'; x: number; y: number } | { type: 'chat'; text: string }
```

The tag costs log2(members) bits and is never written as text. The order of the members is part of the encoding, so reordering them breaks old data unless the schema is wrapped in `p.versioned`. The tag key belongs to the tagged union, so a member shape that also declares it throws, and so does a value whose tag isn't listed. A tagged union counts as an object, so it can sit next to other kinds in `p.union`.

| Method                  | Description                                 |
| ----------------------- | ------------------------------------------- |
| `.weights(w: number[])` | Prior: one weight per member, in key order. |

### `p.lazy(resolve: () => PNode)`

A node looked up on first use, so a schema can contain itself or refer to one defined further down; it costs nothing on the wire. Infers the resolved node's type. Its kinds are unknown until first use, so it can't be a `p.union` member. The node it returns can't be `p.optional` either, because an object couldn't see that the field is optional. No methods.

### `p.versioned(first: PNode, ...later: (PNode | [PNode, (previous) => next])[])`

A schema that can change after data has been written. The first argument is the first version. Each later argument is either a plain node, when old values still fit it (a wider bound, an added optional field), or `[node, migrate]`, where `migrate` turns a value of the previous version into one of the new. Infers the newest version's type; up to eight versions are typed. Earlier versions stay in the list: replacing one instead of adding after it makes data written with it undecodable.

Data written by any listed version decodes and is migrated step by step to the newest. The encoder always writes the newest, so decoding old data and encoding it again gives new bytes. Data from a version the schema doesn't list throws `UnknownVersionError`. The version number costs a couple of bits. The wrapper has to be there before the first data is written: data written without it carries no version, and nothing can tell its versions apart later. No methods.

### `p.any()`

Self-describing escape hatch: numbers, strings, booleans, dates, null, undefined, arrays and plain objects, with a type tag per value. Infers `unknown`. Everything round-trips bit-exact; a class instance (a `Map`, a `Set`) or a circular structure throws. Costs more than a precise node. No methods.

### Priors: `.weights()`

Several nodes accept a prior: a hint about which values are common. Common values then cost fewer bits and rare ones more. Only the ratios matter, and the prior is part of the encoding, so both sides need the same one.

`.weights([...])` takes one positive integer per value, in the order listed for that node. A weight never rejects anything: rare values still encode, they just cost more. Nodes with a range of values also take `.cdf()`, which gives the same prior as a function instead of a list.

### Priors as a function: `.cdf()`

When a list of weights would be too long, `.cdf(fn)` describes the prior with a function. `fn(i)` returns the total weight of everything below `i`, so the weight of `i` itself is `fn(i + 1) - fn(i)`:

```typescript
// weights 1, 2, 3, …: each value is a little more common than the one before
p.int()
  .min(0)
  .max(1000)
  .cdf((v) => (v * (v + 1)) / 2);
```

What `i` is depends on the node: the value itself on `p.int`, the step count (`value / step`) on `p.decimal`, the bucket number on `p.date` (with `min`'s bucket as 0), and the item count on `p.array`. The node calls `fn` at the lower bound, at one past the upper bound to get the total, and around each value it encodes or decodes.

- `fn` returns safe integers and never goes down. A value whose weight is zero can't be encoded.
- Only the differences between results matter, so adding a constant changes nothing.
- Encoder and decoder must get identical numbers from it, so stick to BigInt or plain `+ - * /`; `Math.exp` and friends round differently per engine.
- Keep the total small: the last value in a message pays extra when the total is large.

## Encoding and decoding

Every node has these four methods, where `T` is the type it infers.

| Method                                           | Description                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.encode(value: T, range?: ByteRange)`           | Encodes to a `Uint8Array`. With a range, every byte stays within `[min, max]` (inside 0–255, min below max); without one, bytes use all of 0–255. |
| `.decode(bytes: Uint8Array, range?: ByteRange)`  | Decodes bytes made by `encode` with the same range.                                                                                               |
| `.encodeString(value: T, charset?: Charset)`     | Encodes to text in the charset; Base64 when omitted.                                                                                              |
| `.decodeString(text: string, charset?: Charset)` | Decodes text made by `encodeString` with the same charset.                                                                                        |

```typescript
const bytes = User.encode(user); // Uint8Array
User.decode(bytes);

const link = User.encodeString(user, CharSets.urlSafe); // text, here safe to put in a URL
User.decodeString(link, CharSets.urlSafe);

const ascii = User.encode(user, [32, 126]); // bytes kept to printable ASCII
User.decode(ascii, [32, 126]);
```

The charset defaults to Base64, whose `+` and `/` don't survive URLs; `CharSets.urlSafe` does. A charset can also be any string of at least two unique characters, or a `[min, max]` range of character codes; the same goes for `p.string().charset()`.

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

## Errors

Input that doesn't decode — truncated, padded, or with characters outside the charset — throws a `CorruptInputError`. Where `instanceof` can't be trusted, such as with two copies of the package in one process, check `err.name === 'CorruptInputError'`. Its subclass `UnknownVersionError` is thrown when `p.versioned` gets data from a version it doesn't list; its `name` is still `'CorruptInputError'`.

A value that can't be encoded throws with its path in front and the limit it broke, like `filters[2].op: Value 'gt' is not one of 'eq', 'lt'` or `tags: Array length 5 is above the maximum 3`. A value outside what the schema allows — a bound, step, length, list, tag or charset — throws a `RangeError`. A value the schema has no place for at all throws a `TypeError`: a non-integer, a non-finite number, an invalid date, a missing required field, a kind no union member takes, or a type `p.any` can't encode. An invalid schema throws a `TypeError` or `RangeError` as soon as it's defined.

## Types

- `Infer<typeof Node>` — the decoded type of any node.
- `InferShape<S>`, `InferTagged<K, M>` — the types `p.object` and `p.tagged` infer, from a shape or a member map.
- `Cdf` — `(v: number) => number`, the function `.cdf()` takes.
- `DateUnit` — the units `.precision()` takes.
- `Kind` — the kinds `p.union` tells apart, and the type of `_kinds`.
- `ProseModel`, `ProseModelOptions` — a prose matrix and the options of `buildProseModel`.
- `TypedArray`, `TypedArrayClass` — what `p.binary` takes and returns.
- `Charset` — `string | [number, number]`, for text output and `.charset()`.
- `ByteRange` — `[number, number]`, for byte output.

The node classes are exported too (`PNode`, `PInt`, `PString`, `PObject`, …), along with `ProseModels` and `buildProseModel`.

## Custom nodes

Subclass `PNode` and implement two methods: `_write` writes one value's digits, and `_read` reads them back in the same order. The node then works inside `p.object`, `p.array` and `p.optional` like any built-in. To use it in `p.union`, also set `_kinds` to the kinds its values have, like `readonly _kinds = ['object'] as const`. See [`examples/custom-node.ts`](examples/custom-node.ts) for a runnable version.

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

`_write` and `_read` work with these:

| Method                                                                                                      | Description                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Encoder()`                                                                                             | An empty message.                                                                                                                                         |
| `enc.compose(integer: number, radix: number)`                                                               | One digit in a fixed radix: `integer` in `[0, radix)`, `radix` a positive safe integer; anything else throws.                                             |
| `enc.composeTerm(integer: number)`                                                                          | Any non-negative integer, no bound needed.                                                                                                                |
| `enc.composeWeighted(cum: number, freq: number, total: number)`                                             | Writes a weighted value: the range `[cum, cum + freq)` out of `total`. Costs log2(total / freq) bits.                                                     |
| `enc.toString(charset?: Charset)`                                                                           | The message as text; Base64 when omitted.                                                                                                                 |
| `enc.toUint8Array(range?: ByteRange)`                                                                       | The message as bytes within `[min, max]`; the whole byte when omitted.                                                                                    |
| `new Decoder(input: string \| Uint8Array, charset?: Charset \| ByteRange)`                                  | A string with a `Charset`, or a `Uint8Array` with a `[min, max]` byte range.                                                                              |
| `dec.parse(radix: number)`                                                                                  | Reads what `compose` wrote.                                                                                                                               |
| `dec.parseTerm()`                                                                                           | Reads what `composeTerm` wrote.                                                                                                                           |
| `dec.parseWeighted<T>(total: number, locate: (residual: number) => [symbol: T, cum: number, freq: number])` | Reads what `composeWeighted` wrote. `locate` gets a number below `total` and returns the symbol whose range holds it, with that range's `cum` and `freq`. |
| `dec.finalize()`                                                                                            | Throws `CorruptInputError` unless the input was consumed exactly; `decode` and `decodeString` call it for you.                                            |

## Examples

### Shareable URL state

```typescript
const View = p.object({
  page: p.int().min(1).max(10000),
  sort: p.enum(['date', 'name', 'size']),
  tags: p.array(p.string().max(20)).max(5),
});

const hash = View.encodeString({ page: 3, sort: 'name', tags: ['ts'] }, CharSets.urlSafe);
location.hash = hash;

const view = View.decodeString(location.hash.slice(1), CharSets.urlSafe);
```

### Common values

```typescript
p.int()
  .min(0)
  .max(100)
  .cdf((v) => v * v); // high values are common, so they cost less
p.int().min(1).max(5).weights([5, 2, 3, 10, 80]); // or as a histogram, lowest value first
p.bool().weights([1, 20]); // a flag that is nearly always true
p.enum(['ok', 'warn', 'error']).weights([90, 9, 1]); // 'ok' costs 0.15 bits
```

### Nullable and optional fields

```typescript
p.object({
  x: p.int().min(-1000).max(1000),
  label: p.optional(p.string()), // one presence bit; only undefined means absent
  nick: p.optional(p.string()).weights([1, 99]), // [absent, present]: present 99% of the time, so it costs ~0.015 bits
  parent: p.nullable(p.int()).weights([1, 99]), // [value, null]: nearly always null
});
```

### Recursion

```typescript
type Block = { type: 'paragraph'; text: string } | { type: 'list'; items: Block[] };

const Block: PNode<Block> = p.tagged('type', {
  paragraph: p.object({ text: p.string() }),
  list: p.object({ items: p.array(p.lazy(() => Block)) }),
});
```

TypeScript can't infer a type that refers to itself, hence the explicit `PNode<Block>`.

### Versioning

Day one:

```typescript
const v1 = { name: p.string().max(40) };
const User = p.versioned(p.object(v1));
```

After two schema changes, each version built on the one before:

```typescript
const v2 = { ...v1, name: p.string().max(60) }; // a wider bound: old values fit as they are
const v3 = { ...v2, age: p.int().min(0).max(120) }; // a new required field

const User = p.versioned(
  p.object(v1),
  p.object(v2),
  [p.object(v3), (user) => ({ ...user, age: 0 })] // old values get a default age
);
```

### Typed arrays

```typescript
p.binary().length(32); // a hash or key: exactly 32 bytes on the wire
p.binary(Int16Array).length(1024); // 16 bits per element
p.binary(Float64Array).max(100); // doubles as their raw bits, NaN payloads and -0 included
```

### Prose with a custom model

```typescript
import { p, buildProseModel } from 'polynar';

const model = buildProseModel(sample); // built from sample text in your language; plain JSON you can store
const Comment = p.string().max(500).prose(model);
```

Both sides need the same model, like any other part of the schema.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT © Pablo Kebees
