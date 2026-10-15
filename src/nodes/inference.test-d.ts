/**
 * Type-inference assertions. This file is NOT a Jest suite (it lives outside
 * __tests__ and is named *.test-d.ts), but IS compiled by `npm run typecheck`
 * (the base tsconfig excludes only *.test.ts). A wrong inference makes `Equals`
 * resolve to `false`, so `= true` fails to compile and typecheck goes red.
 */
import { p } from './p';
import { PVersioned } from './versioned';
import type { Infer } from './infer';
import type { AnyValue } from './any';
import type { TypedArray } from './guards';
import type { CodecOptions } from '../packer';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Person = p.object({
  name: p.string().max(20),
  age: p.int().min(0).max(120),
  active: p.bool(),
  role: p.enum(['admin', 'user', 'guest']),
  bio: p.optional(p.string()),
});
const _person: Equals<
  Infer<typeof Person>,
  {
    name: string;
    age: number;
    active: boolean;
    role: 'admin' | 'user' | 'guest';
    bio?: string;
  }
> = true;

// Scalars.
const _int: Equals<Infer<ReturnType<typeof p.int>>, number> = true;
const _dec: Equals<Infer<ReturnType<typeof p.decimal>>, number> = true;
const _str: Equals<Infer<ReturnType<typeof p.string>>, string> = true;
const _bool: Equals<Infer<ReturnType<typeof p.bool>>, boolean> = true;
const _date: Equals<Infer<ReturnType<typeof p.date>>, Date> = true;

// Enum infers the literal union without `as const` at the call site, for any
// primitive members.
const Role = p.enum(['admin', 'user', 'guest']);
const _role: Equals<Infer<typeof Role>, 'admin' | 'user' | 'guest'> = true;
const Sizes = p.enum([256, 512, 1024]);
const _sizes: Equals<Infer<typeof Sizes>, 256 | 512 | 1024> = true;
const Mixed = p.enum(['auto', 0, false]);
const _mixed: Equals<Infer<typeof Mixed>, 'auto' | 0 | false> = true;

// Nested objects.
const Nested = p.object({ id: p.int(), address: p.object({ city: p.string() }) });
const _nested: Equals<Infer<typeof Nested>, { id: number; address: { city: string } }> = true;

// Arrays: standalone, nested, and as required/optional object fields.
const Nums = p.array(p.int().min(0).max(100));
const _arr: Equals<Infer<typeof Nums>, number[]> = true;
const Grid = p.array(p.array(p.int().min(0).max(9)));
const _grid: Equals<Infer<typeof Grid>, number[][]> = true;
const Tagged = p.object({
  tags: p.array(p.enum(['a', 'b'])),
  scores: p.optional(p.array(p.int())),
});
const _tagged: Equals<Infer<typeof Tagged>, { tags: ('a' | 'b')[]; scores?: number[] }> = true;

// An optional item type admits undefined items.
const Holes = p.array(p.optional(p.string()));
const _holes: Equals<Infer<typeof Holes>, (string | undefined)[]> = true;

// Unions infer the union of their members' types.
const Nullable = p.union([p.string(), p.int(), p.null()]);
const _union: Equals<Infer<typeof Nullable>, string | number | null> = true;

// An optional member adds undefined to the union.
const Maybe = p.union([p.optional(p.string()), p.int()]);
const _maybe: Equals<Infer<typeof Maybe>, string | number | undefined> = true;

// Tagged unions infer a discriminated union: each member gets the tag as a
// literal, so the tag narrows to that member's fields.
const Op = p.tagged('type', {
  insert: p.object({ pos: p.int(), text: p.string() }),
  delete: p.object({ pos: p.int(), len: p.int() }),
});
const _op: Equals<
  Infer<typeof Op>,
  { type: 'insert'; pos: number; text: string } | { type: 'delete'; pos: number; len: number }
> = true;
const _narrow = (op: Infer<typeof Op>): number => {
  switch (op.type) {
    case 'insert':
      return op.text.length;
    case 'delete':
      return op.len;
  }
};

// @ts-expect-error — a tagged member must be a p.object
p.tagged('type', { a: p.object({ x: p.int() }), b: p.string() });

// Bytes decode to a Uint8Array.
const Bytes = p.binary();
const _bytes: Equals<Infer<typeof Bytes>, Uint8Array> = true;

// A lazy node infers like the node it returns.
const Later = p.lazy(() => p.object({ id: p.int() }));
const _later: Equals<Infer<typeof Later>, { id: number }> = true;

