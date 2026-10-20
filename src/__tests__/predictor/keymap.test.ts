/**
 * The integer-keyed index map behind the context tables, against a Map over
 * seeded key sequences that crowd a few slots, so probes wrap around the
 * table and the slots double several times.
 */

import { IndexMap } from '../../predictor/keymap';
import { mulberry32 } from '../support';

describe('IndexMap', () => {
  it('starts empty', () => {
    const map = new IndexMap();
    expect(map.size).toBe(0);
    expect(map.get(new Float64Array(1), 0)).toBe(-1);
  });

  it('finds added indices by the keys of the caller', () => {
    const keys = Float64Array.from([5, 7, 2 ** 52 + 3, 2 ** 32 + 9, 2 ** 32]);
    const map = new IndexMap();
    keys.forEach((_, x) => map.add(keys, x));
    expect(map.size).toBe(5);
    keys.forEach((key, x) => expect(map.get(keys, key)).toBe(x));
    expect(map.get(keys, 6)).toBe(-1);
    expect(map.get(keys, 2 ** 32 + 1)).toBe(-1);
  });

  it.each([1, 2, 3])('matches a Map through growth (seed %p)', (seed) => {
    const rand = mulberry32(seed);
    // Keys from a small pool, half of them far apart in their high bits, so
    // entries collide and probes run long.
    const pool = Array.from({ length: 300 }, (_, i) =>
      i % 2 === 0 ? i : Math.floor(rand() * 2 ** 48)
    );
    const keys = new Float64Array(pool.length);
    const map = new IndexMap();
    const model = new Map<number, number>();
    while (model.size < pool.length) {
      const key = pool[Math.floor(rand() * pool.length)];
      if (!model.has(key)) {
        keys[model.size] = key;
        map.add(keys, model.size);
        model.set(key, model.size);
      }
      expect(map.size).toBe(model.size);
      if (model.size % 37 === 0) {
        for (const [k, x] of model) {
          expect(map.get(keys, k)).toBe(x);
        }
      }
    }
    for (const key of pool) {
      expect(map.get(keys, key)).toBe(model.get(key));
    }
    expect(map.get(keys, 2 ** 47 + 1)).toBe(-1);
  });
});
