# Changelog

## Unreleased

`.adaptive()` is now `.compress()`: one predictor for every node that learns, in place of the separate adaptive engines. Messages written with `.adaptive()` by an earlier version don't decode with this one.

### Added

- `.compress(options?: CompressOptions)` on `p.int`, `p.decimal`, `p.date`, `p.float`, `p.string`, `p.binary`, `p.bool`, `p.enum`, `p.uuid`, `p.object`, `p.array`, `p.map`, `p.record`, `p.set`, `p.optional`, `p.nullable`, `p.union`, `p.tagged` and `p.any`. Its options are `prior`, `window`, `separate`, `order`, `candidates`, `offsets`, `history` and `quantisation`.
- On a container, an optional, a nullable, a union or a tagged union, `.compress()` reaches every node below it that has no `.compress()` or `.adapt()` of its own, so one call puts a whole schema on the predictor.
- Two priors ship with the package: one trained on English text, names and JSON string values, which strings start from, and one trained on JSON documents, which every other node starts from. They are exported as `Priors.text` and `Priors.json`.
- `train(node, samples, options?)`, which makes a prior from your own data to pass as `.compress({ prior })`.
- `p.uuid()`, a lowercase UUID string in about 16 bytes.
- The types `CompressOptions`, `Prior` and `TrainOptions`.

### Changed

- `p.any().compress()` codes the whole message as one predicted stream: each value's kind and an object's start and end as symbols, keys as text, strings, integers and dates predicted from the values before them at the same key path. It no longer builds a schema as the message goes.
- Under `.compress()` a string or binary ends with a symbol instead of its length, and an array, map, record or set with a symbol instead of its count; `.min()` and `.max()` still bound them.
- `.learn()` is now `.adapt()`, with `AdaptOptions` in place of `LearningOptions`; it takes the `{ window, separate }` that `.learning()` took.
- `.adapt()` and `.compress()` can't both be set on one node. A custom prose model, or a length or count `.weights()` or `.cdf()`, throws next to `.compress()`.
- `.compress()` is slow next to every other node: about 60 microseconds per character on each side for English text and 36 for JSON documents, and around 2 kB of memory per character a message has coded so far. Plain `p.any()` runs within 2% of its earlier speed.
- Sizes, under `p.any().compress()` in the README's first table: the user profile 29.5 → 26.7 bytes, the chat message 44.0 → 41.8, the sensor reading 24.3 → 22.6, the shopping cart 28.8 → 27.0 and lorem 570 → 529; the GPS position 15.3 → 17.6 and the status feed 18.6 → 21.4. Lorem under its tuned schema 569 → 528. The thirteen JSON documents 91.7 kB → 88.2 kB.

### Removed

- `.contexts()`, `.words()`, `.codepoints()`, `.delta()`, `.recall()`, `.repeats()`, `.digits()`, `.positional()`, `.terminated()`, `.follows()` and `.learning()`.
- `.learn()` on `p.string`, `p.binary` and `p.float`; `.compress()` covers them.
