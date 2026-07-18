/**
 * Schema array node (`p.array()`) — homogeneous sequences with optional bounds.
 */

import { p } from '../../index';

describe('Schema array', () => {
  it('round-trips empty, single and many elements', () => {
    const node = p.array(p.int().min(0).max(1000));
    expect(node.decode(node.encode([]))).toEqual([]);
    expect(node.decode(node.encode([42]))).toEqual([42]);
    const many = Array.from({ length: 250 }, (_, i) => i * 3);
    expect(node.decode(node.encode(many))).toEqual(many);
  });

  it('round-trips an array of objects', () => {
    const People = p.array(
      p.object({ name: p.string().max(20), age: p.int().min(0).max(120), active: p.bool() })
    );
    const people = [
      { name: 'Ada', age: 36, active: true },
      { name: 'Linus', age: 54, active: false },
      { name: '', age: 0, active: false },
    ];
    expect(People.decode(People.encode(people))).toEqual(people);
  });

  it('works as an object field, required and optional', () => {
    const Schema = p.object({
      id: p.int().min(0).max(100),
      tags: p.array(p.enum(['a', 'b', 'c'])),
      scores: p.array(p.int().min(0).max(10)).optional(),
    });
    const full = { id: 7, tags: ['a', 'c'] as ('a' | 'b' | 'c')[], scores: [1, 2, 3] };
    const bare = { id: 7, tags: [] as ('a' | 'b' | 'c')[] };
    expect(Schema.decode(Schema.encode(full))).toEqual(full);
    expect(Schema.decode(Schema.encode(bare))).toEqual(bare);
  });

  it('nests without extra ceremony', () => {
    const Grid = p.array(p.array(p.int().min(0).max(9)));
    const value = [[1, 2], [], [3, 4, 5]];
    expect(Grid.decode(Grid.encode(value))).toEqual(value);
  });

  it('carries heterogeneous any-typed elements, arrays included', () => {
    // Each element is one self-described `any` value, so an element that is
    // itself an array stays a single element instead of spreading.
    const node = p.array(p.any());
    const value = [1, 'two', [3, [4]], { k: 5 }, null];
    expect(node.decode(node.encode(value))).toEqual(value);
  });

  it('caps the count with max and packs the capped prefix denser', () => {
    const capped = p.array(p.int().min(0).max(9)).max(4);
    expect(capped.decode(capped.encode([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(() => capped.encode([1, 2, 3, 4, 5])).toThrow('Array length exceeds maximum');
    const uncapped = p.array(p.int().min(0).max(9));
    expect(capped.encode([1, 2, 3]).length).toBeLessThanOrEqual(uncapped.encode([1, 2, 3]).length);
  });

  it('rounds a fractional max inward and rejects invalid caps', () => {
    const node = p.array(p.int().min(0).max(9)).max(2.9); // -> cap of 2
    expect(node.decode(node.encode([1, 2]))).toEqual([1, 2]);
    expect(() => node.encode([1, 2, 3])).toThrow('Array length exceeds maximum');
    expect(() => p.array(p.int()).max(-1)).toThrow(RangeError);
    expect(() => p.array(p.int()).max(NaN)).toThrow(RangeError);
  });

  it('min bounds the count from below and combines with max', () => {
    const node = p.array(p.int().min(0).max(9)).min(2).max(4);
    expect(node.decode(node.encode([1, 2]))).toEqual([1, 2]);
    expect(node.decode(node.encode([1, 2, 3, 4]))).toEqual([1, 2, 3, 4]);
    expect(() => node.encode([1])).toThrow('Array length is below the minimum');
    expect(() => node.encode([1, 2, 3, 4, 5])).toThrow('Array length exceeds maximum');
    expect(() => p.array(p.int()).min(5).max(2)).toThrow(RangeError);
    expect(() => p.array(p.int()).min(-1)).toThrow(RangeError);
  });

  it('length fixes the count, which then costs zero wire bits', () => {
    const node = p.array(p.bool()).length(40);
    const value = Array.from({ length: 40 }, (_, i) => i % 3 === 0);
    expect(node.decode(node.encode(value))).toEqual(value);
    // 40 booleans are exactly 40 bits; the fixed count adds none: 5 bytes.
    expect(node.encode(value)).toHaveLength(5);
  });

  it('length rejects any other count, in both directions', () => {
    const node = p.array(p.int().min(0).max(9)).length(3);
    expect(node.decode(node.encode([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(() => node.encode([1, 2])).toThrow('differs from the fixed length');
    expect(() => node.encode([1, 2, 3, 4])).toThrow('differs from the fixed length');
  });

  it('length(0) admits only the empty array — and encodes it as nothing at all', () => {
    const node = p.array(p.int()).length(0);
    expect(node.decode(node.encode([]))).toEqual([]);
    expect(node.encode([])).toHaveLength(0);
    expect(() => node.encode([1])).toThrow('differs from the fixed length');
  });

  it('length refuses to combine with min or max, in either order', () => {
    expect(() => p.array(p.int()).length(3).min(1)).toThrow(TypeError);
    expect(() => p.array(p.int()).length(3).max(5)).toThrow(TypeError);
    expect(() => p.array(p.int()).min(1).length(3)).toThrow(TypeError);
    expect(() => p.array(p.int()).max(5).length(3)).toThrow(TypeError);
  });

  it('length must be an exact non-negative integer', () => {
    // No inward rounding: no count satisfies a fractional length, so rounding
    // would invent a contract that was never declared.
    expect(() => p.array(p.int()).length(2.9)).toThrow(RangeError);
    expect(() => p.array(p.int()).length(-1)).toThrow(RangeError);
    expect(() => p.array(p.int()).length(NaN)).toThrow(RangeError);
  });

  it('rejects an optional item type at construction', () => {
    // The presence bit only exists for object fields; an array slot is always
    // occupied. The array itself can be optional instead.
    expect(() => p.array(p.string().optional() as never)).toThrow(TypeError);
  });

  it('rejects a non-array value at encode', () => {
    expect(() => p.array(p.int().min(0).max(9)).encode('nope' as never)).toThrow(TypeError);
  });

  it('is denser than per-value encode over many records', () => {
    const node = p.int().min(0).max(7);
    const values = Array.from({ length: 500 }, (_, i) => i % 8);
    const batch = p.array(node).encode(values).length;
    const individual = values.reduce((n, v) => n + node.encode(v).length, 0);
    expect(batch).toBeLessThan(individual);
  });

  it('array decode rejects trailing padding', () => {
    const node = p.array(p.int().min(0).max(1000));
    const padded = Uint8Array.of(...node.encode([1, 2, 3]), 0);
    expect(() => node.decode(padded)).toThrow('Input is longer than its contents');
  });
});
