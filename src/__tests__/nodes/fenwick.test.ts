/**
 * The Fenwick tree behind adaptive priors, against a plain prefix-sum model
 * over seeded operation sequences, and every refusal.
 */

import { Fenwick } from '../../nodes/fenwick';
import { mulberry32 } from '../support';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Asserts that `tree` holds exactly `model`: sizes, counts, prefixes and every residual's bucket. */
const expectModel = (tree: Fenwick, model: number[]): void => {
  expect(tree.size).toBe(model.length);
  let sum = 0;
  for (let i = 0; i < model.length; i++) {
    expect(tree.prefix(i)).toBe(sum);
    expect(tree.cum(i)).toBe(sum);
    expect(tree.count(i)).toBe(model[i]);
    expect(tree.freq(i)).toBe(model[i]);
    for (let r = sum; r < sum + model[i]; r++) {
      expect(tree.locate(r)).toBe(i);
    }
    sum += model[i];
  }
  expect(tree.prefix(model.length)).toBe(sum);
  expect(tree.total).toBe(sum);
};

describe('Fenwick', () => {
  it('starts empty', () => {
    const tree = new Fenwick([]);
    expect([tree.size, tree.total, tree.prefix(0)]).toEqual([0, 0, 0]);
    tree.halve();
    expect(tree.total).toBe(0);
    tree.push(3);
    expectModel(tree, [3]);
  });

  it.each([1, 2, 7, 33])('tracks a prefix-sum model over seeded operations from %i counts', (n) => {
    const random = mulberry32(n);
    const int = (k: number) => Math.floor(random() * k);
    const model = Array.from({ length: n }, () => int(9));
    const tree = new Fenwick(model);
    expectModel(tree, model);
    for (let step = 0; step < 100; step++) {
      const op = int(10);
      if (op < 6) {
        const i = int(model.length);
        const delta = int(12) - Math.min(model[i], 5);
        tree.add(i, delta);
        model[i] += delta;
      } else if (op < 9) {
        const count = int(20);
        tree.push(count);
        model.push(count);
      } else {
        tree.halve();
        for (let i = 0; i < model.length; i++) {
          model[i] = Math.floor(model[i] / 2);
        }
      }
      expectModel(tree, model);
    }
  });

  it('starts from a size as zeros, and skips empty buckets when locating', () => {
    const tree = Fenwick.zeros(5);
    expectModel(tree, [0, 0, 0, 0, 0]);
    tree.add(3, 2);
    tree.add(0, 1);
    expect([0, 1, 2].map((r) => tree.locate(r))).toEqual([0, 3, 3]);
    expectModel(Fenwick.zeros(0), []);
    expect(() => Fenwick.zeros(1.5)).toThrow(
      new TypeError('Fenwick size must be an integer, got 1.5')
    );
    expect(() => Fenwick.zeros(-1)).toThrow(new RangeError('Fenwick size -1 is negative'));
  });

  it('locates members as a live table, following every push', () => {
    const tree = new Fenwick([3, 0, 2]);
    expect([0, 1, 2].map((i) => tree.located(i))).toEqual([
      [0, 0, 3],
      [1, 3, 0],
      [2, 3, 2],
    ]);
    tree.push(4);
    expect(tree.located(3)).toEqual([3, 5, 4]);
    expect(() => tree.located(4)).toThrow(RangeError);
  });

  it('halves by flooring, down to 0', () => {
    const tree = new Fenwick([1, 2, 3, 0]);
    tree.halve();
    expectModel(tree, [0, 1, 1, 0]);
  });

  it('halves rounding up when asked, so no count above 0 drops to it', () => {
    const tree = new Fenwick([0, 1, 2, 3, 5]);
    tree.halve(true);
    expectModel(tree, [0, 1, 1, 2, 3]);
  });

  it('copies its counts', () => {
    const counts = [1, 2];
    const tree = new Fenwick(counts);
    counts[0] = 9;
    expect(tree.count(0)).toBe(1);
  });

  it('keeps the largest safe total', () => {
    const tree = new Fenwick([MAX_SAFE - 1, 1]);
    expect(tree.total).toBe(MAX_SAFE);
    expect(tree.locate(MAX_SAFE - 1)).toBe(1);
    expect(tree.locate(MAX_SAFE - 2)).toBe(0);
  });

  it.each([
    [1.5, TypeError, 'Fenwick count must be an integer, got 1.5'],
    [NaN, TypeError, 'Fenwick count must be an integer, got NaN'],
    [-1, RangeError, 'Fenwick count -1 is not a non-negative safe integer'],
    [2 ** 53, RangeError, `Fenwick count ${2 ** 53} is not a non-negative safe integer`],
  ])('refuses a count of %p', (count, kind, message) => {
    expect(() => new Fenwick([1, count])).toThrow(new kind(message));
    expect(() => new Fenwick([1]).push(count)).toThrow(new kind(message));
  });

  it('refuses a total past the safe integers', () => {
    expect(() => new Fenwick([MAX_SAFE, 1])).toThrow(
      new RangeError(`Fenwick total ${2 ** 53} is above the maximum ${MAX_SAFE}`)
    );
    expect(() => new Fenwick([MAX_SAFE]).push(1)).toThrow(
      `Fenwick total ${2 ** 53} is above the maximum`
    );
    expect(() => new Fenwick([MAX_SAFE - 1]).add(0, 2)).toThrow(
      `Fenwick total ${2 ** 53} is above the maximum`
    );
  });

  it('refuses an index outside the counts', () => {
    const tree = new Fenwick([1, 2]);
    for (const call of [
      (i: number) => tree.count(i),
      (i: number) => tree.freq(i),
      (i: number) => tree.cum(i),
      (i: number) => tree.add(i, 1),
    ]) {
      expect(() => call(2)).toThrow(new RangeError('Fenwick index 2 is outside [0, 2)'));
      expect(() => call(-1)).toThrow(new RangeError('Fenwick index -1 is outside [0, 2)'));
      expect(() => call(0.5)).toThrow(new TypeError('Fenwick index must be an integer, got 0.5'));
    }
    expect(() => tree.prefix(3)).toThrow(new RangeError('Fenwick prefix 3 is outside [0, 2]'));
    expect(() => tree.prefix(-1)).toThrow(new RangeError('Fenwick prefix -1 is outside [0, 2]'));
    expect(() => tree.prefix(NaN)).toThrow(
      new TypeError('Fenwick prefix must be an integer, got NaN')
    );
  });

  it('refuses a residual outside the total', () => {
    const tree = new Fenwick([1, 2]);
    expect(() => tree.locate(3)).toThrow(new RangeError('Fenwick residual 3 is outside [0, 3)'));
    expect(() => tree.locate(-1)).toThrow(new RangeError('Fenwick residual -1 is outside [0, 3)'));
    expect(() => tree.locate(1.5)).toThrow(
      new TypeError('Fenwick residual must be an integer, got 1.5')
    );
    expect(() => new Fenwick([]).locate(0)).toThrow('Fenwick residual 0 is outside [0, 0)');
  });

  it('refuses a delta that is fractional or drops a count below 0', () => {
    const tree = new Fenwick([3, 2]);
    expect(() => tree.add(0, 0.5)).toThrow(
      new TypeError('Fenwick delta must be an integer, got 0.5')
    );
    expect(() => tree.add(1, -3)).toThrow(
      new RangeError('Fenwick count -1 at 1 is below the minimum 0')
    );
    tree.add(0, -3);
    expectModel(tree, [0, 2]);
  });
});
