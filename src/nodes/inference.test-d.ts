/**
 * Type-inference assertions. This file is NOT a Jest suite (it lives outside
 * __tests__ and is named *.test-d.ts), but IS compiled by `npm run typecheck`
 * (the base tsconfig excludes only *.test.ts). A wrong inference makes `Equals`
 * resolve to `false`, so `= true` fails to compile and typecheck goes red.
 */
import { p } from './p';
import type { Infer } from './infer';

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

// An optional ITEM type is rejected via the `_optional` phantom marker: the
// presence bit only exists for object fields, so it is the array that can be
// optional, never its items.
// @ts-expect-error — POptional is not a valid array item
p.array(p.optional(p.string()));

// Unions infer the union of their members' types.
const Nullable = p.union([p.string(), p.int(), p.null()]);
const _union: Equals<Infer<typeof Nullable>, string | number | null> = true;

// @ts-expect-error — POptional is not a valid union member
p.union([p.optional(p.string()), p.int()]);

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

// @ts-expect-error — POptional is not a valid lazy target
p.lazy(() => p.optional(p.string()));

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

// @ts-expect-error — a required field added without a migration
p.versioned(UserV1, UserV2);

p.versioned(UserV1, [
  UserV2,
  // @ts-expect-error — the migration must produce the new version's type
  (user) => ({ ...user }),
]);

// Nullable adds null to the node's type; optional and nullable combine.
const Profile = p.object({ nick: p.nullable(p.string()), bio: p.optional(p.nullable(p.string())) });
const _nullable: Equals<Infer<typeof Profile>, { nick: string | null; bio?: string | null }> = true;

// @ts-expect-error — POptional is not a valid nullable target
p.nullable(p.optional(p.string()));