// Any field whose node takes undefined is an optional key; a plain one stays required.
const LaterOptional = p.object({ nick: p.lazy(() => p.optional(p.string())) });
const _laterOptional: Equals<Infer<typeof LaterOptional>, { nick?: string }> = true;
const TakesUndefined = p.object({
  id: p.int(),
  tag: p.union([p.optional(p.string()), p.int()]),
  extra: p.any(),
  note: p.versioned(p.optional(p.string())),
});
const _takesUndefined: Equals<
  Infer<typeof TakesUndefined>,
  { id: number; tag?: string | number; extra?: Exclude<AnyValue, undefined>; note?: string }
> = true;

// p.any infers the values it encodes, nested in arrays, plain objects, Maps and Sets.
type AnyScalar =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Date
  | RegExp
  | ArrayBuffer
  | DataView
  | TypedArray;
const _any: Equals<Infer<ReturnType<typeof p.any>>, AnyValue> = true;
const _anyScalars: Equals<Extract<AnyValue, AnyScalar>, AnyScalar> = true;
const _anyArray: Equals<Extract<AnyValue, unknown[]>, AnyValue[]> = true;
const _anyMap: Equals<Extract<AnyValue, Map<any, any>>, Map<AnyValue, AnyValue>> = true;
const _anySet: Equals<Extract<AnyValue, Set<any>>, Set<AnyValue>> = true;
p.any().encode({ at: new Date(), samples: new Int16Array(2), tags: ['a', null] });
p.any().encode(new Map<AnyValue, AnyValue>([[1, new Set<AnyValue>(['a'])]]));
p.any().encode([1n, /a/g, new ArrayBuffer(1), new DataView(new ArrayBuffer(1)), NaN]);
// @ts-expect-error — p.any has no tag for a WeakMap
p.any().encode(new WeakMap());
// @ts-expect-error — nor for a symbol
p.any().encode(Symbol('s'));

// Collections infer a Map, an object with string keys and a Set, whatever
// their count methods.
const Scores = p.map(p.string(), p.int()).max(10);
const _scores: Equals<Infer<typeof Scores>, Map<string, number>> = true;
const Prices = p.record(p.optional(p.decimal(0.01))).min(1);
const _prices: Equals<Infer<typeof Prices>, { [key: string]: number | undefined }> = true;
const Tags = p.set(p.enum(['a', 'b'])).length(2);
const _tags: Equals<Infer<typeof Tags>, Set<'a' | 'b'>> = true;

// Order restrictions leave the inferred type alone.
const Ids = p.array(p.int().min(0).max(99)).unique().sorted().max(5);
const _ids: Equals<Infer<typeof Ids>, number[]> = true;
const Bag = p.array(p.enum(['x', 'y'])).unordered();
const _bag: Equals<Infer<typeof Bag>, ('x' | 'y')[]> = true;
const Flags = p
  .map(p.enum(['a', 'b']), p.bool())
  .unordered()
  .max(2);
const _flags: Equals<Infer<typeof Flags>, Map<'a' | 'b', boolean>> = true;

// A binary node decodes to the class it was given.
const Samples = p.binary(Int16Array);
const _int16: Equals<Infer<typeof Samples>, Int16Array> = true;

// A versioned node infers the newest version's type.
const UserV1 = p.object({ name: p.string() });
const UserV2 = p.object({ name: p.string(), age: p.int() });
const Users = p.versioned(UserV1, [UserV2, (user) => ({ ...user, age: 0 })]);
const _users: Equals<Infer<typeof Users>, { name: string; age: number }> = true;
const Widened = p.versioned(p.int().min(0).max(100), p.int().min(0).max(1000));
const _widened: Equals<Infer<typeof Widened>, number> = true;
const Relaxed = p.versioned(UserV1, p.object({ name: p.string(), age: p.optional(p.int()) }));
const _relaxed: Equals<Infer<typeof Relaxed>, { name: string; age?: number }> = true;

// walk takes a first-version value, or one of the version whose node is passed.
const _walked: Equals<ReturnType<typeof Users.walk>, { name: string; age: number }> = true;
Users.walk({ name: 'Ada' });
Users.walk({ name: 'Ada', age: 36 }, UserV2);
// @ts-expect-error — a first-version value has no age
Users.walk({ name: 'Ada', age: 36 });
// @ts-expect-error — the value must match the node it starts from
Users.walk({ name: 'Ada' }, UserV2);

// @ts-expect-error — a required field added without a migration
p.versioned(UserV1, UserV2);

