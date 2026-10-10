/**
 * `p.any()`: self-describing values of no declared type.
 */

import { p, Encoder } from '../../index';
import { trip } from '../support';

describe('Schema any', () => {
  it('copies shared references and refuses cycles', () => {
    const shared = { n: 1 };
    expect(trip(p.any(), { a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } });

    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => p.any().encode(loop)).toThrow('circular');
    const ring: unknown[] = [];
    ring.push(ring);
    expect(() => p.any().encode(ring)).toThrow('circular');
  });

  it('accepts a null-prototype dictionary', () => {
    const dict = Object.create(null) as Record<string, unknown>;
    dict.a = 1;
    expect(trip(p.any(), dict)).toEqual({ a: 1 });
  });

  class Point {
    constructor(
      public x = 1,
      public y = 2
    ) {}
  }

  it.each([
    ['symbol', Symbol('s')],
    ['bigint', 1n],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1, 2])],
    ['RegExp', /a/g],
    ['Error', new Error('boom')],
    ['Uint8Array', new Uint8Array([1, 2])],
    ['Point', new Point()],
    // A prototype chain with no constructor anywhere has no name to show.
    ['this type', Object.create(Object.create(null))],
  ])('rejects %s values, which it has no tag for', (name, value) => {
    expect(() => p.any().encode(value)).toThrow(`p.any cannot encode ${name} values`);
  });

  it.each([Infinity, -Infinity, NaN])('rejects %p', (value) => {
    expect(() => p.any().encode(value)).toThrow(TypeError);
  });

  it('rejects a float tag on an integer value', () => {
    // Integers always travel under the int tag.
    const enc = new Encoder();
    enc.compose(4, 9); // TAG_FLOAT
    p.float()._write(enc, 42);
    expect(() => p.any().decode(enc.output())).toThrow(
      'Non-canonical float tag on an integer value'
    );
  });

  it('rejects a record whose wire form repeats a key', () => {
    // The object tag is the last of nine, then a two-entry count, then the
    // same key twice: a shape the encoder never produces.
    const enc = new Encoder();
    enc.compose(8, 9);
    enc.composeTerm(2);
    p.string()._write(enc, 'a');
    p.any()._write(enc, 1);
    p.string()._write(enc, 'a');
    p.any()._write(enc, 2);
    expect(() => p.any().decode(enc.output())).toThrow('Duplicate key in record');
  });
});
