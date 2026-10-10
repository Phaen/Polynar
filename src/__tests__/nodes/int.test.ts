/**
 * `p.int()`: integers, bounded or not.
 */

import { p } from '../../index';
import { trip } from '../support';

describe('Schema int', () => {
  it.each([
    [p.int(), 5.5],
    [p.int().min(0).max(100), -3.7],
    [p.int(), NaN],
  ])('rejects %p, which is not an integer, instead of truncating', (node, value) => {
    expect(() => node.encode(value)).toThrow(
      new TypeError(`p.int expected an integer, got ${value}`)
    );
  });

  it.each([
    ['min', () => p.int().min(0.5), 0.5],
    ['max', () => p.int().max(9.2), 9.2],
    ['min', () => p.int().min(-Infinity), -Infinity],
    ['max', () => p.int().max(NaN), NaN],
  ])('rejects a %s bound that is not an integer', (bound, thunk, n) => {
    expect(thunk).toThrow(new TypeError(`p.int ${bound} must be an integer, got ${n}`));
  });

  it.each([
    ['unbounded', p.int()],
    ['min-only', p.int().min(-5)],
    ['max-only', p.int().max(5)],
    ['max of -0', p.int().max(-0)],
    ['bounded', p.int().min(-5).max(5)],
    ['weighted', p.int().min(-1).max(1).weights([1, 2, 3])],
  ])('encodes -0 as plain zero, %s', (_name, node) => {
    expect(node.encode(-0)).toEqual(node.encode(0));
    expect(Object.is(node.decode(node.encode(-0)), 0)).toBe(true);
  });

  it('names the bound a value breaks', () => {
    const node = p.int().min(3).max(9);
    expect(trip(node, 3)).toBe(3);
    expect(trip(node, 9)).toBe(9);
    expect(() => node.encode(2)).toThrow(new RangeError('Value 2 is below the minimum 3'));
    expect(() => node.encode(10)).toThrow(new RangeError('Value 10 is above the maximum 9'));
  });
});