p.versioned(UserV1, [
  UserV2,
  // @ts-expect-error — the migration must produce the new version's type
  (user) => ({ ...user }),
]);

// The chain has no length cap: prev is typed from the previous version at every position.
const Counter = p.versioned(
  p.int().max(1),
  p.int().max(2),
  p.int().max(3),
  p.int().max(4),
  p.int().max(5),
  p.int().max(6),
  p.int().max(7),
  p.int().max(8),
  p.int().max(9),
  [p.string(), (n) => String(n + 1)],
  [p.object({ label: p.string() }), (label) => ({ label: label.toUpperCase() })]
);
const _counter: Equals<Infer<typeof Counter>, { label: string }> = true;
Counter.walk(0);
// @ts-expect-error — a first-version value is a number
Counter.walk('0');

// A versioned schema starts from a first version, a node with no migration.
// @ts-expect-error — no versions
p.versioned();
// @ts-expect-error — no versions
new PVersioned([]);
// @ts-expect-error — the first version has nothing to migrate from
new PVersioned([[UserV1, (user: unknown) => user]]);

// Nullable adds null to the node's type; optional and nullable combine.
const Profile = p.object({ nick: p.nullable(p.string()), bio: p.optional(p.nullable(p.string())) });
const _nullable: Equals<Infer<typeof Profile>, { nick: string | null; bio?: string | null }> = true;

// Nullable around optional admits both.
const Either = p.nullable(p.optional(p.string()));
const _either: Equals<Infer<typeof Either>, string | null | undefined> = true;

// On its own an optional node is the value or undefined.
const Lone = p.optional(p.int());
const _lone: Equals<Infer<typeof Lone>, number | undefined> = true;

// Encoding returns bytes unless the type asks for text.
const Digit = p.int().min(0).max(9);
const digitBytes = Digit.encode(3);
const _encodedBytes: Equals<typeof digitBytes, Uint8Array> = true;
const digitByteCharset = Digit.encode(3, { type: 'binary', charset: '01' });
const _byteCharset: Equals<typeof digitByteCharset, Uint8Array> = true;
const digitText = Digit.encode(3, { type: 'text', charset: [0x4e00, 0x9fff] });
const _text: Equals<typeof digitText, string> = true;
const anyType = 'text' as 'binary' | 'text';
const digitEither = Digit.encode(3, { type: anyType });
const _eitherOut: Equals<typeof digitEither, Uint8Array | string> = true;

// Decoding takes either form; a `type` must match the input's form.
const _fromBytes: Equals<ReturnType<typeof Digit.decode>, number> = true;
Digit.decode(digitBytes, { type: 'binary' });
Digit.decode(digitText, { type: 'text', charset: [0x4e00, 0x9fff] });
// @ts-expect-error — bytes are not text
Digit.decode(digitBytes, { type: 'text' });
// @ts-expect-error — text is not bytes
Digit.decode(digitText, { type: 'binary' });

// An input that may be either form takes options of either type.
const digitInput = digitEither as Uint8Array | string;
const _fromEither: Equals<ReturnType<typeof Digit.decode<typeof digitInput>>, number> = true;
Digit.decode(digitInput);
Digit.decode(digitInput, { type: anyType });
Digit.decode(digitInput, { type: 'text' });
const textOptions: CodecOptions<'text'> = { type: 'text', charset: [0x4e00, 0x9fff] };
Digit.decode(digitText, textOptions);
// @ts-expect-error — text options are not for bytes
Digit.decode(digitBytes, textOptions);

// Options without a type fit encode and decode of either form.
const shared: CodecOptions = { charset: '0123456789', checksum: 8 };
const _sharedEncode: Uint8Array = Digit.encode(5, shared);
Digit.decode(digitBytes, shared);
Digit.decode(digitText, shared);

// Only strings and binaries learn apart on request.
p.string().adaptive({ separate: true });
p.binary(Uint16Array).adaptive({ separate: true, window: 64 });
// @ts-expect-error — an int's prior is its own already
p.int().adaptive({ separate: true });
// @ts-expect-error — nor does p.any take it
p.any().adaptive({ separate: true });

// An object learns its recall alone, so it keeps its shape and takes no options.
const LearnedPoint = p.object({ x: p.int(), label: p.optional(p.string()) }).adaptive();
const _learnedPoint: Equals<Infer<typeof LearnedPoint>, { x: number; label?: string }> = true;
// @ts-expect-error — an object's recall has no window to set
p.object({ x: p.int() }).adaptive({ window: 64 });
