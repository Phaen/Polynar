/**
 * Schema object node (`p.object()`) — structured records with optional fields.
 */

import { p } from '../../index';

describe('Schema object', () => {
  const Person = p.object({
    name: p.string().max(20),
    age: p.int().min(0).max(120),
    active: p.bool(),
    role: p.enum(['admin', 'user', 'guest']),
    bio: p.string().optional(),
  });

  it('round-trips with an optional field present and absent', () => {
    const present = { name: 'Ada', age: 36, active: true, role: 'admin' as const, bio: 'math' };
    const absent = { name: 'Ada', age: 36, active: true, role: 'user' as const };
    expect(Person.decode(Person.encode(present))).toEqual(present);
    expect(Person.decode(Person.encode(absent))).toEqual(absent);
  });

  it('preserves falsy-but-defined fields', () => {
    const value = { name: '', age: 0, active: false, role: 'guest' as const };
    expect(Person.decode(Person.encode(value))).toEqual(value);
  });

  it('round-trips nested objects', () => {
    const Schema = p.object({
      id: p.int().min(0).max(1000),
      address: p.object({ city: p.string().max(30), zip: p.int().min(0).max(99999) }),
    });
    const value = { id: 7, address: { city: 'London', zip: 12345 } };
    expect(Schema.decode(Schema.encode(value))).toEqual(value);
  });

  it('round-trips an any-typed field that holds an array', () => {
    const Schema = p.object({ tags: p.any(), id: p.int().min(0).max(100) });
    const value = { tags: ['a', 'b', 'c'], id: 7 };
    expect(Schema.decode(Schema.encode(value))).toEqual(value);
  });

  it('round-trips null in an any-typed field', () => {
    // null is a value the any type carries; only undefined means absent.
    const Schema = p.object({ x: p.any() });
    expect(Schema.decode(Schema.encode({ x: null }))).toEqual({ x: null });
  });

  it("decodes a field named '__proto__' as an own property", () => {
    // Plain assignment would route the value into the prototype setter,
    // silently dropping the field and leaving the prototype untouched anyway.
    const Schema = p.object({ ['__proto__']: p.int().min(0).max(9) });
    const value = Object.defineProperty({}, '__proto__', {
      value: 5,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const decoded = Schema.decode(Schema.encode(value as never)) as object;
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toBe(5);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  it('an optional nested object stays all-or-nothing and keeps its sub-fields required', () => {
    const Schema = p.object({
      inner: p.object({ a: p.int().min(0).max(9), b: p.int().min(0).max(9) }).optional(),
    });
    expect(Schema.decode(Schema.encode({}))).toEqual({});
    expect(Schema.decode(Schema.encode({ inner: { a: 3, b: 7 } }))).toEqual({
      inner: { a: 3, b: 7 },
    });
    expect(() => Schema.encode({ inner: { a: 1 } } as never)).toThrow();
  });

  it('throws when an object value is not an object', () => {
    expect(() => p.object({ a: p.int().min(0).max(9) }).encode(null as never)).toThrow(TypeError);
  });

  it('rejects an array passed where an object is expected', () => {
    expect(() => p.object({ a: p.int().min(0).max(9) }).encode([1] as never)).toThrow(TypeError);
  });
});
