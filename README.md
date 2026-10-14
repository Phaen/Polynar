# Polynar

[![npm version](https://badge.fury.io/js/polynar.svg)](https://www.npmjs.com/package/polynar)
[![Build Status](https://github.com/Phaen/Polynar/workflows/Tests/badge.svg)](https://github.com/Phaen/Polynar/actions)
[![Coverage](https://codecov.io/gh/Phaen/Polynar/graph/badge.svg)](https://codecov.io/gh/Phaen/Polynar)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)

Polynar encodes typed data into compact bytes or strings and reads it back. You describe the shape once with a small Zod-style schema, and every value spends only the bits its constraints allow; values that keep recurring in a message can get cheaper as it goes on. The schema is the wire format: no field names, tags or type markers are written, so the encoder and decoder share the same schema and options. An integer you promise stays between 0 and 100 costs well under a byte, and a field that is one of three names costs a fraction of one. Custom types are one subclass away.

One caveat up front: this is not encryption. Anyone with the bytes can recover the data by analysis, with or without the schema. If you need secrecy, encrypt the output.

## What are polynary numbers?

A number has many representations. Decimal 9 is 1001 in binary. One decimal digit became four binary ones, and each of those four can only ever hold two states.

The waste shows up when your data doesn't fit a power of two. Say a field is male, female, or unknown. Two binary digits give you four slots and you throw one away. A single base-3 digit gives you exactly three.

That idea is where the name comes from. Binary counts in base 2 and ternary in base 3; a polynary number mixes many bases inside one number, a different base for every piece of data, each sized to exactly that piece. A boolean rides in a base-2 slot, a three-way enum in a base-3 slot, a 0-to-99 integer in a base-100 slot, and nothing rounds up to a whole byte or character. Your data fits perfectly, without waste.

Under the hood, the message packs into arbitrary-precision integers, and the output lands within a hair of the information-theoretic minimum. You give the constraints, Polynar does the arithmetic.

## Size in practice

Seven payload shapes encoded as JSON, MessagePack, Protobuf, Avro and Polynar, 250 seeded random samples each; lorem is one fixed text. Every number comes from [`examples/size-comparison.ts`](examples/size-comparison.ts) — run it to reproduce.

A cell is the mean size in bytes, and the smallest number in each row is bold. The number in parentheses is the same payload after brotli. The url-safe and ascii-safe columns are text output in `CharSets.urlSafe` and `CharSets.asciiSafe`, text that drops straight into a URL, cookie, header or log line; binary is the default output.

The first table is self-describing: keys and types travel with the data. Polynar's entry is `p.any().encode(value)`, which writes a type tag per value and the key names, like the other two.

| Payload        |         JSON |  MessagePack | url-safe | ascii-safe |   binary |
| -------------- | -----------: | -----------: | -------: | ---------: | -------: |
| User profile   |  62.8 (64.3) |  44.6 (48.4) |     49.4 |       45.6 | **37.5** |
| GPS position   |  32.0 (36.0) |  27.0 (31.0) |     27.4 |       25.2 | **20.8** |
| Chat message   |  95.5 (89.3) |  69.1 (71.1) |     70.9 |       65.3 | **53.8** |
| Sensor reading |  53.8 (55.9) |  39.9 (43.7) |     41.1 |       37.8 | **31.2** |
| Shopping cart  | 124.4 (67.0) |  85.1 (61.9) |     46.4 |       42.7 | **35.1** |
| Status feed    | 521.8 (63.4) | 323.8 (60.4) |     34.5 |       31.7 | **26.1** |
| Lorem ipsum    |   1375 (641) |   1372 (631) |      785 |        722 |  **593** |

In the second table both sides share a schema and only the values are written. Protobuf and Avro get the same decimal steps as scaled integers, but only Polynar can use the bounds. Protobuf tags every field and rounds it up to whole bytes, Avro drops the tags but keeps the bytes, and Polynar spends fractional bits. Polynar's number in parentheses is `.adaptive()` on every node that takes it rather than brotli, which gains nothing on output that is already entropy coded.

| Payload        |     Protobuf |         Avro |    url-safe |  ascii-safe |          binary |
| -------------- | -----------: | -----------: | ----------: | ----------: | --------------: |
| User profile   |  18.7 (22.7) |  17.2 (21.2) | 17.8 (17.7) | 16.7 (16.3) | 13.7 (**13.5**) |
| GPS position   |   9.8 (13.8) |   7.8 (11.8) |   9.0 (9.0) |   8.0 (8.0) |   **7.0** (7.0) |
| Chat message   |  48.6 (51.1) |  45.7 (48.3) | 38.6 (38.8) | 35.6 (35.7) | **29.3** (29.4) |
| Sensor reading |  10.6 (14.6) |   7.2 (11.2) |   6.0 (6.0) |   6.0 (6.0) |   **5.0** (5.0) |
| Shopping cart  |  37.2 (40.8) |  20.8 (24.8) | 19.4 (18.8) | 17.9 (17.4) | 14.8 (**14.4**) |
| Status feed    | 102.0 (27.8) | 103.0 (28.1) | 27.0 (11.5) | 25.0 (10.6) |  20.0 (**8.9**) |
| Lorem ipsum    |   1372 (629) |   1371 (632) |   975 (745) |   898 (685) |   737 (**563**) |

Polynar's binary output is smaller than every binary format's on every row, plain or compressed, and on every row but lorem its url-safe text is smaller than every text format's and rivals the binary ones. On the status feed `.adaptive()` even makes it three to one.

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

const text = User.encode(user, { type: 'text', charset: CharSets.urlSafe }); // 'N12HJ4A'
assert.deepStrictEqual(User.decode(text, { charset: CharSets.urlSafe }), user);

const bytes = User.encode(user); // Uint8Array [87, 137, 108, 94, 16]
assert.deepStrictEqual(User.decode(bytes), user);
```

## API

Each `p.*` factory creates a node for one type, and the node's methods narrow which values it allows. Every method changes the encoding, usually making it denser, rather than only checking values. Methods return a new node; they never change the one they're called on. A schema that contradicts itself, such as `.min(5).max(2)`, throws as soon as it's defined, and so does setting `.min` or `.max` a second time. A value outside a declared bound, step, length or list throws when it's encoded, and is never rounded to fit. Values the TypeScript types rule out, like a string where a number belongs, aren't checked at runtime. The exceptions are mistakes that would otherwise encode wrong without an error, such as a missing required field or a class instance given to `p.any()`. Object keys outside the shape are dropped.

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
- [`p.map`](#pmapkey-pnode-value-pnode)
- [`p.record`](#precordvalue-pnode)
- [`p.set`](#psetitem-pnode)
- [`p.optional`](#poptionalnode-pnode)
- [`p.nullable`](#pnullablenode-pnode)
- [`p.union`](#punionmembers-pnode)
- [`p.tagged`](#ptaggedkey-string-members-recordstring-pobject)
- [`p.lazy`](#plazyresolve---pnode)
- [`p.versioned`](#pversionedfirst-pnode-later-pnode--pnode-previous--next)
- [`p.any`](#pany)
- [Priors: `.weights()`](#priors-weights)
- [Priors as a function: `.cdf()`](#priors-as-a-function-cdf)
- [Priors that learn: `.adaptive()`](#priors-that-learn-adaptive)

### `p.int()`

An integer. Infers `number`. Non-integers, NaN and Infinity throw; `-0` is stored as `0`. Huge values are fine as long as the arithmetic stays exact: `p.int().min(0).encode(2 ** 60)` round-trips, while `p.int().min(1).encode(2 ** 53 + 6)` throws because `2 ** 53 + 5` isn't a double.

| Method                                     | Description                                                                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                          | Lower bound, an integer; smaller values throw.                                                                                                                                          |
| `.max(n: number)`                          | Upper bound, an integer; larger values throw. With both bounds the value takes exactly log2(max − min + 1) bits. The range can't span more than 2^53 values, and an empty range throws. |
| `.cdf(fn: (v: number) => number)`          | Prior over the values from `min` to `max`, called with the value itself; needs both bounds.                                                                                             |
| `.weights(w: number[])`                    | Prior: one weight per value from `min` to `max`, lowest first; needs both bounds.                                                                                                       |
| `.adaptive(options?: { window?: number })` | Prior that learns from the message; see [Priors that learn](#priors-that-learn-adaptive).                                                                                               |

### `p.decimal(step: number)`

A number on a fixed decimal step, like `p.decimal(0.01)` for cents. Infers `number`. The step must be an exact decimal of at most 15 places (`1 / 3` throws), and both bounds must sit on the step. Values must already sit on the step, so round first: `0.1 + 0.2` throws on step 0.1. Values are stored exactly, except that `-0` becomes `0`. NaN and Infinity throw. An integer step reaches as far as `p.int` does: `p.decimal(1000).encode(1e18)` round-trips. A fractional step keeps values below 2^53 in its last decimal place, about ±9e13 for `0.01` and `0.25` alike; past that, doubles are coarser than the grid.

| Method                                     | Description                                                                                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                          | Lower bound; smaller values throw.                                                                                                                                                                                           |
| `.max(n: number)`                          | Upper bound; larger values throw. With both bounds the value takes a fixed number of bits: `p.decimal(0.01).min(0).max(100)` fits a price in 2 bytes. The range can't span more than 2^53 values, and an empty range throws. |
| `.cdf(fn: (k: number) => number)`          | Prior over the grid, called with `k` for the k-th multiple of the step (`value / step`); needs both bounds.                                                                                                                  |
| `.weights(w: number[])`                    | Prior: one weight per grid point from `min` to `max`, lowest first; needs both bounds.                                                                                                                                       |
| `.adaptive(options?: { window?: number })` | Prior that learns from the message; see [Priors that learn](#priors-that-learn-adaptive).                                                                                                                                    |

### `p.float()`

Any double, `-0`, NaN, `Infinity` and `-Infinity` included. Infers `number`. Every value round-trips bit-exact, except that all NaNs come back as the standard NaN; `p.binary(Float64Array)` keeps the raw bits when a NaN's payload matters. Zero takes a byte; integers and short decimals like `65535`, `0.1` or `6.02e23` take 1–6 bytes, simple fractions like `1/3` 2–4; arbitrary doubles take 8, or 9 at extreme magnitudes.

| Method                               | Description                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.weights(w: Partial<FloatWeights>)` | Prior over the kinds of number: `zero`, `integer`, `decimal`, `fraction` and `other`, which is noise and arithmetic results that take the full mantissa. Keys left out keep their weight; the default is `{ zero: 1, integer: 3, decimal: 3, fraction: 1, other: 2 }`. |

### `p.string()`

Any text, stored with its length; about 7 bits per ASCII character. Infers `string`. Any JS string round-trips bit-exact, lone surrogates included — where UTF-8-based formats substitute U+FFFD, Polynar returns what went in. Lengths count UTF-16 code units, as `.length` does.

| Method                                                         | Description                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.min(n: number)`                                              | Lower bound on the length; shorter strings throw.                                                                                                                                                                                                                                                                                                                                          |
| `.max(n: number)`                                              | Upper bound on the length; longer strings throw. With both bounds the length takes a fixed number of bits.                                                                                                                                                                                                                                                                                 |
| `.length(n: number)`                                           | Fixed length, the same as `.min(n).max(n)`; costs zero bits.                                                                                                                                                                                                                                                                                                                               |
| `.cdf(fn: (n: number) => number)`                              | Prior over the length, called with the length; needs `.max`.                                                                                                                                                                                                                                                                                                                               |
| `.weights(w: number[])`                                        | Prior: one weight per length from `min` (or 0) to `max`, lowest first; needs `.max`.                                                                                                                                                                                                                                                                                                       |
| `.adaptive(options?: { window?: number; separate?: boolean })` | Lets the characters learn from the message, together with every other adaptive string of the same alphabet unless `separate`: each is priced by the three before it, a stretch that already occurred is referred back to, and the length learns too when there is a `.max`; with `.prose()` the model's rows are the starting point. See [Priors that learn](#priors-that-learn-adaptive). |
| `.charset(c: Charset)`                                         | Limits the alphabet, so each character costs fewer bits: a string of unique characters or a `[min, max]` range of character codes, down to a single character or a one-code range. Other characters throw. Can't be combined with `.prose()`, since both set the alphabet.                                                                                                                 |
| `.prose(model?: ProseModel)`                                   | Weighted for natural language, about 4 bits per character; English by default, or a model of your own. Every string still encodes.                                                                                                                                                                                                                                                         |

`.prose()` prices each character by the one before it: common characters drop to 2–5 bits, and `u` after `q` to under one. Characters outside the model, such as other scripts or emoji, cost a little extra.

The built-in model is English (`ProseModels.english`). Any other is a matrix: `{ alphabet, weights }`, where `weights[row][col]` says how likely the character in column `col` is after the one in row `row`. Rows and columns follow `alphabet`, plus one extra each: the last row is used after a character outside the alphabet, and the last column is the escape for such characters. A string's first character uses the space's row, or the last row if the alphabet has no space. `buildProseModel(corpus, options?)` builds a model from sample text and returns plain JSON. Characters it sees only once are left out of the alphabet; `{ minCount }` or an explicit `{ alphabet }` changes that.

### `p.binary(type?: TypedArrayClass)`

A typed array: a `Uint8Array` by default, or any typed array class, like `p.binary(Int16Array)`. Infers that class and decodes to a new array of it. Elements are stored as their raw bytes, plus the element count, so floats keep NaN payloads and `-0`.

| Method                                                         | Description                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                                              | Lower bound on the element count; shorter arrays throw.                                                                                                                                                                                                                                                        |
| `.max(n: number)`                                              | Upper bound on the element count; longer arrays throw. With both bounds the count takes a fixed number of bits.                                                                                                                                                                                                |
| `.length(n: number)`                                           | Fixed element count, the same as `.min(n).max(n)`; costs zero bits.                                                                                                                                                                                                                                            |
| `.cdf(fn: (n: number) => number)`                              | Prior over the element count, called with the count; needs `.max`.                                                                                                                                                                                                                                             |
| `.weights(w: number[])`                                        | Prior: one weight per count from `min` (or 0) to `max`, lowest first; needs `.max`.                                                                                                                                                                                                                            |
| `.adaptive(options?: { window?: number; separate?: boolean })` | Lets the bytes learn from the message, together with every other adaptive binary unless `separate`: each is priced by the three before it, a stretch that already occurred is referred back to, and the element count learns too when there is a `.max`. See [Priors that learn](#priors-that-learn-adaptive). |

### `p.bool()`

A boolean, one bit. Infers `boolean`.

| Method                                     | Description                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `.weights(w: number[])`                    | Prior: one weight per value, as `[true, false]`.                                          |
| `.adaptive(options?: { window?: number })` | Prior that learns from the message; see [Priors that learn](#priors-that-learn-adaptive). |

### `p.enum(list: readonly unknown[])`

One value out of a fixed list: `p.enum(['red', 'green', 'blue'])` costs log2(3) ≈ 1.58 bits. Infers the union of the members' types. Members can be anything — strings, numbers, objects, functions — matched by identity (`===`), and decode returns the listed reference itself. The list must be non-empty with unique members, and NaN can't be one. A value outside the list throws. The order of the list is part of the encoding, so reordering it breaks old data unless the schema is wrapped in `p.versioned`.

| Method                                     | Description                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `.weights(w: number[])`                    | Prior: one weight per member, in list order.                                              |
| `.adaptive(options?: { window?: number })` | Prior that learns from the message; see [Priors that learn](#priors-that-learn-adaptive). |

### `p.date()`

A `Date`, lossless to the millisecond by default. Infers `Date`. An invalid date throws.

| Method                                     | Description                                                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(d: Date \| number)`                  | Lower bound, as a `Date` or an integer timestamp a `Date` can hold; earlier dates throw.                                                                                                       |
| `.max(d: Date \| number)`                  | Upper bound; later dates throw. With both bounds the date takes a fixed number of bits. The range can't span more than 2^53 buckets, and a min above the max throws.                           |
| `.precision(unit: DateUnit, step = 1)`     | Rounds each date down to the start of its UTC bucket: smaller, but lossy. Weeks start on Monday, months and years follow the calendar, and `step` groups units, so `('month', 3)` is quarters. |
| `.cdf(fn: (b: number) => number)`          | Prior over the buckets, called with the bucket number, counting from the bucket that holds 1970-01-01 as 0; needs both bounds.                                                                 |
| `.weights(w: number[])`                    | Prior: one weight per bucket from `min` to `max`, earliest first; needs both bounds.                                                                                                           |
| `.adaptive(options?: { window?: number })` | Prior that learns from the message; see [Priors that learn](#priors-that-learn-adaptive).                                                                                                      |

`DateUnit` is `'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'`. Bounds compare buckets, so a `min` in the middle of a bucket allows that whole bucket, and a date can decode to a time before `min`.

### `p.null()`

`null`, zero bits. Infers `null`. No methods.

### `p.object(shape: Record<string, PNode>)`

An object with a fixed shape: `p.object({ x: p.int(), label: p.optional(p.string()) })`. Infers the object type. Fields are written in shape order, and keys outside the shape are left out. A field can be left out when its node takes `undefined`, such as `p.optional`, `p.any()` or a union with a `p.optional` member. Such a field infers an optional key and decodes with its key left out. Any other field that is missing or `undefined` throws. No methods.

### `p.array(item: PNode)`

An array of one item type, stored with its length. Infers an array of the item's type. Arrays nest.

| Method                                     | Description                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                          | Lower bound on the item count; shorter arrays throw.                                                          |
| `.max(n: number)`                          | Upper bound on the item count; longer arrays throw. With both bounds the count takes a fixed number of bits.  |
| `.length(n: number)`                       | Fixed item count, the same as `.min(n).max(n)`; costs zero bits.                                              |
| `.cdf(fn: (n: number) => number)`          | Prior over the item count, called with the count; needs `.max`.                                               |
| `.weights(w: number[])`                    | Prior: one weight per count from `min` (or 0) to `max`, lowest first; needs `.max`.                           |
| `.adaptive(options?: { window?: number })` | Prior over the item count that learns from the message; see [Priors that learn](#priors-that-learn-adaptive). |

### `p.map(key: PNode, value: PNode)`

A `Map` from one key type to one value type: `p.map(p.string(), p.int())` is `Map<string, number>`. Keys can be any node, and entries are stored with their count, in insertion order.

| Method                                     | Description                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                          | Lower bound on the entry count; smaller maps throw.                                                            |
| `.max(n: number)`                          | Upper bound on the entry count; larger maps throw. With both bounds the count takes a fixed number of bits.    |
| `.length(n: number)`                       | Fixed entry count, the same as `.min(n).max(n)`; costs zero bits.                                              |
| `.cdf(fn: (n: number) => number)`          | Prior over the entry count, called with the count; needs `.max`.                                               |
| `.weights(w: number[])`                    | Prior: one weight per count from `min` (or 0) to `max`, lowest first; needs `.max`.                            |
| `.adaptive(options?: { window?: number })` | Prior over the entry count that learns from the message; see [Priors that learn](#priors-that-learn-adaptive). |

### `p.record(value: PNode)`

A plain object with any string keys and one value type: `p.record(p.int())` is `{ [key: string]: number }`. It's stored like `p.map(p.string(), value)` and decodes to a plain object. Unlike `p.object`, every key is written, so it suits dictionaries whose keys aren't known up front. A record counts as an object, so it can't sit next to `p.object` or `p.tagged` in a `p.union`. Same methods as `p.map`.

### `p.set(item: PNode)`

A `Set` of one item type: `p.set(p.string())` is `Set<string>`. Items are stored with their count, in insertion order. Same methods as `p.map`, bounding and weighing the number of items.

### `p.optional(node: PNode)`

A value or `undefined`, at the cost of one bit: `p.optional(p.int())` is `number | undefined`. As an object field it can be left out: it infers an optional key, and a missing key and an `undefined` value both decode with the key left out. Only `undefined` means absent; `null` is a value and goes to the inner node. Wrapping twice is the same as once.

| Method                                     | Description                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `.weights(w: [number, number])`            | Prior on presence, as `[present, absent]`.                                                            |
| `.adaptive(options?: { window?: number })` | Prior on presence that learns from the message; see [Priors that learn](#priors-that-learn-adaptive). |

### `p.nullable(node: PNode)`

A value or `null`: `p.nullable(p.string())` is `string | null`, written the same as `p.union([p.string(), p.null()])`. Unlike a union it takes any node, `p.lazy` and `p.any()` included. Wrapping twice is the same as once.

| Method                                     | Description                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `.weights(w: number[])`                    | Prior: one weight per side, as `[value, null]`.                                           |
| `.adaptive(options?: { window?: number })` | Prior that learns from the message; see [Priors that learn](#priors-that-learn-adaptive). |

### `p.union(members: PNode[])`

One of several members: `p.union([p.string(), p.int(), p.array(p.string())])` is `string | number | string[]`. The member is picked by the value's kind: string, number, bigint, boolean, null, undefined, date, regular expression, array, map, set, object, ArrayBuffer, DataView, or the class of a typed array. Each kind can belong to one member, so two array or two object members throw, and so does `p.enum(['bold', 'italic'])` next to `p.string()`: an enum has the kind of its members. Members must know their kinds, so `p.lazy` and custom nodes without `_kinds` can't be members. `p.any()` takes nearly every kind, so it overlaps with almost any other member. A value whose kind has no member throws. Recording which member was used costs log2(members) bits.

| Method                                     | Description                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `.weights(w: number[])`                    | Prior: one weight per member, in list order.                                              |
| `.adaptive(options?: { window?: number })` | Prior that learns from the message; see [Priors that learn](#priors-that-learn-adaptive). |

### `p.tagged(key: string, members: Record<string, PObject>)`

Object shapes picked by a tag field:

```typescript
p.tagged('type', {
  move: p.object({ x: p.int(), y: p.int() }),
  chat: p.object({ text: p.string().max(200) }),
}); // { type: 'move'; x: number; y: number } | { type: 'chat'; text: string }
```

The tag costs log2(members) bits and is never written as text. The order of the members is part of the encoding, so reordering them breaks old data unless the schema is wrapped in `p.versioned`. The tag key belongs to the tagged union, so a member shape that also declares it throws, and so does a value whose tag isn't listed. Tags can't be numbers like `'2'`, because JS would list them before the others. A tagged union counts as an object, so it can sit next to other kinds in `p.union`.

| Method                                     | Description                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `.weights(w: number[])`                    | Prior: one weight per member, in key order.                                               |
| `.adaptive(options?: { window?: number })` | Prior that learns from the message; see [Priors that learn](#priors-that-learn-adaptive). |

### `p.lazy(resolve: () => PNode)`

A node looked up on first use, so a schema can contain itself or refer to one defined further down; it costs nothing on the wire. Infers the resolved node's type. Its kinds are unknown until first use, so it can't be a `p.union` member; `p.nullable` and `p.optional` take it either way round. No methods.

### `p.versioned(first: PNode, ...later: (PNode | [PNode, (previous) => next])[])`

A schema that can change after data has been written. The first argument is the first version. Each later argument is either a plain node, when old values still fit it (a wider bound, an added optional field, a removed field), or `[node, migrate]`, where `migrate` turns a value of the previous version into one of the new. Infers the newest version's type. Earlier versions stay in the list: replacing one instead of adding after it makes data written with it undecodable.

Data written by any listed version decodes and is migrated step by step to the newest. Each step's result is checked by that version's node, and the newest is read back from its own bytes, so old data comes out exactly as newest data would. A result a version can't encode throws as encoding it would, with the versions named: a bug in the schema, not bad input, so never a `CorruptInputError`. The encoder always writes the newest, so decoding old data and encoding it again gives new bytes. Data from a version the schema doesn't list throws `UnknownVersionError`. The version number costs a couple of bits. The wrapper has to be there before the first data is written: data written without it carries no version, and nothing can tell its versions apart later.

| Method                       | Description                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.walk(value, from?: PNode)` | Upgrades a value of an older version to the newest, as decoding old data does: an object already in hand, with its version known. The value is of the first version, or of `from`. |

`User.walk({ name: 'Ada' })` gives what data written by the first version decodes to.

### `p.any()`

Self-describing escape hatch: numbers, bigints, strings, booleans, dates, regular expressions, null, undefined, ArrayBuffers, DataViews, typed arrays, arrays, plain objects, Maps and Sets, with a type tag per value. Infers `AnyValue`, the type of exactly those values; an object typed with an interface needs an index signature to count as one. Numbers round-trip as they do through `p.float`, everything else bit-exact, and a typed array decodes as the same class. A regular expression keeps its source and flags but not its `lastIndex`, and a DataView decodes over a new buffer of just its bytes. Shared references and holes in sparse arrays aren't kept: an object that appears twice comes back as two separate copies, and a hole comes back as `undefined`. A subclass of any of these, such as a `Buffer` or a class extending `RegExp` or `Map`, decodes as the built-in class. Any other class instance throws a `TypeError`, and so do errors and boxed primitives like `new Number(1)`. Nesting containers more than 512 levels deep, which includes a value that contains itself, throws a `RangeError` without the path in front. Type tags, strings, object keys and whole key lists are priced by what the message has already seen, so the status feed's hundred strings from a set of three average 26 bytes, and an array of same-shaped objects pays for its keys once. The characters of new strings and keys learn as well, so lorem costs about what `.prose()` does. Nothing to configure. Costs more than a precise node. No methods.

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

What `i` is depends on the node: the value itself on `p.int`, the step count (`value / step`) on `p.decimal`, the bucket number on `p.date` (counting from the bucket that holds 1970-01-01 as 0), the length on `p.string` and `p.binary`, and the item or entry count on `p.array`, `p.map`, `p.record` and `p.set`. The node calls `fn` at the lower bound, at one past the upper bound to get the total, and around each value it encodes or decodes, plus once per halving of the range to find that value: about log2(range) calls.

- `fn` returns safe integers and never goes down. A value whose weight is zero can't be encoded, and neither can one that a dip in `fn` would make decode as another value: encode only ever produces bytes that decode back.
- Only the differences between results matter, so adding a constant changes nothing.
- Encoder and decoder must get identical numbers from it, so stick to BigInt or plain `+ - * /`; `Math.exp` and friends round differently per engine.
- Keep the total small. On top of what the weights predict, every block of the message (2048 bits by default) can take up to log2(total) + 1 extra bits.

### Priors that learn: `.adaptive()`

`.adaptive()` makes a prior learn from the message. The weights, or one per value when none are given, are where it starts; every value the node then writes counts as one observation, so values that keep recurring get cheaper as the message goes on. The encoder tries a few learning rates per message and says which one it used, so there is nothing to tune.

```typescript
p.array(p.enum(['ok', 'warn', 'error']).adaptive()).length(100); // a feed that is mostly 'ok': about 9 bytes instead of 20
p.array(p.int().min(0).max(1000).adaptive()).max(500); // readings that keep coming back
p.array(p.object({ id: p.int(), note: p.optional(p.string()).adaptive() })); // notes that are mostly absent
```

- `window` is how many observations the counts hold before they halve, so the newest weigh most. It is 1024 when left out, and a node with more values than the window raises it to that number.

`p.string` and `p.binary` learn more than a histogram under `.adaptive()`: each character or byte is priced by up to three before it, and a stretch that already occurred in the message is referred back to instead of spelled again. That is why long text under `.adaptive()` approaches brotli. The string fields of one alphabet (the ladder, a prose model or a charset) and window learn this together across the message, as do all binaries, so an id or URL in one field is cheap in the next; `.adaptive({ separate: true })` keeps a field apart. They wait until 64 characters or bytes of their alphabet have been coded in the message, so a short message costs nothing for them.

Every value one node writes in a message goes through one table, so array items, record values and recursion learn from each other. The same node placed in two fields shares its table; two separate nodes don't, strings and binaries aside. From its second value on, a node spends one bit to stay static, a few more to pick a learning rate, so a message too short to learn from costs about one bit more, and a node written once per message costs nothing extra. It pays when many values go through one node in one message; one value per message gains nothing.

It works with weights but not with `.cdf()`, since a function can't count, and over a range of at most 65536 values.

## Encoding and decoding

Every node has these two methods, where `T` is the type it infers.

| Method                                                                                                                                    | Description                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.encode(value: T, options?: { type?: 'binary' \| 'text'; charset?: Charset; blockBits?: number; checksum?: number })`                    | Encodes to a `Uint8Array`, or to a string when `type` is `'text'`. |
| `.decode(input: Uint8Array \| string, options?: { type?: 'binary' \| 'text'; charset?: Charset; blockBits?: number; checksum?: number })` | Decodes bytes or text made by `encode` with the same options.      |

```typescript
const bytes = User.encode(user); // Uint8Array
User.decode(bytes);

const link = User.encode(user, { type: 'text', charset: CharSets.urlSafe }); // text, here safe to put in a URL
User.decode(link, { charset: CharSets.urlSafe });
```

`decode` can tell bytes from text by the input itself, so `type` is optional there and only checked by TypeScript.

Decoding gives back the value that was encoded. Encoding a decoded message again usually gives the same bytes, but not always, so checking integrity is the job of `checksum`. A value's bytes can depend on what the same node wrote earlier in the message.

`blockBits` is the size of the blocks a message is packed in, from 128 to 65536 bits and 2048 by default. Bigger blocks save a little space, and smaller ones are faster.

`checksum` adds an integrity check of that many bits, from 1 to 32, to the message, and costs exactly that many bits. The decoder needs the same setting, and throws a `CorruptInputError` when the input doesn't match it. A corrupted message slips through with probability 2^-k for a `checksum` of k bits. There is no key, so it is no defence against deliberate tampering.

A charset is the set of symbols a message is written in, and it works for both text and binary output. It is a string of at least two different characters, or a `[min, max]` range of character codes. Charsets hold characters from the Basic Multilingual Plane only, so no emoji. Text defaults to Base64, whose `+` and `/` don't survive URLs; `CharSets.urlSafe` does. Binary output defaults to every byte value and writes each symbol as its character code, so its charset can only hold codes from 0 to 255. That keeps bytes inside a smaller set, such as printable ASCII:

```typescript
const ascii = User.encode(user, { charset: CharSets.asciiSafe }); // every byte is printable ASCII
User.decode(ascii, { charset: CharSets.asciiSafe });
```

`p.string().charset()` takes the same charsets, and also a single character.

| Name                    | Characters                      |
| ----------------------- | ------------------------------- |
| `CharSets.digit`        | `0123456789`                    |
| `CharSets.hex`          | `0123456789ABCDEF`              |
| `CharSets.lowalpha`     | `a`–`z`                         |
| `CharSets.hialpha`      | `A`–`Z`                         |
| `CharSets.alpha`        | all letters                     |
| `CharSets.alphanumeric` | letters and digits              |
| `CharSets.asciiSafe`    | printable ASCII                 |
| `CharSets.htmlSafe`     | printable ASCII without `"&'<>` |
| `CharSets.base64`       | standard Base64                 |
| `CharSets.urlSafe`      | letters, digits and `-._~`      |

## Errors

Input that doesn't decode — truncated, padded, or with characters outside the charset — throws a `CorruptInputError`. Without a `checksum`, damaged input that still decodes gives whatever value those bytes encode; with one it throws instead, except with probability 2^-k. Its subclass `UnknownVersionError` is thrown when `p.versioned` gets data from a version it doesn't list.

A value that can't be encoded throws with its path in front and the limit it broke, like `filters[2].op: Value "gt" is not one of "eq", "lt"` or `tags: Array length 5 is above the maximum 3`. A migration in `p.versioned` whose result doesn't fit throws the same way when old data is decoded, with the versions after the message, like `n: Value 500 is above the maximum 10, in data migrated from version 1 to 2`; a migration that throws gets `, in migrating version 1 data to version 2` appended. A value outside what the schema allows — a bound, step, length, list, tag, charset or nesting depth — throws a `RangeError`. A value the schema has no place for at all throws a `TypeError`: a non-integer, a non-finite number, an invalid date, a missing required field, a kind no union member takes, or a type `p.any` can't encode. An invalid schema throws a `TypeError` or `RangeError` as soon as it's defined.

## Types

- `Infer<typeof Node>` — the decoded type of any node.
- `InferShape<S>`, `InferTagged<K, M>` — the types `p.object` and `p.tagged` infer, from a shape or a member map.
- `AnyValue` — the values `p.any` encodes and decodes.
- `Cdf` — `(v: number) => number`, the function `.cdf()` takes.
- `AdaptiveOptions` — `{ window?: number }`, what `.adaptive()` takes.
- `SequenceAdaptiveOptions` — `{ window?: number; separate?: boolean }`, what `.adaptive()` takes on `p.string` and `p.binary`.
- `MemberPrior` — `{ weights?: readonly number[]; rows?: readonly (readonly number[])[]; adaptive?: AdaptiveOptions }`, the prior `members` takes.
- `Members` — what `members` returns: its `count`, its `radix` when every member is equally likely, `write(enc, pos, row?)` and `read(dec, row?)`.
- `Bucket` — `[cum, freq, total]`, one coding's range for a symbol, as `composeAlternatives` takes it.
- `DateUnit` — the units `.precision()` takes.
- `Kind` — the kinds `p.union` tells apart, and the type of `_kinds`.
- `ProseModel`, `ProseModelOptions` — a prose matrix and the options of `buildProseModel`.
- `TypedArray`, `TypedArrayClass` — what `p.binary` takes and returns.
- `Charset` — `string | [number, number]`, for output and `.charset()`.
- `OutputType` — `'binary' | 'text'`.
- `CodecOptions` — the options of `encode` and `decode`. Without a type argument it has no `type`, so one options object works for both forms; `CodecOptions<'text'>` and `CodecOptions<'binary'>` include it.

The node classes are exported too (`PNode`, `PInt`, `PString`, `PObject`, …), along with `ProseModels`, `buildProseModel`, `members` and `MessageState`.

## Custom nodes

Subclass `PNode` and implement two methods: `_write` writes one value's digits, and `_read` reads them back in the same order. The node then works inside `p.object`, `p.array` and `p.optional` like any built-in. To use it in `p.union`, also set `_kinds` to the kinds its values have, like `readonly _kinds = ['object'] as const`. A node that can return `undefined` needs nothing extra for an object field using it to be left out, but one that declares `_kinds` lists `'undefined'` among them. See [`examples/custom-node.ts`](examples/custom-node.ts) for a runnable version.

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

| Method                                                                                                                                                                                                   | Description                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Encoder()`                                                                                                                                                                                          | An empty message.                                                                                                                                                                                                                                                                                                                         |
| `enc.compose(integer: number, radix: number)`                                                                                                                                                            | One digit in a fixed radix: `integer` in `[0, radix)`, `radix` a positive safe integer; anything else throws.                                                                                                                                                                                                                             |
| `enc.composeTerm(integer: number)`                                                                                                                                                                       | Any non-negative integer, no bound needed.                                                                                                                                                                                                                                                                                                |
| `enc.composeWeighted(cum: number, freq: number, total: number, position?: { index: number; count: number })`                                                                                             | Writes a weighted value: the range `[cum, cum + freq)` out of `total`. Costs log2(total / freq) bits. `position` gives the value's `index` among the node's `count` values; with it, the last value in a message costs no more than picking one of `count` values.                                                                        |
| `enc.state<S>(key: object, init: () => S)`                                                                                                                                                               | A slot of per-message state keyed by an object, usually the node itself: `init` creates it on the message's first call, and later calls return it.                                                                                                                                                                                        |
| `enc.composeSelector(group: object, choices: readonly Bucket[])`                                                                                                                                         | Opens a choice among codings of the same symbols for `group`, once, before its first symbol. `choices[i]` is the `Bucket` the choice is written as under coding i, all out of one total. The encoder keeps the coding whose choice and symbols cost the fewest bits and writes its bucket here; the decoder reads it as a weighted value. |
| `enc.composeAlternatives(group: object, buckets: readonly Bucket[], position?: { index: number; count: number })`                                                                                        | One symbol of `group`, as the `Bucket` each coding gives it: `buckets[i]` is the symbol under coding i. `position` works as for `composeWeighted`.                                                                                                                                                                                        |
| `enc.output(options?: CodecOptions)`                                                                                                                                                                     | The message as bytes, or as text when `type` is `'text'`, with the same options as `encode`.                                                                                                                                                                                                                                              |
| `new Decoder(input: Uint8Array \| string, options?: CodecOptions)`                                                                                                                                       | Reads bytes or text made with the same options.                                                                                                                                                                                                                                                                                           |
| `dec.parse(radix: number)`                                                                                                                                                                               | Reads what `compose` wrote.                                                                                                                                                                                                                                                                                                               |
| `dec.parseMany(radix: number, count: number)`                                                                                                                                                            | Reads `count` digits that `compose` wrote with the same radix, as one array. Faster than calling `parse` that many times.                                                                                                                                                                                                                 |
| `dec.parseTerm()`                                                                                                                                                                                        | Reads what `composeTerm` wrote.                                                                                                                                                                                                                                                                                                           |
| `dec.parseWeighted<T>(total: number, locate: (residual: number) => [symbol: T, cum: number, freq: number], position?: { count: number; at: (index: number) => [symbol: T, cum: number, freq: number] })` | Reads what `composeWeighted` wrote. `locate` gets a number below `total` and returns the symbol whose range holds it, with that range's `cum` and `freq`; `position.at` returns the same for the value at an index. Pass `position` when the writer passed one.                                                                           |
| `dec.state<S>(key: object, init: () => S)`                                                                                                                                                               | The decoder's slot for `key`, as `enc.state`.                                                                                                                                                                                                                                                                                             |
| `dec.finalize()`                                                                                                                                                                                         | Throws `CorruptInputError` unless the input was consumed exactly; `decode` calls it for you.                                                                                                                                                                                                                                              |
| `dec.digits`                                                                                                                                                                                             | The input's length in digits.                                                                                                                                                                                                                                                                                                             |

A node that picks one of a fixed number of members can spell it through `members(count: number, prior: MemberPrior | undefined, who: string)`, which returns a `Members`: the same object every built-in uses for its enums, booleans and tags. Its `write(enc, pos)` and `read(dec)` are uniform without a prior, weighted like `.weights()` with `{ weights }`, and learning like `.adaptive()` with `{ adaptive: options }`; `who` names the node in errors. `{ rows }` gives one weight list per context in place of `weights`, and `write` and `read` then take the row as a third argument. One `Members` is one table, so the three channels below learn from each other, and three separate ones would keep them apart.

```typescript
import { p, PNode, Encoder, Decoder, members } from 'polynar';
import type { AdaptiveOptions, MemberPrior, Members } from 'polynar';

class PColor extends PNode<{ r: number; g: number; b: number }> {
  private readonly channel: Members;

  constructor(private readonly prior: MemberPrior = {}) {
    super();
    this.channel = members(256, prior, 'PColor');
  }

  adaptive(options?: AdaptiveOptions): PColor {
    return new PColor({ ...this.prior, adaptive: options ?? {} });
  }

  _write(enc: Encoder, c: { r: number; g: number; b: number }): void {
    this.channel.write(enc, c.r);
    this.channel.write(enc, c.g);
    this.channel.write(enc, c.b);
  }
  _read(dec: Decoder): { r: number; g: number; b: number } {
    return { r: this.channel.read(dec), g: this.channel.read(dec), b: this.channel.read(dec) };
  }
}

const Palette = p.array(new PColor().adaptive()).max(64);
```

## Examples

### Shareable URL state

```typescript
const View = p.object({
  page: p.int().min(1).max(10000),
  sort: p.enum(['date', 'name', 'size']),
  tags: p.array(p.string().max(20)).max(5),
});

const hash = View.encode(
  { page: 3, sort: 'name', tags: ['ts'] },
  { type: 'text', charset: CharSets.urlSafe }
);
location.hash = hash;

const view = View.decode(location.hash.slice(1), { charset: CharSets.urlSafe });
```

### Common values

```typescript
p.int()
  .min(0)
  .max(100)
  .cdf((v) => v * v); // high values are common, so they cost less
p.int().min(1).max(5).weights([5, 2, 3, 10, 80]); // or as a histogram, lowest value first
p.bool().weights([20, 1]); // a flag that is nearly always true
p.enum(['ok', 'warn', 'error']).weights([90, 9, 1]); // 'ok' costs 0.15 bits
```

### Nullable and optional fields

```typescript
p.object({
  x: p.int().min(-1000).max(1000),
  label: p.optional(p.string()), // one presence bit; only undefined means absent
  nick: p.optional(p.string()).weights([99, 1]), // [present, absent]: present 99% of the time, so it costs ~0.015 bits
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

const sample = 'The quick brown fox jumps over the lazy dog. The dog sleeps on.';
const model = buildProseModel(sample); // built from sample text in your language; plain JSON you can store
const Comment = p.string().max(500).prose(model);
```

Both sides need the same model, like any other part of the schema.

## Contributing

```bash
npm install
npm run check
npm run fuzz:diff -- HEAD
```

`npm run check` runs everything CI runs: type checks, lint, formatting, the build, the package exports and the tests with coverage. CI does this on Node 18, 20 and 22.

Coverage has to stay at 100%, and the build fails if it drops. So for every branch you add, add a test with a valid input that reaches it. If you find yourself writing a branch for a case no input can reach, leave it out and put a comment where your code relies on that case never happening. Don't use a non-null assertion (`!`) to get around a branch.

Write each function so it works for every value its parameter types allow. Handle the value, narrow the type to what the function really accepts, or reject the value with a clear error. Test functions at module level on their own, including the edges of their types, and test private methods through their class.

Each node has its own test file, and shared code is tested in the file named after it. A new node lives in `src/nodes/`, gets its factory in `p.ts`, its export in `src/index.ts`, a section in the API part of this README, and a case in `src/__tests__/random-schemas.ts`, which both fuzz suites draw from. A node with a prior also gets an adaptive case there.

`fuzz.test.ts` checks round trips and corrupt input over random schemas. Before you change the encoder or decoder, run `npm run fuzz:diff -- HEAD`: it compares the wire format of your working tree with the last commit, and without a ref it compares with the latest release. CI runs that comparison against the latest release on every pull request and only warns, because some changes to the wire format are deliberate.

Error messages should name the value and the limit it broke, like `Value 5 is above the maximum 3`.

## License

MIT © Pablo Kebees
