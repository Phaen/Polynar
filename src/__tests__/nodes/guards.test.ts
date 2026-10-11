/**
 * The type checks behind `p.any` and `p.union`: which JS values count as
 * dates and plain objects, and the kind each value has.
 */

import { runInNewContext } from 'vm';
import { isDate, isPlainObject, kindOf, typedArrayKind } from '../../nodes/guards';

class Point {
  x = 1;
}

describe('isDate', () => {
  it('tells dates from everything else', () => {
    expect(isDate(new Date(NaN))).toBe(true);
    expect([0, '2020-01-01', { getTime: () => 0 }, undefined].some(isDate)).toBe(false);
  });
});

describe('isPlainObject', () => {
  it('accepts object literals and null-prototype dictionaries', () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('refuses everything else, null and undefined included', () => {
    for (const value of [
      null,
      undefined,
      0,
      'a',
      true,
      1n,
      Symbol('s'),
      () => 0,
      [],
      new Date(0),
      new Map(),
      new Point(),
      Object.create({}),
    ]) {
      expect(isPlainObject(value)).toBe(false);
    }
  });
});

describe('kindOf', () => {
  it.each([
    ['a', 'string'],
    [1, 'number'],
    [false, 'boolean'],
    [1n, 'bigint'],
    [Symbol('s'), 'symbol'],
    [() => 0, 'function'],
    [undefined, 'undefined'],
    [null, 'null'],
    [[], 'array'],
    [new Date(0), 'date'],
    [/a/g, 'regexp'],
    [{}, 'object'],
    [new Map(), 'map'],
    [new Set(), 'set'],
    [new WeakMap(), 'object'],
    [runInNewContext('[]'), 'array'],
    [new Int16Array(1), 'Int16Array'],
    [new DataView(new ArrayBuffer(1)), 'DataView'],
    [new ArrayBuffer(1), 'ArrayBuffer'],
    [new SharedArrayBuffer(1), 'object'],
    [Buffer.from('a'), 'Uint8Array'],
  ])('reads %p as %p', (value, kind) => {
    expect(kindOf(value)).toBe(kind);
  });
});

describe('typedArrayKind', () => {
  it('names the built-in class, for subclasses and other realms too', () => {
    const views: [ArrayBufferView, string][] = [
      [new Int8Array(0), 'Int8Array'],
      [new Uint8ClampedArray(0), 'Uint8ClampedArray'],
      [new Float64Array(0), 'Float64Array'],
      [new BigUint64Array(0), 'BigUint64Array'],
      [new DataView(new ArrayBuffer(0)), 'DataView'],
      [Buffer.alloc(0), 'Uint8Array'],
      [runInNewContext('new Uint32Array(2)'), 'Uint32Array'],
    ];
    for (const [view, kind] of views) {
      expect(typedArrayKind(view)).toBe(kind);
    }
  });
});
