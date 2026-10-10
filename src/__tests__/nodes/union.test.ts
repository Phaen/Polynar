/**
 * `p.union()`: one member per JS kind, picked by the value's kind.
 */

import { p, PNode, Encoder, Decoder } from '../../index';
import { trip } from '../support';

describe('Schema union', () => {
  it('routes a value to the member that owns its kind', () => {
    const Node = p.union([p.enum(['a', 'b']), p.int(), p.date()]);
    expect(trip(Node, 'a')).toBe('a');
    expect(trip(Node, 3)).toBe(3);
    expect(trip(Node, new Date(0))).toEqual(new Date(0));
    expect(() => p.union([p.enum(['a', 1]), p.int()])).toThrow('overlap on kind "number"');
  });

  it('tells Maps and Sets from objects and arrays', () => {
    const Node = p.union([
      p.map(p.string(), p.int()),
      p.set(p.int()),
      p.record(p.bool()),
      p.array(p.int()),
    ]);
    const map = new Map([['a', 1]]);
    expect(trip(Node, map)).toEqual(map);
    expect(trip(Node, new Set([1, 2]))).toEqual(new Set([1, 2]));
    expect(trip(Node, { a: true })).toEqual({ a: true });
    expect(trip(Node, [3])).toEqual([3]);
    expect(() => p.union([p.set(p.int()), p.set(p.string())])).toThrow('overlap on kind "set"');
    expect(() => p.union([p.any(), p.map(p.int(), p.int())])).toThrow('overlap on kind "map"');
  });

  it('rejects members that claim the same kind', () => {
    expect(() => p.union([p.array(p.int()), p.array(p.string())])).toThrow(
      'overlap on kind "array"'
    );
    expect(() => p.union([p.object({ a: p.int() }), p.object({ b: p.int() })])).toThrow(
      'overlap on kind "object"'
    );
    expect(() => p.union([p.int(), p.float()])).toThrow('overlap on kind "number"');
    expect(() => p.union([p.any(), p.string()])).toThrow('overlap on kind');
    expect(() => p.union([p.any(), p.binary(Int16Array)])).toThrow('overlap on kind "Int16Array"');
  });

  it('takes p.any as its only member', () => {
    const Loose = p.union([p.any()]);
    expect(trip(Loose, [1, 'a'])).toEqual([1, 'a']);
    expect(trip(Loose, Uint8Array.of(9))).toEqual(Uint8Array.of(9));
  });

  it('rejects a value whose kind no member declares', () => {
    // The member's type admits numbers, but its kinds claim only strings.
    class PLabel extends PNode<string | number> {
      readonly _kinds = ['string'];
      _write(enc: Encoder, value: string | number): void {
        p.string()._write(enc, String(value));
      }
      _read(dec: Decoder): string {
        return p.string()._read(dec);
      }
    }
    const Label = p.union([new PLabel()]);
    expect(() => Label._write(new Encoder(), 1)).toThrow(
      new TypeError('Kind "number" is not one of "string"')
    );
  });

  it('rejects an empty list and members without declared kinds', () => {
    expect(() => p.union([])).toThrow('at least one member');
    class PBit extends PNode<number> {
      _write(enc: Encoder, value: number): void {
        enc.compose(value, 2);
      }
      _read(dec: Decoder): number {
        return dec.parse(2);
      }
    }
    expect(() => p.union([new PBit(), p.string()])).toThrow('must declare their kinds');
  });

  it('nests, with overlap detected across nesting', () => {
    const Nested = p.union([p.union([p.string(), p.null()]), p.int()]);
    expect(trip(Nested, null)).toBeNull();
    expect(trip(Nested, 'x')).toBe('x');
    expect(trip(Nested, 7)).toBe(7);
    expect(() => p.union([p.union([p.string(), p.int()]), p.float()])).toThrow('overlap');
  });

  it('gives undefined to an optional member', () => {
    const Maybe = p.union([p.optional(p.string()), p.int()]);
    expect(trip(Maybe, undefined)).toBeUndefined();
    expect(trip(Maybe, 'x')).toBe('x');
    // p.any already claims undefined, so a second optional member overlaps.
    expect(() => p.union([p.optional(p.int()), p.optional(p.any())])).toThrow(
      'overlap on kind "undefined"'
    );
  });
});
