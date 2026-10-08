/**
 * Schema bytes node (`p.bytes()`) — raw byte runs with a bounded count.
 */

import { p, CorruptInputError } from '../../index';
import { trip } from '../support';

describe('Schema bytes', () => {
  it('bytes round-trip to a fresh Uint8Array', () => {
    const value = new Uint8Array([0, 1, 127, 128, 255]);
    const decoded = trip(p.bytes(), value);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded).toEqual(value);
    expect(decoded).not.toBe(value);
    expect(trip(p.bytes(), new Uint8Array())).toEqual(new Uint8Array());
  });

  it('a fixed length costs exactly its bytes', () => {
    const hash = p.bytes().length(32);
    const value = Uint8Array.from({ length: 32 }, (_, i) => (i * 37) % 256);
    expect(hash.encode(value)).toHaveLength(32);
    expect(trip(hash, value)).toEqual(value);
    expect(() => hash.encode(new Uint8Array(31))).toThrow('31 bytes differs from the fixed length');
  });

  it('bounds the count like a string', () => {
    const node = p.bytes().min(2).max(4);
    expect(trip(node, new Uint8Array([9, 9, 9]))).toEqual(new Uint8Array([9, 9, 9]));
    expect(() => node.encode(new Uint8Array(1))).toThrow('below min length');
    expect(() => node.encode(new Uint8Array(5))).toThrow('exceeds max length');
    expect(() => p.bytes().length(4).max(8)).toThrow('cannot be combined');
    expect(() => p.bytes().min(3).max(2)).toThrow('range is empty');
  });

  it('accepts a Uint8Array subclass and decodes a plain one', () => {
    class Tagged extends Uint8Array {}
    const decoded = trip(p.bytes(), new Tagged([1, 2]));
    expect(Object.getPrototypeOf(decoded)).toBe(Uint8Array.prototype);
    expect(decoded).toEqual(new Uint8Array([1, 2]));
  });

  it('is its own kind in a union, apart from objects', () => {
    const node = p.union([p.bytes(), p.object({ a: p.int() }), p.null()]);
    expect(trip(node, new Uint8Array([7]))).toEqual(new Uint8Array([7]));
    expect(trip(node, { a: 1 })).toEqual({ a: 1 });
    expect(() => p.union([p.bytes(), p.bytes().max(4)])).toThrow("overlap on kind 'bytes'");
  });

  it('a tampered length runs out of input instead of allocating it', () => {
    // An unbounded length prefix claiming 2^40 bytes, followed by nothing.
    const claim = p
      .int()
      .min(0)
      .encode(2 ** 40);
    expect(() => p.bytes().decode(claim)).toThrow(CorruptInputError);
  });
});
