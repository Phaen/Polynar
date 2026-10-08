/**
 * Schema union node (`p.union()`) — one member per JS kind, picked by value.
 */

import { p, PNode, Encoder, Decoder } from '../../index';
import { trip } from '../support';

describe('Schema union', () => {
  it('union round-trips each kind', () => {
    const Mixed = p.union([p.string(), p.int(), p.array(p.string()), p.date()]);
    expect(trip(Mixed, 'x')).toBe('x');
    expect(trip(Mixed, new Date(0))).toEqual(new Date(0));
    expect(trip(Mixed, 42)).toBe(42);
    expect(trip(Mixed, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('union with p.null is a nullable', () => {
    const Nullable = p.union([p.string(), p.null()]);
    expect(trip(Nullable, null)).toBeNull();
    expect(trip(Nullable, 'x')).toBe('x');
  });

  it('p.null alone round-trips null', () => {
    expect(trip(p.null(), null)).toBeNull();
    expect(p.null().encode(null)).toHaveLength(0);
  });

  it('union routes a value to the member that owns its kind', () => {
    const Node = p.union([p.enum(['a', 'b']), p.int()]);
    expect(trip(Node, 'a')).toBe('a');
    expect(trip(Node, 3)).toBe(3);
    expect(() => p.union([p.enum(['a', 1]), p.int()])).toThrow("overlap on kind 'number'");
  });

  it('union rejects members that claim the same kind', () => {
    expect(() => p.union([p.array(p.int()), p.array(p.string())])).toThrow(
      "overlap on kind 'array'"
    );
    expect(() => p.union([p.object({ a: p.int() }), p.object({ b: p.int() })])).toThrow(
      "overlap on kind 'object'"
    );
    expect(() => p.union([p.int(), p.float()])).toThrow("overlap on kind 'number'");
    expect(() => p.union([p.any(), p.string()])).toThrow('overlap on kind');
  });

  it('union rejects an empty list and members without declared kinds', () => {
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

  it('unions nest, and overlap is detected across nesting', () => {
    const Nested = p.union([p.union([p.string(), p.null()]), p.int()]);
    expect(trip(Nested, null)).toBeNull();
    expect(trip(Nested, 'x')).toBe('x');
    expect(trip(Nested, 7)).toBe(7);
    expect(() => p.union([p.union([p.string(), p.int()]), p.float()])).toThrow('overlap');
  });

  it('weights make the likely member cheaper', () => {
    const Uniform = p.union([p.string(), p.null()]);
    const Skewed = Uniform.weights([1, 99]);
    const nulls = Array.from({ length: 50 }, () => null);
    const uniform = p.array(Uniform).encode(nulls);
    const skewed = p.array(Skewed).encode(nulls);
    expect(skewed.length).toBeLessThan(uniform.length);
    expect(p.array(Skewed).decode(skewed)).toEqual(nulls);
    expect(trip(Skewed, 'x')).toBe('x');
  });

  it('p.nullable is a union with p.null', () => {
    const nick = p.nullable(p.string().max(8));
    expect(trip(nick, null)).toBeNull();
    expect(trip(nick, 'Ada')).toBe('Ada');
    expect(nick.encode('Ada')).toEqual(p.union([p.string().max(8), p.null()]).encode('Ada'));
    const rare = nick.weights([1, 99]);
    const nulls = Array.from({ length: 50 }, () => null);
    expect(p.array(rare).encode(nulls).length).toBeLessThan(p.array(nick).encode(nulls).length);
    const User = p.object({ bio: p.optional(p.nullable(p.string())) });
    expect(trip(User, {})).toEqual({});
    expect(trip(User, { bio: null })).toEqual({ bio: null });
    expect(() => p.nullable(p.any())).toThrow("overlap on kind 'null'");
  });
});
