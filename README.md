# Polynar

[![npm version](https://badge.fury.io/js/polynar.svg)](https://www.npmjs.com/package/polynar)
[![Build Status](https://github.com/Phaen/Polynar/workflows/Tests/badge.svg)](https://github.com/Phaen/Polynar/actions)
[![Coverage](https://codecov.io/gh/Phaen/Polynar/graph/badge.svg)](https://codecov.io/gh/Phaen/Polynar)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)

Polynar is a schema-aware entropy coder with context-mixing compression built in. A schema declares the type and bounds of every value, and the coder writes each one in exactly the bits those bounds leave, so nothing self-describing travels and the output sits at the minimum its odds allow. The compression replaces the fixed odds with ones learned from the message as it is coded. Output is bytes or text.

## What are polynary numbers?

A number has many representations. Decimal 9 is 1001 in binary. One decimal digit became four binary ones, and each of those four can only ever hold two states. The waste shows up when your data doesn't fit a power of two. Say a field is male, female, or unknown. Two binary digits give you four slots and you throw one away. A single base-3 digit gives you exactly three.

That idea is where the name comes from. Binary counts in base 2 and ternary in base 3; a polynary number mixes many bases inside one number, a different base for every piece of data, each sized to exactly that piece. A boolean rides in a base-2 slot, a three-way enum in a base-3 slot, a 0-to-99 integer in a base-100 slot, and nothing rounds up to a whole byte or character. Your data fits perfectly, without waste.

The slots don't have to be split evenly, either. If unknown turns up once in twenty, it can take a thin slice of its slot and male and female the rest, so a likely value costs under a bit and a rare one a few. Each value then costs what its odds say, fractions of a bit included.

That much is encoding. On top of it, Polynar can compress. The odds can be learned from the message as it goes: a node can count how often each of its values turns up, or hand its values to a predictor that guesses each one from what came before it in similar places, such as the same value earlier on, the step between a counter's values, a stretch of text that already went by, or the fields next to it.

General-purpose compressors like gzip and brotli work in bytes, so every guess they make about what comes next is a guess about the next 8 bits. Polynar knows the schema, so it guesses in the data's own terms: a number is a number of exactly its range, a field's value can be one it held before, the shape of an object is a few symbols of its own, and text goes a character at a time. Nothing rounds to a byte, and because each guess costs exactly what its odds say, its guesses can be sharper: even Alice in Wonderland as a single string, with no schema or shape to help, comes out 16% smaller than brotli makes it.

Under the hood, the whole message is one number written out digit by digit, and the output lands within a hair of the information-theoretic minimum. You give the constraints, Polynar does the arithmetic.

## Size in practice

Seven payload shapes encoded as JSON, MessagePack, Protobuf, Avro and Polynar, 250 seeded random samples each; lorem is one fixed text. Every number comes from [`examples/size-comparison.ts`](https://github.com/Phaen/Polynar/blob/master/examples/size-comparison.ts) — run it to reproduce.

A cell is the mean size in bytes, and the smallest number in each row is bold. For the other formats the number in parentheses is the same payload after brotli; Polynar's output is already entropy coded, so brotli gains nothing on it; its number in parentheses is `p.any().adaptive()` in the first table, and in the second the same schema with its odds declared, learned or predicted, whichever the data leaves room for; a row without parentheses is uniform over its bounds, so there is nothing to declare or learn. The url-safe and ascii-safe columns are text output in `CharSets.urlSafe` and `CharSets.asciiSafe`, text that drops straight into a URL, cookie, header or log line; binary is the default output.

The first table is self-describing: keys and types travel with the data. Polynar's entry is `p.any().encode(value)`, which writes a type tag per value and the key names, like the other two.

| Payload        |         JSON |  MessagePack |     url-safe |   ascii-safe |           binary |
| -------------- | -----------: | -----------: | -----------: | -----------: | ---------------: |
| User profile   |  62.8 (64.3) |  44.6 (48.4) |  53.7 (35.1) |  49.5 (32.4) |  40.7 (**26.7**) |
| GPS position   |  32.0 (36.0) |  27.0 (31.0) |  26.8 (23.1) |  24.7 (21.3) |  20.4 (**17.6**) |
| Chat message   |  95.5 (89.3) |  69.1 (71.1) |  79.2 (55.3) |  72.8 (50.8) |  59.9 (**41.8**) |
| Sensor reading |  53.8 (55.9) |  39.9 (43.7) |  42.9 (29.7) |  39.5 (27.4) |  32.6 (**22.6**) |
| Shopping cart  | 124.4 (67.0) |  85.1 (61.9) | 100.6 (35.5) |  92.6 (32.7) |  76.1 (**27.0**) |
| Status feed    | 521.8 (63.4) | 323.8 (60.4) | 385.0 (28.2) | 354.2 (25.9) | 290.8 (**21.4**) |
| Lorem ipsum    |   1375 (641) |   1372 (631) |   1596 (700) |   1469 (644) |   1206 (**529**) |

In the second table both sides share a schema and only the values are written. Protobuf and Avro get the same decimal steps as scaled integers, but only Polynar can use the bounds. Protobuf tags every field and rounds it up to whole bytes, Avro drops the tags but keeps the bytes, and Polynar spends fractional bits.

| Payload        |     Protobuf |         Avro |    url-safe |  ascii-safe |          binary |
| -------------- | -----------: | -----------: | ----------: | ----------: | --------------: |
| User profile   |  18.7 (22.7) |  17.2 (21.2) | 17.6 (12.7) | 16.2 (11.7) |  13.4 (**9.8**) |
| GPS position   |   9.8 (13.8) |   7.8 (11.8) |         8.4 |         7.9 |         **6.6** |
| Chat message   |  48.6 (51.1) |  45.7 (48.3) | 38.0 (35.7) | 35.1 (32.9) | 29.0 (**27.1**) |
| Sensor reading |  10.6 (14.6) |   7.2 (11.2) |         5.9 |         5.3 |         **4.6** |
| Shopping cart  |  37.2 (40.8) |  20.8 (24.8) | 18.5 (15.8) | 17.0 (14.6) | 14.1 (**12.1**) |
| Status feed    | 102.0 (27.8) | 103.0 (28.1) |  24.0 (9.8) |  22.1 (9.0) |  18.3 (**7.5**) |
| Lorem ipsum    |   1372 (629) |   1371 (632) |   968 (699) |   891 (643) |   732 (**528**) |

Polynar's binary output is smaller than every binary format's on every row, plain or compressed, and its url-safe text is smaller than JSON on every row and rivals the binary formats.

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
import { p, CharSets, type Infer } from 'polynar';

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

Each `p.*` factory creates a node for one type, and the node's methods narrow which values it allows. Every method changes the encoding, usually making it denser, rather than only checking values. Methods return a new node; they never change the one they're called on. A schema that contradicts itself, such as `.min(5).max(2)`, throws as soon as it's defined where that can be seen up front, and so does setting `.min`, `.max`, a prior or any other method a second time. A value outside a declared bound, step, length or list throws when it's encoded, and is never rounded to fit. Values the TypeScript types rule out, like a string where a number belongs, aren't checked at runtime. The exceptions are mistakes that would otherwise encode wrong without an error, such as a missing required field or a class instance given to `p.any()`. Object keys outside the shape are dropped.

- [`p.int`](#pint)
- [`p.decimal`](#pdecimalstep-number)
- [`p.float`](#pfloat)
- [`p.string`](#pstring)
- [`p.binary`](#pbinarytype-typedarrayclass)
- [`p.bool`](#pbool)
- [`p.enum`](#penumlist-readonly-unknown)
- [`p.date`](#pdate)
- [`p.uuid`](#puuid)
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
- [`p.any`](#panyhints-pnode)
- [Priors: `.weights()`](#priors-weights)
- [Priors as a function: `.cdf()`](#priors-as-a-function-cdf)
- [Methods](#methods)
- [Priors that learn: `.learn()` and `.adaptive()`](#priors-that-learn-learn-and-adaptive)
- [The predictor: `.adaptive()`](#the-predictor-adaptive)

### `p.int()`

An integer. Infers `number`. Non-integers, NaN and Infinity throw; `-0` is stored as `0`. Huge values are fine as long as the arithmetic stays exact: `p.int().min(0).encode(2 ** 60)` round-trips, while `p.int().min(1).encode(2 ** 53 + 6)` throws because `2 ** 53 + 5` isn't a double.

| Method                                 | Description                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                      | Lower bound, an integer; smaller values throw.                                                                                                                                                                                                                                                                                                                        |
| `.max(n: number)`                      | Upper bound, an integer; larger values throw. With both bounds the value takes exactly log2(max − min + 1) bits. The range can't span more than 2^53 values, and an empty range throws.                                                                                                                                                                               |
| `.cdf(fn: (v: number) => number)`      | Prior over the values from `min` to `max`, called with the value itself; needs both bounds.                                                                                                                                                                                                                                                                           |
| `.weights(w: number[])`                | Prior: one weight per value from `min` to `max`, lowest first; needs both bounds.                                                                                                                                                                                                                                                                                     |
| `.learn(options?: LearningOptions)`    | Prior that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                                                                                                                                                                                                                                                   |
| `.adaptive(options?: AdaptiveOptions)` | Predicts each value from the node's past values, the step it learns between them and the numbers before it in the same object, so counters, timestamps and ids that recur cost a few bits. With both bounds a value the node hasn't seen yet costs what the range takes, and `.weights()` or `.cdf()` price it instead; see [The predictor](#the-predictor-adaptive). |

### `p.decimal(step: number)`

A number on a fixed decimal step, like `p.decimal(0.01)` for cents. Infers `number`. The step must be an exact decimal of at most 15 places (`1 / 3` throws), and both bounds must sit on the step. Values must already sit on the step, so round first: `0.1 + 0.2` throws on step 0.1. Values are stored exactly, except that `-0` becomes `0`. NaN and Infinity throw. An integer step reaches as far as `p.int` does: `p.decimal(1000).encode(1e18)` round-trips. A fractional step keeps values below 2^53 in its last decimal place, about ±9e13 for `0.01` and `0.25` alike; past that, doubles are coarser than the grid.

| Method                                 | Description                                                                                                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                      | Lower bound; smaller values throw.                                                                                                                                                                                           |
| `.max(n: number)`                      | Upper bound; larger values throw. With both bounds the value takes a fixed number of bits: `p.decimal(0.01).min(0).max(100)` fits a price in 2 bytes. The range can't span more than 2^53 values, and an empty range throws. |
| `.cdf(fn: (k: number) => number)`      | Prior over the grid, called with `k` for the k-th multiple of the step (`value / step`); needs both bounds.                                                                                                                  |
| `.weights(w: number[])`                | Prior: one weight per grid point from `min` to `max`, lowest first; needs both bounds.                                                                                                                                       |
| `.learn(options?: LearningOptions)`    | Prior that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                                                                                                          |
| `.adaptive(options?: AdaptiveOptions)` | As on `p.int`, on the value's multiple of the step; see [The predictor](#the-predictor-adaptive).                                                                                                                            |

### `p.float()`

Any double, `-0`, NaN, `Infinity` and `-Infinity` included. Infers `number`. Every value round-trips bit-exact, except that all NaNs come back as the standard NaN; `p.binary(Float64Array)` keeps the raw bits when a NaN's payload matters. Zero takes a byte; integers and short decimals like `65535`, `0.1` or `6.02e23` take 1–6 bytes, simple fractions like `1/3` 2–4; arbitrary doubles take 8, or 9 at extreme magnitudes.

| Method                                 | Description                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.weights(w: Partial<FloatWeights>)`   | Prior over the kinds of number: `zero`, `integer`, `decimal`, `fraction` and `other`, which is noise and arithmetic results that take the full mantissa. Keys left out keep their weight; the default is `{ zero: 1, integer: 3, decimal: 3, fraction: 1, other: 2 }`.                            |
| `.adaptive(options?: AdaptiveOptions)` | Each value names its kind, learned from the message with `.weights()` as where it starts; an integer or a decimal then names its decimal places and goes through the predictor as its digits, and a fraction or other number is written as without; see [The predictor](#the-predictor-adaptive). |

### `p.string()`

Any text, stored with its length; about 7 bits per ASCII character. Infers `string`. Any JS string round-trips bit-exact, lone surrogates included — where UTF-8-based formats substitute U+FFFD, Polynar returns what went in. Lengths count UTF-16 code units, as `.length` does.

| Method                                 | Description                                                                                                                                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                      | Lower bound on the length; shorter strings throw.                                                                                                                                                                                                                          |
| `.max(n: number)`                      | Upper bound on the length; longer strings throw. With both bounds the length takes a fixed number of bits.                                                                                                                                                                 |
| `.length(n: number)`                   | Fixed length, the same as `.min(n).max(n)`; costs zero bits.                                                                                                                                                                                                               |
| `.cdf(fn: (n: number) => number)`      | Prior over the length, called with the length; needs `.max`.                                                                                                                                                                                                               |
| `.weights(w: number[])`                | Prior: one weight per length from `min` (or 0) to `max`, lowest first; needs `.max`.                                                                                                                                                                                       |
| `.adaptive(options?: AdaptiveOptions)` | Predicts each character from what came before it in this field, the rest of the message and the shipped text prior, and ends each string with a symbol instead of a length; a string the node wrote before costs a few bits. See [The predictor](#the-predictor-adaptive). |
| `.charset(c: Charset)`                 | Limits the alphabet, so each character costs fewer bits: a string of unique characters or a `[min, max]` range of character codes, down to a single character or a one-code range. Other characters throw. Can't be combined with `.prose()`, since both set the alphabet. |
| `.prose(model?: ProseModel)`           | Weighted for natural language, about 4 bits per character; English by default, or a model of your own. Every string still encodes.                                                                                                                                         |

`.prose()` prices each character by the one before it: common characters drop to 2–5 bits, and `u` after `q` to under one. Text the model doesn't fit costs more than it would without `.prose()`: Chinese about 15% more, and a long run of one character about half as much again.

The model only sees lowercase words joined by spaces. Each string first names its shape: lowercase, Capitalised or CAPS words joined by spaces, `_` or `-`, Title Case, camelCase or PascalCase. So `USER_NOT_FOUND`, `user-not-found` and `userNotFound` cost about what `user not found` does. A string that fits none of them, like `McDonald's`, is coded as it is, each capital a shift before its letter: cheap at the start of a word, dear inside one.

The built-in model is English (`ProseModels.english`). Any other is a matrix: `{ alphabet, weights }`, where `weights[row][col]` says how likely the character in column `col` is after the one in row `row`. Rows and columns follow `alphabet`, plus one extra each: the last row is used after a character outside the alphabet, and the last column is the escape for such characters. A string's first character uses the space's row, or the last row if the alphabet has no space. `buildProseModel(corpus, options?)` builds a model from the sample text, lowercased, and returns plain JSON. Characters it sees only once are left out of the alphabet; `{ minCount }` or an explicit `{ alphabet }` changes that.

Under `.adaptive()` the bounds still hold: a string never ends below the min, and ends at the max without the end symbol. A charset closes the alphabet to its characters. `.prose()` adds nothing there, and a prose model of your own, a length `.weights()` or `.cdf()` throw next to it.

### `p.binary(type?: TypedArrayClass)`

A typed array: a `Uint8Array` by default, or any typed array class, like `p.binary(Int16Array)`. Infers that class and decodes to a new array of it. Elements are stored as their raw bytes, plus the element count, so floats keep NaN payloads and `-0`. `Float16Array` works too where the environment has it (Node 24 and later, recent browsers).

| Method                                 | Description                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                      | Lower bound on the element count; shorter arrays throw.                                                                                                                                     |
| `.max(n: number)`                      | Upper bound on the element count; longer arrays throw. With both bounds the count takes a fixed number of bits.                                                                             |
| `.length(n: number)`                   | Fixed element count, the same as `.min(n).max(n)`; costs zero bits.                                                                                                                         |
| `.cdf(fn: (n: number) => number)`      | Prior over the element count, called with the count; needs `.max`.                                                                                                                          |
| `.weights(w: number[])`                | Prior: one weight per count from `min` (or 0) to `max`, lowest first; needs `.max`.                                                                                                         |
| `.adaptive(options?: AdaptiveOptions)` | Predicts each byte as `p.string` does its characters, without a shipped prior, and ends each array with a symbol instead of an element count; see [The predictor](#the-predictor-adaptive). |

### `p.bool()`

A boolean, one bit. Infers `boolean`.

| Method                                 | Description                                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.weights(w: [number, number])`        | Prior: one weight per value, as `[true, false]`.                                                                                                      |
| `.learn(options?: LearningOptions)`    | Prior that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                                   |
| `.adaptive(options?: AdaptiveOptions)` | Codes each value as a symbol predicted from the structure around it, with `.weights()` as prior counts; see [The predictor](#the-predictor-adaptive). |

### `p.enum(list: readonly unknown[])`

One value out of a fixed list: `p.enum(['red', 'green', 'blue'])` costs log2(3) ≈ 1.58 bits. Infers the union of the members' types. Members can be anything — strings, numbers, objects, functions — matched by identity (`===`), and decode returns the listed reference itself. The list must be non-empty with unique members, and NaN can't be one. A value outside the list throws. The order of the list is part of the encoding, so reordering it breaks old data unless the schema is wrapped in `p.versioned`.

| Method                                 | Description                                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.weights(w: number[])`                | Prior: one weight per member, in list order.                                                                                                                                            |
| `.learn(options?: LearningOptions)`    | Prior that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                                                                     |
| `.adaptive(options?: AdaptiveOptions)` | Predicts each member as a whole from the members the node wrote before, how recently and next to what, with `.weights()` as prior counts; see [The predictor](#the-predictor-adaptive). |

### `p.date()`

A `Date`, lossless to the millisecond by default. Infers `Date`. An invalid date throws.

| Method                                 | Description                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.min(d: Date \| number)`              | Lower bound, as a `Date` or an integer timestamp a `Date` can hold; earlier dates throw.                                                                                                                                                                                                                                                         |
| `.max(d: Date \| number)`              | Upper bound; later dates throw. With both bounds the date takes a fixed number of bits. The range can't span more than 2^53 buckets, and a min above the max throws.                                                                                                                                                                             |
| `.precision(unit: DateUnit, step = 1)` | Rounds each date down to the start of its UTC bucket: smaller, but lossy. Weeks start on Monday, months and years follow the calendar, and `step` groups units, so `('month', 3)` is quarters. Steps of months and years count from year 0, smaller units from 1970-01-01, so `('day', 7)` starts on a Thursday where `'week'` starts on Monday. |
| `.cdf(fn: (b: number) => number)`      | Prior over the buckets, called with the bucket number, counting from the bucket that holds 1970-01-01 as 0; needs both bounds.                                                                                                                                                                                                                   |
| `.weights(w: number[])`                | Prior: one weight per bucket from `min` to `max`, earliest first; needs both bounds.                                                                                                                                                                                                                                                             |
| `.learn(options?: LearningOptions)`    | Prior that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                                                                                                                                                                                                                              |
| `.adaptive(options?: AdaptiveOptions)` | As on `p.int`, on the date's bucket at the node's precision; see [The predictor](#the-predictor-adaptive).                                                                                                                                                                                                                                       |

`DateUnit` is `'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'`. Bounds compare buckets, so a `min` in the middle of a bucket allows that whole bucket, and a date can decode to a time before `min`.

### `p.uuid()`

A UUID string: lowercase `8-4-4-4-12` hex, as `crypto.randomUUID()` gives it; anything else throws a `RangeError`. Infers `string`. The version digit and the variant bits are coded under weights that favour version 4, then 1 and 7, and RFC 4122's variant, and the other 122 bits as they are, so a v4 UUID takes about 16 bytes against 36 as text. In `p.any([p.uuid()])` it takes every string that is a UUID.

| Method                                 | Description                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `.learn(options?: LearningOptions)`    | The version and variant learn from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive). |
| `.adaptive(options?: AdaptiveOptions)` | The version and variant learn, as under `.learn()`; the other bits carry nothing to predict.                    |

### `p.null()`

`null`, zero bits. Infers `null`. No methods.

### `p.object(shape: Record<string, PNode>)`

An object with a fixed shape: `p.object({ x: p.int(), label: p.optional(p.string()) })`. Infers the object type. Fields are written in shape order, and keys outside the shape are left out. A field can be left out when its node takes `undefined`, such as `p.optional`, `p.any()` or a union with a `p.optional` member. Such a field infers an optional key and decodes with its key left out. Any other field that is missing or `undefined` throws.

| Method                                 | Description                                                                                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.adaptive(options?: AdaptiveOptions)` | Codes where the object starts and ends as symbols, its keys implied, and every field as under its own `.adaptive()`; the strings and numbers of one object are predicted from each other. See [The predictor](#the-predictor-adaptive). |

### `p.array(item: PNode)`

An array of one item type, stored with its length. Infers an array of the item's type. Arrays nest.

| Method                                 | Description                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                      | Lower bound on the item count; shorter arrays throw.                                                                                                                                                          |
| `.max(n: number)`                      | Upper bound on the item count; longer arrays throw. With both bounds the count takes a fixed number of bits.                                                                                                  |
| `.length(n: number)`                   | Fixed item count, the same as `.min(n).max(n)`; costs zero bits.                                                                                                                                              |
| `.cdf(fn: (n: number) => number)`      | Prior over the item count, called with the count; needs `.max`.                                                                                                                                               |
| `.weights(w: number[])`                | Prior: one weight per count from `min` (or 0) to `max`, lowest first; needs `.max`.                                                                                                                           |
| `.learn(options?: LearningOptions)`    | Prior over the item count that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                                                                       |
| `.adaptive(options?: AdaptiveOptions)` | Codes where the array starts and ends as symbols instead of its count, which `.min()` and `.max()` still bound, and the items as under their own `.adaptive()`; see [The predictor](#the-predictor-adaptive). |
| `.sorted()`                            | Items must be in ascending order; a smaller item after a larger one throws. Can't be combined with `.unordered()`.                                                                                            |
| `.unique()`                            | Items must be distinct; a repeat throws.                                                                                                                                                                      |
| `.unordered()`                         | Items are written in any order and decode in ascending order.                                                                                                                                                 |

The last three need items of `p.string`, or with a fixed set of values: bounded `p.int`, `p.date` or `p.decimal`, `p.enum` or `p.bool`, without `.weights()`, `.learn()` or `.adaptive()` of their own. Ascending means by value, enum members in list order, `true` before `false`, and strings by UTF-16 code units, as JS sorts them. Each restriction leaves fewer possible arrays, and the encoding drops exactly what it rules out: 1000 distinct sorted `u32` ids take about 2950 bytes instead of 4000, and a shuffled 52-card deck with `.unique()` 29 bytes instead of 38. `p.map`, `p.record` and `p.set` keys are distinct already, so there `.unordered()` alone does the same.

Strings are written ascending, each as how many leading characters it shares with the one before, then the rest in the string node's own spelling, so `.charset()`, `.prose()` and `.adaptive()` still apply. With `.unique()` alone an array takes the shorter of that followed by their order and the strings as they stand, at the cost of a bit to say which. 1000 distinct English words with `.unordered()` take about 4350 bytes instead of 6240, and 1000 URLs about 13 KB instead of 57 KB.

Under `.adaptive()` on the array, `.sorted()`, `.unique()` and `.unordered()` still hold, the items going one by one, ascending unless they keep their order. A count `.weights()` or `.cdf()` throws next to `.adaptive()` on `p.array`, `p.map`, `p.record` and `p.set`.

### `p.map(key: PNode, value: PNode)`

A `Map` from one key type to one value type: `p.map(p.string(), p.int())` is `Map<string, number>`. Keys can be any node, and entries are stored with their count, in insertion order.

| Method                                 | Description                                                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.min(n: number)`                      | Lower bound on the entry count; smaller maps throw.                                                                                                                          |
| `.max(n: number)`                      | Upper bound on the entry count; larger maps throw. With both bounds the count takes a fixed number of bits.                                                                  |
| `.length(n: number)`                   | Fixed entry count, the same as `.min(n).max(n)`; costs zero bits.                                                                                                            |
| `.cdf(fn: (n: number) => number)`      | Prior over the entry count, called with the count; needs `.max`.                                                                                                             |
| `.weights(w: number[])`                | Prior: one weight per count from `min` (or 0) to `max`, lowest first; needs `.max`.                                                                                          |
| `.learn(options?: LearningOptions)`    | Prior over the entry count that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                                     |
| `.adaptive(options?: AdaptiveOptions)` | Codes where the map starts and ends as symbols instead of its count, and the keys and values as under their own `.adaptive()`; see [The predictor](#the-predictor-adaptive). |
| `.unordered()`                         | Entries are written in any order and decode in ascending key order, so insertion order is lost; see [`p.array`](#parrayitem-pnode).                                          |

### `p.record(value: PNode)`

A plain object with any string keys and one value type: `p.record(p.int())` is `{ [key: string]: number }`. It's stored like `p.map(p.string(), value)`, or `p.map(p.string().adaptive(), value)` under `.learn()`, and decodes to a plain object; under `.adaptive()` each key is a key symbol and its characters. Unlike `p.object`, every key is written, so it suits dictionaries whose keys aren't known up front. A record counts as an object, so it can't sit next to `p.object` or `p.tagged` in a `p.union`. Same methods as `p.map`; with `.unordered()` the keys decode in ascending order, as `p.array` sorts strings.

### `p.set(item: PNode)`

A `Set` of one item type: `p.set(p.string())` is `Set<string>`. Items are stored with their count, in insertion order. Same methods as `p.map`, bounding and weighing the number of items, and with `.unordered()` decoding the items in ascending order.

### `p.optional(node: PNode)`

A value or `undefined`, at the cost of one bit: `p.optional(p.int())` is `number | undefined`. As an object field it can be left out: it infers an optional key, and a missing key and an `undefined` value both decode with the key left out. Only `undefined` means absent; `null` is a value and goes to the inner node. Wrapping twice is the same as once.

| Method                                 | Description                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.weights(w: [number, number])`        | Prior on presence, as `[present, absent]`.                                                                                                                                                                               |
| `.learn(options?: LearningOptions)`    | Prior on presence that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                                                                                          |
| `.adaptive(options?: AdaptiveOptions)` | Codes whether the value is there as a symbol predicted from the structure around it, with `.weights()` as prior counts, and the inner node as under its own `.adaptive()`; see [The predictor](#the-predictor-adaptive). |

### `p.nullable(node: PNode)`

A value or `null`: `p.nullable(p.string())` is `string | null`, written the same as `p.union([p.string(), p.null()])`. Unlike a union it takes any node, `p.lazy` and `p.any()` included. Wrapping twice is the same as once.

| Method                                 | Description                                                                                                                                                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.weights(w: [number, number])`        | Prior: one weight per side, as `[value, null]`.                                                                                                                                                                                               |
| `.learn(options?: LearningOptions)`    | Prior that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                                                                                                                           |
| `.adaptive(options?: AdaptiveOptions)` | Codes a null as a symbol of its own in place of the value's kind, predicted from the structure around it, with `.weights()` as prior counts, and the inner node as under its own `.adaptive()`; see [The predictor](#the-predictor-adaptive). |

### `p.union(members: PNode[])`

One of several members: `p.union([p.string(), p.int(), p.array(p.string())])` is `string | number | string[]`. The member is picked by the value's kind: string, number, bigint, boolean, null, undefined, date, regular expression, array, map, set, object, ArrayBuffer, DataView, or the class of a typed array. Each kind can belong to one member, so two array or two object members throw, and so does `p.enum(['bold', 'italic'])` next to `p.string()`: an enum has the kind of its members. Members must know their kinds, so `p.lazy`, a `p.nullable` or `p.optional` around one, and custom nodes without `_kinds` can't be members; `p.lazy` inside a container, like `p.array(p.lazy(…))`, is fine. `p.any()` takes nearly every kind, so it overlaps with almost any other member. A value whose kind has no member throws. Recording which member was used costs log2(members) bits.

| Method                                 | Description                                                                                                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.weights(w: number[])`                | Prior: one weight per member, in list order.                                                                                                                                                                                                                                |
| `.learn(options?: LearningOptions)`    | Prior that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                                                                                                                                                         |
| `.adaptive(options?: AdaptiveOptions)` | Codes the member as the symbol of the value's kind (a string, an integer, a number, true, false…), predicted from the structure around it, with `.weights()` as prior counts, and each member as under its own `.adaptive()`; see [The predictor](#the-predictor-adaptive). |

### `p.tagged(key: string, members: Record<string, PObject>)`

Object shapes picked by a tag field:

```typescript
p.tagged('type', {
  move: p.object({ x: p.int(), y: p.int() }),
  chat: p.object({ text: p.string().max(200) }),
}); // { type: 'move'; x: number; y: number } | { type: 'chat'; text: string }
```

The tag costs log2(members) bits and is never written as text. The order of the members is part of the encoding, so reordering them breaks old data unless the schema is wrapped in `p.versioned`. The tag key belongs to the tagged union, so a member shape that also declares it throws, and so does a value whose tag isn't listed. Tags can't be numbers like `'2'`, because JS would list them before the others. A tagged union counts as an object, so it can sit next to other kinds in `p.union`.

| Method                                 | Description                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `.weights(w: number[])`                | Prior: one weight per member, in key order.                                                                                            |
| `.learn(options?: LearningOptions)`    | Prior that learns from the message; see [Priors that learn](#priors-that-learn-learn-and-adaptive).                                    |
| `.adaptive(options?: AdaptiveOptions)` | Predicts the tag as `p.enum` does its members, and codes each member as `p.object` does; see [The predictor](#the-predictor-adaptive). |

### `p.lazy(resolve: () => PNode)`

A node looked up on first use, so a schema can contain itself or refer to one defined further down; it costs nothing on the wire. Infers the resolved node's type. Its kinds are unknown until first use, so it can't be a `p.union` member; `p.nullable` and `p.optional` take it either way round. A value nested more than 512 lazy references deep, which includes a value that contains itself, throws a `RangeError` without the path in front, and a `p.lazy` that comes back to itself without reaching a node throws a `TypeError` on first use. No methods.

### `p.versioned(first: PNode, ...later: (PNode | [PNode, (previous) => next])[])`

A schema that can change after data has been written. The first argument is the first version. Each later argument is either a plain node, when old values still fit it (a wider bound, an added optional field, a removed field), or `[node, migrate]`, where `migrate` turns a value of the previous version into one of the new. Infers the newest version's type. Earlier versions stay in the list: replacing one instead of adding after it makes data written with it undecodable.

Data written by any listed version decodes and is migrated step by step to the newest. Each step's result is checked by that version's node, and the newest is read back from its own bytes, so old data comes out exactly as newest data would. A result a version can't encode throws as encoding it would, with the versions named: a bug in the schema, not bad input, so never a `CorruptInputError`. The encoder always writes the newest, so decoding old data and encoding it again gives new bytes. Data from a version the schema doesn't list throws `UnknownVersionError`, whose `version` is the version the data was written by and `known` how many versions the schema lists. The version number costs a couple of bits. The wrapper has to be there before the first data is written: data written without it carries no version, and nothing can tell its versions apart later.

| Method                                 | Description                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.walk(value, from?: PNode \| number)` | Upgrades a value of an older version to the newest, as decoding old data does: an object already in hand, with its version known. The value is of the first version, of the version whose node is `from`, or of version `from` counting from 1. The migrations get a copy, so the value passed in stays as it is. |

`User.walk({ name: 'Ada' })` gives what data written by the first version decodes to.

### `p.any(hints?: PNode[])`

Self-describing escape hatch: numbers, bigints, strings, booleans, dates, regular expressions, null, undefined, ArrayBuffers, DataViews, typed arrays (`Float16Array` included, where the environment has it), arrays, plain objects, Maps and Sets, with a type tag per value. Infers `AnyValue`, the type of exactly those values; an object typed with an interface needs an index signature to count as one. Numbers round-trip as they do through `p.float`, though written their own way, so sizes differ: `255` takes 2 bytes against 4, `2 ** 52` 8 against 2. Everything else round-trips bit-exact, and a typed array decodes as the same class. A regular expression keeps its source and flags but not its `lastIndex`, and a DataView decodes over a new buffer of just its bytes. A key holding `undefined` is kept, where `p.object` leaves it out. Only an object's own enumerable string keys and an array's elements travel: symbol keys, non-enumerable properties and extra properties on an array are left out, and an object with a null prototype decodes as a plain one. Shared references and holes in sparse arrays aren't kept: an object that appears twice comes back as two separate copies, and a hole comes back as `undefined`. A subclass of any of these, such as a `Buffer` or a class extending `RegExp` or `Map`, decodes as the built-in class. Any other class instance throws a `TypeError`, and so do errors and boxed primitives like `new Number(1)`. Nesting containers more than 512 levels deep, which includes a value that contains itself, throws a `RangeError` without the path in front. Costs more than a precise node.

Hints are nodes some values are expected to fit: `p.any([p.string().charset(CharSets.hex).length(32)])`. Each value, at any depth, tries the hints that take its kind in order, and the first that writes it codes it behind a tag of its own. A hint only takes values it gives back unchanged. A hint needs declared kinds, so `p.lazy` and custom nodes without `_kinds` throw.

| Method                                 | Description                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.adaptive(options?: AdaptiveOptions)` | Codes the values through the predictor as one stream: each value's kind as a symbol of the structure, an object's keys as text, strings, integers and dates predicted from the values before them at the same key path, other numbers as their shortest text, and the rest as without. Hints are used as under their own `.adaptive()`. See [The predictor](#the-predictor-adaptive). |

Under `.adaptive()` the status feed, a hundred strings from a set of three, averages 21.4 bytes instead of 290.8, the keys of an array of same-shaped objects soon cost next to nothing, and lorem costs less than under `.prose()`. Thirteen real JSON documents (GitHub and npm API responses, GeoJSON, a Slack export and more) take 88.2 kB, where JSON with brotli takes 128.9 kB.

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
- Encoder and decoder must get identical numbers from it, so stick to `+ - * /` and `Math.floor`; `Math.exp` and friends round differently per engine.

### Methods

A node writes each value by its plain spelling unless a method says otherwise: `.weights()` and `.cdf()` set the odds a value is coded under, `.sorted()`, `.unique()` and `.unordered()` drop what a restricted order rules out, and `.learn()` and `.adaptive()` learn from the message as it goes, as the next two sections describe.

### Priors that learn: `.learn()` and `.adaptive()`

`.learn()` makes a node's own prior learn from the message. The weights, or one per value when none are given, are where it starts; every value the node then writes counts as one observation, so values that keep recurring get cheaper as the message goes on. The encoder tries a few learning rates per message and says which one it used, so there is nothing to tune.

```typescript
p.array(p.enum(['ok', 'warn', 'error']).learn()).length(100); // a feed that is mostly 'ok': about 9 bytes instead of 20
p.array(p.int().min(0).max(1000).learn()).max(500); // readings that keep coming back
p.array(p.object({ id: p.int(), note: p.optional(p.string()).learn() })); // notes that are mostly absent
```

The prior is what `.weights()` sets: the value of a `p.bool`, `p.enum`, `p.int`, `p.decimal` or `p.date`, the side of a `p.optional` or `p.nullable`, the member of a `p.union` or `p.tagged`, the count of an array, map, record or set. It works with weights but not with `.cdf()`, since a function can't count. A range without bounds or wider than 65536 values, and a length or count without a max, learns by the bit-length class of its distance from the min, else the max, else 0.

`.learn({ window, separate })` sets what the prior learns by:

- `window` is how many observations the counts hold before they halve, so the newest weigh most. It is 1024 when left out, and a node with more values than the window raises it to that number.
- `separate` keeps the node apart, as the rest of this section describes.

`.adaptive(options?)` hands a node's values to [the predictor](#the-predictor-adaptive) instead. On `p.object`, `p.array`, `p.map`, `p.record`, `p.set`, `p.optional`, `p.nullable`, `p.union` and `p.tagged` it reaches every node below as well, through `p.lazy` and `p.versioned` too, so one call puts a whole schema on the predictor:

```typescript
p.array(p.object({ id: p.int(), name: p.string(), tags: p.array(p.enum(['a', 'b'])) })).adaptive();
```

A node below with an `.adaptive(options)` of its own keeps its options, a node with `.learn()` keeps its learned prior and the nodes below it stay as they are, and a node used in two places stays one node. `.learn()` and `.adaptive()` don't go together on one node.

Every value one node writes in a message goes through one table, so array items, record values and recursion learn from each other. The same node placed in two fields shares its table; two separate nodes don't, but a node can start from what its kind learned: once another node of the same kind and window has learned in the message, its fastest learning rate is replaced by a blend of what they learned, which its own values soon outweigh. The fields of an API response that all hold URLs, ids or counts then learn sooner, and a field unlike the others keeps its own rates, so it loses next to nothing. `separate` keeps a node apart. From its second value on, a table spends one bit to stay static, a few more to pick a learning rate, so a message too short to learn from costs about one bit more, and a node written once per message costs nothing extra. It pays when many values go through one node in one message; one value per message gains nothing.

### The predictor: `.adaptive()`

`.adaptive()` hands a node's values to the similarity predictor. It codes a message as one stream of symbols: the characters of strings and keys, the bytes of binaries, and the structure around them as JSON spells it, where an object or array starts and ends, the kind of every value and whether an optional field is there. Each symbol is predicted from the positions in the message whose context looks like the current one, in the same field, in every other field of the message and in a prior that ships with the package, and it learns as it goes, so text, ids, URLs and keys that resemble what came before cost little. Whole values are predicted as well: a value a field held before costs a few bits, and a number is predicted from the field's past values and the numbers around it. Strings start from a prior trained on English text and binaries from nothing; every other node, and every node under one `.adaptive()` on a container or `p.any`, starts from a prior trained on JSON documents. What each node codes this way is in its section.

```typescript
p.string().adaptive(); // alice.txt: 43,364 bytes, where brotli takes 51,615
p.array(p.string().adaptive()); // a list of strings, each predicted from the ones before it
p.binary().adaptive(); // bytes, a closed alphabet of 256
```

It is slow next to every other node: about 60 microseconds per character on each side for alice.txt and 36 for the JSON documents, against 0.05 for them under plain `p.any()`, and a 40-character object takes about 0.8 milliseconds. It holds around 2 kB of memory per character the message has coded so far, 370 MB by the end of alice.txt. Use it where size matters more than time, on messages of up to a few hundred kilobytes.

| Option                  | Description                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prior?: Prior`         | The prior the predictor starts from; the shipped one when left out.                                                                                                                                                                          |
| `separate?: boolean`    | Keeps the node's values to themselves instead of learning from every other field of the message, false when left out.                                                                                                                        |
| `window?: number`       | How many symbols the counts hold before they halve, so the newest weigh most; no halving when left out. 16384 costs 0.1–0.7% more and 4096 1–3% more.                                                                                        |
| `order?: number`        | The longest context the counts keep; it is the prior's, so it must match it. The shipped priors are order 8, and `train()` keeps the order of `from`.                                                                                        |
| `candidates?: number`   | How many earlier positions of the longest context are followed further back, 0 to 64, 8 when left out. 0 costs the documents 0.3–0.6% more for 4% less time; 16 changes nothing.                                                             |
| `offsets?: number`      | How many past values vote by their character at the same offset, 0 to 1024, 64 when left out. 256 saves the documents 0.1% for 5% more time; 8 costs 0.1–0.2%.                                                                               |
| `history?: number`      | How many past values vote as whole values with every feature, 1 to 4096, 64 when left out. 256 saves 0.7% under a schema for 15–25% more time; 16 costs 0.3–0.5%.                                                                            |
| `quantisation?: number` | The total every coded distribution is scaled to, a power of two from 2^12 to 2^24, 2^16 when left out. 2^20 saves 0.14% on the documents under `p.any().adaptive()` and 0.02–0.03% on the other two, at the same speed; 2^12 costs 1.5–3.5%. |

The sizes beside each option are measured on the thirteen JSON documents under `p.any().adaptive()` and under their declared schemas, and on alice.txt, against the defaults; alice.txt moves by more than a few bytes only with `window` and `quantisation`.

The options are part of the schema, as everything else is.

#### Priors

Two priors ship with the package, as `Priors.text` and `Priors.json`. The text prior is trained on the `man bash` page, the string values of thirteen JSON documents (the first 12,000 characters of each) and a list of first names; strings start from it, and binaries take its learned weights without its characters. The JSON prior is trained on those thirteen documents whole, and every other node starts from it. Each holds the weights the predictor learned and how often each character follows another, the 2,500 most frequent pairs.

`train(node, samples, options?)` makes one from your own data. Each sample is one message of `node`, which needs `.adaptive()` on itself or somewhere below it, and the result is plain JSON you can store and pass as `.adaptive({ prior })`; the same samples give the same prior on every engine.

| Option                                                      | Description                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `holdOut?: number`                                          | The share of samples held out to pick the learning rates on, 0.5 when left out; 0 keeps those of `from`.                                      |
| `from?: Prior`                                              | The prior training starts from; the shipped one the node would use when left out.                                                             |
| `epochs?: number`                                           | How many times training goes over the samples, 3 when left out.                                                                               |
| `seed?: number`                                             | The order of the samples and which ones are held out, 1 when left out.                                                                        |
| `grid?: { eta?: number[]; rho0?: number[]; n0?: number[] }` | The learning rates `holdOut` tries, in the units of the prior's `constants`; every combination of three, four and three values when left out. |

It is an offline tool: it codes every sample `epochs` times, and with `holdOut` does that for each of 36 combinations of learning rates first; the text prior's half a megabyte of samples took under an hour. The full grid takes minutes per combination for strings but hours in all for whole messages, so a prior of whole messages narrows it: the shipped JSON prior keeps its `rho0` and `n0` and tries `eta` alone.

## Encoding and decoding

Every node has these two methods, where `T` is the type it infers.

| Method                                                                                                                                | Description                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.encode(value: T, options?: { type?: 'binary' \| 'text'; charset?: Charset; checksum?: number })`                                    | Encodes to a `Uint8Array`, or to a string when `type` is `'text'`. |
| `.decode(input: Uint8Array \| string, options?: { type?: 'binary' \| 'text'; charset?: Charset; checksum?: number; limit?: number })` | Decodes bytes or text made by `encode` with the same options.      |

```typescript
const bytes = User.encode(user); // Uint8Array
User.decode(bytes);

const link = User.encode(user, { type: 'text', charset: CharSets.urlSafe }); // text, here safe to put in a URL
User.decode(link, { charset: CharSets.urlSafe });
```

`decode` can tell bytes from text by the input itself, so `type` is optional there and only checked by TypeScript. Text output is written directly in the charset's symbols, not as the binary output run through Base64, so `atob` doesn't turn it into the bytes.

A message has no end marker: `decode` expects its input to end where the message does, so two messages back to back throw `Unread or corrupted data at end of input`. To keep several messages in one stream, put each one's length in front of it, or encode them together as one `p.array`.

Decoding gives back the value that was encoded. Encoding a decoded message again usually gives the same bytes, but not always, so checking integrity is the job of `checksum`. A value's bytes can depend on what the same node wrote earlier in the message.

`limit` caps how many values `decode` reads past the end of its input; see [Errors](#errors).

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
| `CharSets.hex`          | `0123456789abcdef`              |
| `CharSets.hihex`        | `0123456789ABCDEF`              |
| `CharSets.lowalpha`     | `a`–`z`                         |
| `CharSets.hialpha`      | `A`–`Z`                         |
| `CharSets.alpha`        | all letters                     |
| `CharSets.alphanumeric` | letters and digits              |
| `CharSets.asciiSafe`    | printable ASCII                 |
| `CharSets.htmlSafe`     | printable ASCII without `"&'<>` |
| `CharSets.base64`       | standard Base64                 |
| `CharSets.urlSafe`      | letters, digits and `-._~`      |

## Errors

The decoder doesn't check its input; that is the job of `checksum`. It throws a `CorruptInputError` only where the input can't be a message at all, such as a character outside the charset or input left over once the value is read. Without a `checksum`, damaged or truncated input decodes to whatever value those bytes encode, and reading past the end of the input reads zeros; with one it throws instead, except with probability 2^-k. Reading zeros past the end stops at the decode option `limit`, 2^20 values by default (`Infinity` for none), past which `decode` throws a `CorruptInputError`, so a damaged length can't make it build a huge value out of nothing. Its subclass `UnknownVersionError` is thrown when `p.versioned` gets data from a version it doesn't list.

A value that can't be encoded throws with its path in front and the limit it broke, like `filters[2].op: Value "gt" is not one of "eq", "lt"` or `tags: Array length 5 is above the maximum 3`. A migration in `p.versioned` whose result doesn't fit throws the same way when old data is decoded, with the versions after the message, like `n: Value 500 is above the maximum 10, in data migrated from version 1 to 2`; a migration that throws gets `, in migrating version 1 data to version 2` appended. A value outside what the schema allows — a bound, step, length, list, tag, charset or nesting depth — throws a `RangeError`. A value the schema has no place for at all throws a `TypeError`: a non-integer, a non-finite number, an invalid date, a missing required field, a kind no union member takes, or a type `p.any` can't encode. An invalid schema throws a `TypeError` or `RangeError` as soon as it's defined.

## Types

- `Infer<typeof Node>` — the decoded type of any node.
- `InferShape<S>`, `InferTagged<K, M>` — the types `p.object` and `p.tagged` infer, from a shape or a member map.
- `AnyValue` — the values `p.any` encodes and decodes.
- `Cdf` — `(v: number) => number`, the function `.cdf()` takes.
- `FloatWeights` — `{ zero, integer, decimal, fraction, other }`, what `p.float().weights()` takes.
- `LearningOptions` — `{ window?: number; separate?: boolean }`, what `.learn()` takes.
- `AdaptiveOptions` — what `.adaptive()` takes; see [The predictor](#the-predictor-adaptive).
- `Prior` — a prior the predictor starts from, as `AdaptiveOptions.prior` takes it and `train` returns; `Priors.text` and `Priors.json` are the shipped ones.
- `TrainOptions` — what `train` takes; see [Priors](#priors).
- `MemberPrior` — `{ weights?: readonly number[]; rows?: readonly (readonly number[])[]; learn?: LearningOptions }`, the prior `members` takes.
- `Members` — what `members` returns: its `count`, its `radix` when every member is equally likely, `write(enc, pos, row?)` and `read(dec, row?)`.
- `Bucket` — `[cum, freq, total]`, one coding's range for a symbol, as `composeAlternatives` takes it.
- `DateUnit` — the units `.precision()` takes.
- `Kind` — the kinds `p.union` tells apart, and the type of `_kinds`.
- `ProseModel`, `ProseModelOptions` — a prose matrix and the options of `buildProseModel`.
- `TypedArray`, `TypedArrayClass` — what `p.binary` takes and returns.
- `Float16ArrayLike` — a `Float16Array` as `TypedArray` describes it, for TypeScript setups whose `lib` has no `Float16Array`.
- `Charset` — `string | readonly [number, number]`, for output and `.charset()`.
- `OutputType` — `'binary' | 'text'`.
- `DecodeOptions` — what `new Decoder()` takes: the charset, `checksum` and `limit`.
- `CodecOptions` — the options of `encode` and `decode`. Without a type argument it has no `type`, so one options object works for both forms; `CodecOptions<'text'>` requires `type: 'text'`, so `encode` with it returns a string, and `CodecOptions<'binary'>` and `CodecOptions<OutputType>` take it optionally.

The node classes are exported too (`PNode`, `PInt`, `PString`, `PObject`, …), along with `ProseModels`, `buildProseModel`, `Priors`, `train`, `members` and `MessageState`.

## Custom nodes

Subclass `PNode` and implement two methods: `_write` writes one value's digits, and `_read` reads them back in the same order. `_read` reads exactly what `_write` wrote: reading too little throws on decode, but one read too many at the very end can go unnoticed. The node then works inside `p.object`, `p.array` and `p.optional` like any built-in. To use it in `p.union`, also set `_kinds` to the kinds its values have, like `readonly _kinds = ['object'] as const`. A node that can return `undefined` needs nothing extra for an object field using it to be left out, but one that declares `_kinds` lists `'undefined'` among them. See [`examples/custom-node.ts`](https://github.com/Phaen/Polynar/blob/master/examples/custom-node.ts) for a runnable version.

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

| Method                                                                                                      | Description                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Encoder()`                                                                                             | An empty message.                                                                                                                                                                                                                                                                                                                         |
| `enc.compose(integer: number, radix: number)`                                                               | One digit in a fixed radix: `integer` in `[0, radix)`, `radix` a positive safe integer; anything else throws.                                                                                                                                                                                                                             |
| `enc.composeTerm(integer: number)`                                                                          | Any non-negative integer, no bound needed.                                                                                                                                                                                                                                                                                                |
| `enc.composeWeighted(cum: number, freq: number, total: number)`                                             | Writes a weighted value: the range `[cum, cum + freq)` out of `total`. Costs log2(total / freq) bits.                                                                                                                                                                                                                                     |
| `enc.state<S>(key: object, init: () => S)`                                                                  | A slot of per-message state keyed by an object, usually the node itself: `init` creates it on the message's first call, and later calls return it.                                                                                                                                                                                        |
| `enc.composeSelector(group: object, choices: readonly Bucket[])`                                            | Opens a choice among codings of the same symbols for `group`, once, before its first symbol. `choices[i]` is the `Bucket` the choice is written as under coding i, all out of one total. The encoder keeps the coding whose choice and symbols cost the fewest bits and writes its bucket here; the decoder reads it as a weighted value. |
| `enc.composeAlternatives(group: object, buckets: readonly Bucket[])`                                        | One symbol of `group`, as the `Bucket` each coding gives it: `buckets[i]` is the symbol under coding i.                                                                                                                                                                                                                                   |
| `enc.output(options?: CodecOptions)`                                                                        | The message as bytes, or as text when `type` is `'text'`, with the same options as `encode`.                                                                                                                                                                                                                                              |
| `new Decoder(input: Uint8Array \| string, options?: DecodeOptions)`                                         | Reads bytes or text made with the same options.                                                                                                                                                                                                                                                                                           |
| `dec.parse(radix: number)`                                                                                  | Reads what `compose` wrote.                                                                                                                                                                                                                                                                                                               |
| `dec.parseMany(radix: number, count: number)`                                                               | Reads `count` digits that `compose` wrote with the same radix, as one array. Faster than calling `parse` that many times.                                                                                                                                                                                                                 |
| `dec.parseTerm()`                                                                                           | Reads what `composeTerm` wrote.                                                                                                                                                                                                                                                                                                           |
| `dec.parseWeighted<T>(total: number, locate: (residual: number) => [symbol: T, cum: number, freq: number])` | Reads what `composeWeighted` wrote. `locate` gets a number below `total` and returns the symbol whose range holds it, with that range's `cum` and `freq`.                                                                                                                                                                                 |
| `dec.state<S>(key: object, init: () => S)`                                                                  | The decoder's slot for `key`, as `enc.state`.                                                                                                                                                                                                                                                                                             |
| `dec.finalize()`                                                                                            | Throws `CorruptInputError` when part of the input was left unread; `decode` calls it for you.                                                                                                                                                                                                                                             |
| `dec.charge(count: number)`                                                                                 | Call right after reading a length, before reading its `count` items: items that only the end of the input would supply count against `limit` at once.                                                                                                                                                                                     |
| `dec.digits`                                                                                                | The input's length in digits.                                                                                                                                                                                                                                                                                                             |

A node that picks one of a fixed number of members can spell it through `members(count: number, prior: MemberPrior | undefined, who: string)`, which returns a `Members`: the same object every built-in uses for its enums, booleans and tags. Its `write(enc, pos)` and `read(dec)` are uniform without a prior, weighted like `.weights()` with `{ weights }`, and learning like `.learn()` with `{ learn: options }`; `who` names the node in errors, and its kind: tables of the same `who`, count, weights and window learn as one kind. `{ rows }` gives one weight list per context in place of `weights`, and `write` and `read` then take the row as a third argument. One `Members` is one table, so the three channels below learn from each other, and three separate ones would each keep their own, starting from what the others learned.

```typescript
import { p, PNode, Encoder, Decoder, members } from 'polynar';
import type { LearningOptions, MemberPrior, Members } from 'polynar';

class PColor extends PNode<{ r: number; g: number; b: number }> {
  private readonly channel: Members;

  constructor(private readonly prior: MemberPrior = {}) {
    super();
    this.channel = members(256, prior, 'PColor');
  }

  learn(options?: LearningOptions): PColor {
    return new PColor({ ...this.prior, learn: options ?? {} });
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

const Palette = p.array(new PColor().learn()).max(64);
```

## Examples

### Shareable URL state

```typescript
import { p, CharSets } from 'polynar';

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

const Block = p.tagged('type', {
  paragraph: p.object({ text: p.string() }),
  list: p.object({ items: p.array(p.lazy((): PNode<Block> => Block)) }),
});
```

TypeScript can't infer a type that refers to itself, hence the explicit `PNode<Block>` on the `p.lazy` callback. Annotating the callback rather than `Block` keeps `Block`'s own type, methods like `.weights()` included.

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

### A prior trained on your data

```typescript
import { p, train } from 'polynar';

const Event = p.object({ type: p.string(), at: p.date(), user: p.string() });
const prior = train(p.array(Event).adaptive(), batches); // batches: arrays of events from your logs; plain JSON you can store
const Batch = p.array(Event).adaptive({ prior });
```

Both sides need the same prior, like any other part of the schema.

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
