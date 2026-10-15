/**
 * The integer-keyed hash map behind the context tables and the finder,
 * against a Map over seeded operation sequences that crowd a few slots, so
 * probes wrap around the table and deletions shift entries back across
 * the wrap.
 */

import { KeyMap } from '../../nodes/keymap';
import { mulberry32 } from '../support';

/** Asserts that `map` holds exactly `model`, and nothing at `absent`. */
const expectModel = (map: KeyMap<number>, model: Map<number, number>, absent: number[]): void => {
  expect(map.size).toBe(model.size);
  for (const [key, value] of model) {
    expect(map.get(key)).toBe(value);
  }
  for (const key of absent) {
    if (!model.has(key)) {
      expect(map.get(key)).toBeUndefined();
    }
  }
};

describe('KeyMap', () => {
  it('starts empty', () => {
    const map = new KeyMap<string>();
    expect(map.size).toBe(0);
    expect(map.get(0)).toBeUndefined();
    expect(map.delete(0)).toBe(false);
  });

  it('sets, replaces and deletes', () => {
    const map = new KeyMap<string>();
    map.set(5, 'a');
    map.set(-7, 'b');
    map.set(2 ** 52 + 3, 'c');
    map.set(5, 'd');
    expect([map.get(5), map.get(-7), map.get(2 ** 52 + 3), map.size]).toEqual(['d', 'b', 'c', 3]);
    expect(map.delete(-7)).toBe(true);
    expect(map.delete(-7)).toBe(false);
    expect([map.get(-7), map.size]).toEqual([undefined, 2]);
  });

  it.each([1, 2, 3])('matches a Map through growth and deletions (seed %p)', (seed) => {
    const rand = mulberry32(seed);
    const map = new KeyMap<number>();
    const model = new Map<number, number>();
    // Keys from a small pool, half of them far apart in their high bits, so
    // entries collide and probes run long.
    const pool = Array.from({ length: 300 }, (_, i) =>
      i % 2 === 0 ? i : Math.floor(rand() * 2 ** 53)
    );
    for (let step = 0; step < 4000; step++) {
      const key = pool[Math.floor(rand() * pool.length)];
      if (rand() < 0.6) {
        map.set(key, step);
        model.set(key, step);
      } else {
        expect(map.delete(key)).toBe(model.delete(key));
      }
      if (step % 97 === 0) {
        expectModel(map, model, pool);
      }
    }
    expectModel(map, model, pool);
    for (const key of [...model.keys()]) {
      expect(map.delete(key)).toBe(true);
    }
    expectModel(map, new Map(), pool);
  });
});
