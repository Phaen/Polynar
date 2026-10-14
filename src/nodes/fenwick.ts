/**
 * A Fenwick tree over non-negative integer counts: the learned part of an
 * adaptive prior, or a live table of its own. Point updates, prefix sums,
 * appends and the bucket lookup a decoder needs all run in O(log size);
 * halving every count rebuilds in O(size).
 */

import type { LivePositions, LiveTable } from './adaptive';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * The lowest set bit of `i`, a positive tree position. Positions stay below
 * 2^31, as no JS array holds that many counts, so the 32-bit `&` is exact.
 */
const lowbit = (i: number): number => i & -i;

/** Refuses an index that is not an integer in `[0, end)`, or `[0, end]` when `inclusive`. */
function checkPosition(i: number, end: number, what: string, inclusive = false): void {
  if (!Number.isInteger(i)) {
    throw new TypeError(`Fenwick ${what} must be an integer, got ${i}`);
  }
  if (i < 0 || (inclusive ? i > end : i >= end)) {
    throw new RangeError(`Fenwick ${what} ${i} is outside [0, ${end}${inclusive ? ']' : ')'}`);
  }
}

/** Refuses a count that is not a non-negative safe integer. */
function checkCount(count: number): void {
  if (!Number.isInteger(count)) {
    throw new TypeError(`Fenwick count must be an integer, got ${count}`);
  }
  if (count < 0 || count > MAX_SAFE) {
    throw new RangeError(`Fenwick count ${count} is not a non-negative safe integer`);
  }
}

/** Refuses a total past the safe integers. */
function checkTotal(total: number): void {
  if (total > MAX_SAFE) {
    throw new RangeError(`Fenwick total ${total} is above the maximum ${MAX_SAFE}`);
  }
}

/**
 * Non-negative integer counts with prefix sums. `counts` holds each count
 * plainly and `tree` the partial sums, 1-based: `tree[j]` sums the
 * `lowbit(j)` counts ending at position `j`. As a live table, member `i`
 * owns the bucket `[prefix(i), prefix(i + 1))`, empty while its count is 0.
 */
export class Fenwick implements LiveTable {
  private readonly counts: number[] = [];
  private readonly tree: number[] = [0];
  private sum = 0;
  private readonly members: { count: number; readonly at: LivePositions['at'] };

  /** Each count a non-negative safe integer, summing to a safe integer; empty is legal. */
  constructor(counts: readonly number[]) {
    for (const count of counts) {
      checkCount(count);
      this.sum += count;
      checkTotal(this.sum);
      this.counts.push(count);
    }
    this.rebuild();
    this.members = { count: this.counts.length, at: (i) => this.located(i) };
  }

  /** `size` counts of 0, `size` a non-negative integer. */
  static zeros(size: number): Fenwick {
    if (!Number.isInteger(size)) {
      throw new TypeError(`Fenwick size must be an integer, got ${size}`);
    }
    if (size < 0) {
      throw new RangeError(`Fenwick size ${size} is negative`);
    }
    return new Fenwick(new Array<number>(size).fill(0));
  }

  /** The number of counts. */
  get size(): number {
    return this.counts.length;
  }

  /** The sum of every count. */
  get total(): number {
    return this.sum;
  }

  /** The count at `i`, an integer in `[0, size)`. */
  count(i: number): number {
    checkPosition(i, this.size, 'index');
    return this.counts[i];
  }

  /** The sum of the counts below `i`, an integer in `[0, size]`. */
  prefix(i: number): number {
    checkPosition(i, this.size, 'prefix', true);
    let sum = 0;
    for (let j = i; j > 0; j -= lowbit(j)) {
      sum += this.tree[j];
    }
    return sum;
  }

  /** Where member `pos`'s bucket starts: `prefix(pos)`, for `pos` in `[0, size)`. */
  cum(pos: number): number {
    checkPosition(pos, this.size, 'index');
    return this.prefix(pos);
  }

  /** The width of member `pos`'s bucket: `count(pos)`. */
  freq(pos: number): number {
    return this.count(pos);
  }

  /** Member `pos` as `parseWeighted` reads it: `[pos, cum(pos), freq(pos)]`. */
  located(pos: number): readonly [number, number, number] {
    return [pos, this.cum(pos), this.freq(pos)];
  }

  /** The members in bucket order; `push` keeps its count current. */
  get positions(): LivePositions {
    return this.members;
  }

  /** Adds `delta` to the count at `i`; the count stays non-negative and the total safe. */
  add(i: number, delta: number): void {
    checkPosition(i, this.size, 'index');
    if (!Number.isInteger(delta)) {
      throw new TypeError(`Fenwick delta must be an integer, got ${delta}`);
    }
    const count = this.counts[i] + delta;
    if (count < 0) {
      throw new RangeError(`Fenwick count ${count} at ${i} is below the minimum 0`);
    }
    checkTotal(this.sum + delta);
    this.counts[i] = count;
    this.sum += delta;
    for (let j = i + 1; j <= this.size; j += lowbit(j)) {
      this.tree[j] += delta;
    }
  }

  /**
   * The largest `i` with `prefix(i) <= residual`, for `residual` an integer
   * in `[0, total)`: the index whose bucket holds the residual, past any
   * empty buckets before it. A descent over the tree from its highest power
   * of two.
   */
  locate(residual: number): number {
    checkPosition(residual, this.sum, 'residual');
    let step = 1;
    while (step * 2 <= this.size) {
      step *= 2;
    }
    let pos = 0;
    let rest = residual;
    for (; step >= 1; step = Math.floor(step / 2)) {
      const next = pos + step;
      if (next <= this.size && this.tree[next] <= rest) {
        pos = next;
        rest -= this.tree[next];
      }
    }
    return pos;
  }

  /** Appends `count`, a non-negative safe integer, keeping the total safe. */
  push(count: number): void {
    checkCount(count);
    checkTotal(this.sum + count);
    const n = this.size;
    // tree[n + 1] covers the counts from n + 2 - lowbit(n + 1) to n + 1.
    const partial = this.prefix(n) - this.prefix(n + 1 - lowbit(n + 1));
    this.counts.push(count);
    this.tree.push(count + partial);
    this.sum += count;
    this.members.count = this.counts.length;
  }

  /** Every count becomes `floor(count / 2)`. */
  halve(): void {
    this.sum = 0;
    for (let i = 0; i < this.counts.length; i++) {
      this.counts[i] = Math.floor(this.counts[i] / 2);
      this.sum += this.counts[i];
    }
    this.rebuild();
  }

  /** Rebuilds the tree from `counts` in O(size). */
  private rebuild(): void {
    const n = this.counts.length;
    this.tree.length = n + 1;
    for (let j = 1; j <= n; j++) {
      this.tree[j] = this.counts[j - 1];
    }
    for (let j = 1; j <= n; j++) {
      const up = j + lowbit(j);
      if (up <= n) {
        this.tree[up] += this.tree[j];
      }
    }
  }
}
