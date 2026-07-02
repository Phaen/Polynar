/**
 * Any module — full type-tag coverage.
 *
 * `any` is self-describing: it tags each value with its type (undefined, number,
 * string, boolean, date, object) and delegates to the matching module. Numbers
 * route through `fraction`, so integers are exact and decimals are approximate.
 */

import { Encoder, Decoder } from '../../polynar';
import type { AnyOptions } from '../../types';

const OPTS: AnyOptions = { type: 'any' };

const roundTrip = (value: unknown[]): unknown[] => {
  const encoder = new Encoder();
  encoder.write(value, OPTS);
  const decoder = new Decoder(encoder.toString());
  // read() unwraps a single-element result; re-wrap so callers always get an array.
  const out = decoder.read(OPTS, value.length);
  return value.length === 1 ? [out] : (out as unknown[]);
};

describe('Any module', () => {
  it('round-trips each primitive type tag', () => {
    const [u, n, s, b] = roundTrip([undefined, 42, 'hello', true]);
    expect(u).toBeUndefined();
    expect(n).toBe(42);
    expect(s).toBe('hello');
    expect(b).toBe(true);
  });

  it('round-trips dates', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    const [out] = roundTrip([d]) as [Date];
    expect(out).toBeInstanceOf(Date);
    expect(out.getTime()).toBe(d.getTime());
  });

  it('round-trips plain objects (self-describing, no template)', () => {
    const obj = { a: 1, b: 'test', c: true };
    const [out] = roundTrip([obj]);
    expect(out).toEqual(obj);
  });

  it('round-trips nested objects', () => {
    const obj = { outer: { inner: 5, label: 'x' } };
    const [out] = roundTrip([obj]);
    expect(out).toEqual(obj);
  });

  it('round-trips a heterogeneous sequence', () => {
    const date = new Date('2020-05-05T00:00:00Z');
    const data = [1, 'two', false, undefined, date, { k: 9 }];
    const out = roundTrip(data);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe('two');
    expect(out[2]).toBe(false);
    expect(out[3]).toBeUndefined();
    expect((out[4] as Date).getTime()).toBe(date.getTime());
    expect(out[5]).toEqual({ k: 9 });
  });

  it('approximates non-integer numbers (routed through fraction)', () => {
    const [out] = roundTrip([3.25]) as [number];
    expect(out).toBeCloseTo(3.25, 10);
  });

  it('round-trips null distinctly from undefined', () => {
    const [n, u] = roundTrip([null, undefined]);
    expect(n).toBeNull();
    expect(u).toBeUndefined();
  });

  it('round-trips arrays, including nested and empty', () => {
    const value = [1, 'two', [3, [4, null]], []];
    const [out] = roundTrip([value]);
    expect(out).toEqual(value);
  });

  it('round-trips non-ASCII strings and unicode object keys', () => {
    const value = { café: 'José 👋', list: ['a\nb', '漢字'] };
    const [out] = roundTrip([value]);
    expect(out).toEqual(value);
  });

  it('rejects non-finite numbers instead of hanging', () => {
    const encoder = new Encoder();
    expect(() => encoder.write([Infinity], OPTS)).toThrow(TypeError);
  });
});
