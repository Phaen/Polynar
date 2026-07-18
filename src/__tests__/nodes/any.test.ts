/**
 * Schema any node (`p.any()`) — unknown/dynamic values with self-description.
 */

import { p } from '../../index';

describe('Schema any', () => {
  it('any round-trips heterogeneous values', () => {
    const trip = <T>(v: T): T => p.any().decode(p.any().encode(v)) as T;
    expect(trip('hello')).toBe('hello');
    expect(trip(true)).toBe(true);
  });

  it('any round-trips every number shape bit-exact', () => {
    const trip = <T>(v: T): T => p.any().decode(p.any().encode(v)) as T;
    // Integers travel through the cheap term path, everything else through
    // the flat IEEE-754 path — both exact, split by a type tag.
    expect(trip(18014398509481988 as unknown)).toBe(18014398509481988);
    expect(trip(-12345 as unknown)).toBe(-12345);
    expect(trip(Math.PI as unknown)).toBe(Math.PI);
    expect(trip(0.1 as unknown)).toBe(0.1);
    expect(Object.is(trip(-0 as unknown), -0)).toBe(true);
  });

  describe('p.any() round-trips the full unknown space', () => {
    const trip = <T>(v: T): T => p.any().decode(p.any().encode(v)) as T;

    it('null and undefined', () => {
      expect(trip(null)).toBeNull();
      expect(trip(undefined)).toBeUndefined();
    });

    it('arrays (empty, flat, nested, heterogeneous)', () => {
      expect(trip([])).toEqual([]);
      expect(trip([1, 2, 3])).toEqual([1, 2, 3]);
      expect(trip([1, 'two', [3, [4]], { k: 5 }])).toEqual([1, 'two', [3, [4]], { k: 5 }]);
    });

    it('non-ASCII strings and unicode object keys/values', () => {
      expect(trip('café — 漢字 👋\nline2')).toBe('café — 漢字 👋\nline2');
      expect(trip({ café: 'José', emoji: '🎉' })).toEqual({ café: 'José', emoji: '🎉' });
    });

    it('objects containing null and arrays', () => {
      const value = { tags: ['a', 'b'], parent: null, meta: { n: 1 } };
      expect(trip(value)).toEqual(value);
    });

    it('shared references encode as copies; cycles throw instead of overflowing', () => {
      const shared = { n: 1 };
      expect(trip({ a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } });

      const loop: Record<string, unknown> = {};
      loop.self = loop;
      expect(() => p.any().encode(loop)).toThrow('circular');
      const ring: unknown[] = [];
      ring.push(ring);
      expect(() => p.any().encode(ring)).toThrow('circular');
    });
  });
});
