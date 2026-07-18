/**
 * Schema int node (`p.int()`) — all tests for bounded and unbounded integers.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import { trip } from '../support';

describe('Schema int', () => {
  it('int round-trips bounded and unbounded (signed) values', () => {
    expect(trip(p.int().min(0).max(100), 42)).toBe(42);
    expect(trip(p.int(), -12345)).toBe(-12345);
  });

  it('int rejects non-integer values instead of truncating', () => {
    // Strict like every other node: truncation would silently lose data.
    expect(() => p.int().encode(3.7)).toThrow(TypeError);
    expect(() => p.int().min(0).max(100).encode(-3.7)).toThrow(TypeError);
  });

  it('int rounds fractional bounds inward', () => {
    // ceil the min, floor the max: [0.5, 10.5] admits [1, 10]
    expect(trip(p.int().min(0.5).max(10.5), 10)).toBe(10);
    expect(trip(p.int().min(-5.9).max(5.9), -5)).toBe(-5);
    expect(() => p.int().min(0.5).encode(0)).toThrow(RangeError);
  });

  it('int bounds round inward so the declared range is never widened', () => {
    const node = p.int().min(2.7).max(9.2); // -> [3, 9]
    expect(trip(node, 3)).toBe(3);
    expect(trip(node, 9)).toBe(9);
    expect(() => node.encode(2)).toThrow(); // 2 < 2.7
    expect(() => node.encode(10)).toThrow(); // 10 > 9.2
  });

  it('int round-trips unbounded values above 2^53 bit-exact', () => {
    expect(trip(p.int(), 18014398509481988)).toBe(18014398509481988);
    expect(trip(p.int(), -1e300)).toBe(-1e300);
  });

  it('int encodes -0 as plain zero', () => {
    expect(Object.is(trip(p.int(), -0), 0)).toBe(true);
    expect(Object.is(trip(p.int().min(-5).max(5), -0), 0)).toBe(true);
  });

  it('throws on out-of-range ints', () => {
    expect(() => p.int().min(0).max(120).encode(150)).toThrow();
  });

  it('throws at construction when an int range is empty after inward rounding', () => {
    // Config errors surface where the schema is DEFINED, not on first use.
    expect(() => p.int().min(2.1).max(2.9)).toThrow(RangeError);
  });

  it('rejects a term offset that cannot reconstruct exactly', () => {
    // min + offset rounds past 2^53, so the encoder could never have emitted
    // it; accepting it would decode a value that re-encodes differently.
    const enc = new Encoder();
    enc.composeTerm(2 ** 53);
    expect(() => p.int().min(1).decode(enc.toUint8Array())).toThrow(CorruptInputError);
  });
});
