/**
 * Type-inference assertions. This file is NOT a Jest suite (it lives outside
 * __tests__ and is named *.test-d.ts), but IS compiled by `npm run typecheck`
 * (the base tsconfig excludes only *.test.ts). A wrong inference makes `Equals`
 * resolve to `false`, so `= true` fails to compile and typecheck goes red.
 */
import { p } from './index';
import type { Infer } from './infer';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Person = p.object({
  name: p.string().max(20),
  age: p.int(0, 120),
  active: p.bool(),
  role: p.enum(['admin', 'user', 'guest']),
  bio: p.string().optional(),
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
const _str: Equals<Infer<ReturnType<typeof p.string>>, string> = true;
const _bool: Equals<Infer<ReturnType<typeof p.bool>>, boolean> = true;
const _date: Equals<Infer<ReturnType<typeof p.date>>, Date> = true;

// Enum infers the literal union without `as const` at the call site.
const Role = p.enum(['admin', 'user', 'guest']);
const _role: Equals<Infer<typeof Role>, 'admin' | 'user' | 'guest'> = true;

// Nested objects.
const Nested = p.object({ id: p.int(), address: p.object({ city: p.string() }) });
const _nested: Equals<Infer<typeof Nested>, { id: number; address: { city: string } }> = true;
