/**
 * Item module — full feature & bounds coverage.
 *
 * Features: index-into-a-list encoding, the `sort` option (order-independent
 * output), rejection of items not in the list, and validator rejection of
 * empty/invalid lists.
 */

import { Encoder, Decoder } from '../../polynar';
import type { ItemOptions } from '../../types';

const roundTrip = (value: unknown | unknown[], options: ItemOptions) => {
  const encoder = new Encoder();
  encoder.write(value, options);
  const decoder = new Decoder(encoder.toString());
  return decoder.read(options, Array.isArray(value) ? value.length : 1);
};

const encodeToString = (value: unknown, options: ItemOptions) => {
  const encoder = new Encoder();
  encoder.write(value, options);
  return encoder.toString();
};

describe('Item module', () => {
  it('round-trips an item from the list', () => {
    const list = ['red', 'green', 'blue'];
    expect(roundTrip('green', { type: 'item', list })).toBe('green');
  });

  it('round-trips multiple items', () => {
    const list = ['red', 'green', 'blue'];
    expect(roundTrip(['blue', 'red', 'green'], { type: 'item', list })).toEqual([
      'blue',
      'red',
      'green',
    ]);
  });

  it('handles every position in the list, including first and last', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(roundTrip(['a', 'd'], { type: 'item', list })).toEqual(['a', 'd']);
  });

  it('works with non-string items', () => {
    const list = [10, 20, 30];
    expect(roundTrip(20, { type: 'item', list })).toBe(20);
  });

  it('works with a single-element list', () => {
    expect(roundTrip('only', { type: 'item', list: ['only'] })).toBe('only');
  });

  describe('sort option', () => {
    it('produces identical output regardless of list order', () => {
      const a = encodeToString('a', { type: 'item', list: ['c', 'a', 'b'], sort: true });
      const b = encodeToString('a', { type: 'item', list: ['a', 'b', 'c'], sort: true });
      expect(a).toBe(b);
    });
  });

  it('throws when an item is not in the list', () => {
    const encoder = new Encoder();
    expect(() => encoder.write('missing', { type: 'item', list: ['a', 'b', 'c'] })).toThrow();
  });

  describe('validator rejections', () => {
    const enc = new Encoder();
    it('rejects an empty list', () => {
      expect(() => enc.write('x', { type: 'item', list: [] })).toThrow(TypeError);
    });

    it('rejects a missing list', () => {
      expect(() => enc.write('x', { type: 'item' } as ItemOptions)).toThrow(TypeError);
    });
  });
});
