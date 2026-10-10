/**
 * `p.object()`: records of named fields. A field whose node takes undefined
 * is optional: a missing key and an undefined value both decode as missing.
 */

import { p, type PNode } from '../../index';
import { trip } from '../support';

describe('Schema object', () => {
  it("decodes a field named '__proto__' as an own property", () => {
    // Plain assignment would route the value into the prototype setter,
    // dropping the field and leaving the prototype untouched anyway.
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

  it('leaves the key of an undefined optional field out', () => {
    const Person = p.object({ name: p.string(), bio: p.optional(p.string()) });
    expect('bio' in trip(Person, { name: 'Ada', bio: undefined })).toBe(false);
  });

  it.each([
    [
      'a union with an optional member',
      p.object({ f: p.union([p.optional(p.int()), p.string()]) }),
      'a',
    ],
    ['p.any', p.object({ f: p.any() }), [1]],
    ['a versioned optional', p.object({ f: p.versioned(p.optional(p.int())) }), 3],
    ['a lazy optional', p.object({ f: p.lazy(() => p.optional(p.string())) }), 'Ada'],
    [
      'a nullable lazy optional',
      p.object({ f: p.nullable(p.optional(p.lazy(() => p.int()))) }),
      null,
    ],
    [
      'a versioned lazy optional',
      p.object({ f: p.versioned(p.optional(p.lazy(() => p.int()))) }),
      2,
    ],
  ] as [string, PNode<{ f?: unknown }>, unknown][])(
    'takes a missing key on a field of %s',
    (_name, Schema, present) => {
      expect(Object.keys(trip(Schema, { f: undefined }))).toEqual([]);
      expect(Object.keys(trip(Schema, {}))).toEqual([]);
      expect(trip(Schema, { f: present })).toEqual({ f: present });
    }
  );
});
