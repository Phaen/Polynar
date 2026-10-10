/**
 * The bound rules every lattice-backed node shares: int, decimal and date
 * values, and string, binary and array lengths. Bounds are set once, length
 * bounds are non-negative integers, a range must be non-empty and span at
 * most 2^53 values, and a value on a lone bound must sit within exact reach
 * of it.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import { trip } from '../support';

const day = new Date('2020-01-01Z');

describe('Bounds are set once', () => {
  it.each([
    ['p.int min', () => p.int().min(0).min(1)],
    ['p.int max', () => p.int().max(1).max(2)],
    ['p.decimal min', () => p.decimal(0.5).min(0).min(1)],
    ['p.decimal max', () => p.decimal(0.5).max(1).max(2)],
    ['p.date min', () => p.date().min(day).min(day)],
    ['p.date max', () => p.date().max(day).max(day)],
    ['p.string min', () => p.string().min(1).min(2)],
    ['p.string max', () => p.string().length(5).max(8)],
    ['p.string min', () => p.string().min(2).length(5)],
    ['p.string max', () => p.string().max(10).length(5)],
    ['p.binary max', () => p.binary().length(4).max(8)],
    ['p.binary min', () => p.binary().min(1).min(2)],
    ['p.array min', () => p.array(p.int()).length(3).min(1)],
    ['p.array max', () => p.array(p.int()).max(5).max(6)],
    ['p.array max', () => p.array(p.int()).max(5).length(3)],
  ])('%s', (bound, thunk) => {
    expect(thunk).toThrow(new TypeError(`${bound} is already set`));
  });

  it('treats length as min and max together', () => {
    expect(p.binary().length(3).encode(new Uint8Array(3))).toEqual(
      p.binary().min(3).max(3).encode(new Uint8Array(3))
    );
    expect(() => p.string().length(3).encode('ab')).toThrow(
      'String length 2 is below the minimum 3'
    );
  });
});

describe('Length bounds', () => {
  it.each([
    ['p.string min', () => p.string().min(-1), RangeError, -1],
    ['p.string max', () => p.string().max(1.5), TypeError, 1.5],
    ['p.string min', () => p.string().length(2.5), TypeError, 2.5],
    ['p.binary min', () => p.binary().min(1.5), TypeError, 1.5],
    ['p.binary max', () => p.binary().max(-2), RangeError, -2],
    ['p.array max', () => p.array(p.int()).max(NaN), TypeError, NaN],
    ['p.array max', () => p.array(p.int()).max(Infinity), TypeError, Infinity],
    ['p.array min', () => p.array(p.int()).length(-1), RangeError, -1],
  ])('%s must be a non-negative integer', (bound, thunk, kind, n) => {
    expect(thunk).toThrow(new kind(`${bound} must be a non-negative integer, got ${n}`));
  });
});

describe('Ranges', () => {
  it.each([
    ['p.int', () => p.int().min(3).max(2), '3', '2'],
    ['p.decimal', () => p.decimal(0.5).min(1).max(0.5), '1', '0.5'],
    ['p.string', () => p.string().min(3).max(2), '3', '2'],
    ['p.binary', () => p.binary().min(3).max(2), '3', '2'],
    ['p.array', () => p.array(p.int()).min(5).max(2), '5', '2'],
  ])('%s refuses an empty range at definition', (who, thunk, min, max) => {
    expect(thunk).toThrow(new RangeError(`${who} range is empty: min ${min} exceeds max ${max}`));
  });

  it.each([
    [
      'p.int',
      () =>
        p
          .int()
          .min(-(2 ** 53))
          .max(2 ** 53),
      '[-9007199254740992, 9007199254740992]',
    ],
    ['p.int', () => p.int().min(0).max(Number.MAX_SAFE_INTEGER), '[0, 9007199254740991]'],
    ['p.decimal', () => p.decimal(1).min(-9e15).max(9e15), '[-9000000000000000, 9000000000000000]'],
    [
      'p.date',
      () => p.date().min(new Date(-8.64e15)).max(new Date(8.64e15)),
      '[-271821-04-20T00:00:00.000Z, +275760-09-13T00:00:00.000Z]',
    ],
  ])('%s refuses a range of more than 2^53 values at definition', (who, thunk, range) => {
    expect(thunk).toThrow(new RangeError(`${who} range ${range} spans more than 2^53 values`));
  });
});

describe('Lone bounds', () => {
  it('refuse a value too far from the bound to index exactly', () => {
    // The offset against the bound is float arithmetic; past 2^53 it rounds
    // to a neighbouring integer.
    expect(() =>
      p
        .int()
        .max(1)
        .encode(-(2 ** 53))
    ).toThrow(
      new RangeError('Value -9007199254740992 is too far from its bound 1 to encode exactly')
    );
    expect(() =>
      p
        .int()
        .min(1)
        .encode(2 ** 53 + 6)
    ).toThrow(`Value ${2 ** 53 + 6} is too far from its bound 1`);
    expect(() =>
      p
        .decimal(1)
        .min(-9e15)
        .encode(9e15 + 1)
    ).toThrow('Value 9000000000000001 is too far from its bound -9000000000000000');
    expect(() =>
      p
        .date()
        .min(new Date(-8.6e15))
        .encode(new Date(8.6e15 + 1))
    ).toThrow(
      'Value +274493-02-24T00:53:20.001Z is too far from its bound -270554-11-06T23:06:40.000Z to encode exactly'
    );
  });

  it('round-trip the largest exactly indexable offset', () => {
    expect(trip(p.int().min(1), 2 ** 53)).toBe(2 ** 53);
  });

  it('read a term offset that cannot reconstruct exactly as corrupt input', () => {
    // bound + offset rounds past 2^53, so the encoder could never have
    // emitted it.
    const enc = new Encoder();
    enc.composeTerm(2 ** 53);
    expect(() => p.int().min(1).decode(enc.output())).toThrow(CorruptInputError);
    const far = p
      .int()
      .min(0)
      .encode(2 ** 53 + 2);
    expect(() => p.int().max(-3).decode(far)).toThrow(CorruptInputError);
  });
});
