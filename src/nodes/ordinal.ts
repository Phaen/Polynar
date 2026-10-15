/**
 * Exact coding of runs of ordinal values: values that each stand for one
 * digit in a radix, in the node's value order. A run restricted to distinct
 * values, to ascending order or to any order has fewer possible values than
 * a free sequence, and the codings here spend exactly the log2 of that
 * number, which no byte-level compressor recovers:
 * - distinct, in their own order: each digit as its rank among the digits
 *   not yet used, so a full permutation of n digits costs log2 n! bits;
 * - a set (ascending and distinct): its rank among all sets of its size,
 *   log2 C(radix, count) bits;
 * - a multiset (ascending with repeats): its rank among all multisets of its
 *   size, log2 C(radix + count − 1, count) bits.
 * Arrays, sets and the keys of maps and records share these restrictions;
 * the JS type only decides what goes in and comes out.
 */

import { Encoder, Decoder, CorruptInputError } from '../packer';
import type { PNode } from './base';
import { atPath, describe } from './path';

/** The order restrictions of a run, each set or left out. */
export interface Order {
  /** The values arrive ascending; with `unique` strictly so. */
  readonly sorted?: true;
  /** No value repeats. */
  readonly unique?: true;
  /** The order carries nothing: any order encodes, and the run decodes ascending. */
  readonly unordered?: true;
}

/** Whether `order` restricts anything. */
export const restricts = (order: Order): boolean =>
  order.sorted !== undefined || order.unique !== undefined || order.unordered !== undefined;

/**
 * Refuses a restriction `which` on values of `node` unless the node spells
 * each value as one digit and maps values to digits; `noun` names those
 * values, as in `p.array sorted requires items of …`.
 */
export function checkOrdinal(
  node: PNode<any>,
  who: string,
  which: string,
  noun: 'items' | 'keys'
): void {
  if (node._radix === undefined || node._toDigit === undefined) {
    throw new TypeError(
      `${who} ${which} requires ${noun} of bounded p.int, p.date or p.decimal, or of p.enum or p.bool, without weights or adaptive`
    );
  }
}

/**
 * The digits of `values` under `node`, which `checkOrdinal` accepted, in the
 * order `writeOrdinal` takes them, with `at[i]` the position in `values` of
 * the i-th digit: ascending when the run is unordered, else as given. A
 * value `node` refuses, a repeat under `unique` and a descent under `sorted`
 * throw, located by `segment` of the offending value's position.
 */
export function ordinalDigits(
  node: PNode<any>,
  values: readonly unknown[],
  order: Order,
  segment: (i: number) => string | number
): { digits: number[]; at: number[] } {
  const toDigit = node._toDigit as (value: unknown) => number;
  const seen = order.unique === undefined ? undefined : new Set<number>();
  const digits: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let digit: number;
    try {
      digit = toDigit.call(node, values[i]);
      if (seen?.has(digit)) {
        throw new RangeError(`Value ${describe(values[i])} repeats an earlier one`);
      }
      if (order.sorted !== undefined && i > 0 && digit < digits[i - 1]) {
        throw new RangeError(`Value ${describe(values[i])} is below the one before it`);
      }
    } catch (error) {
      throw atPath(error, segment(i));
    }
    seen?.add(digit);
    digits.push(digit);
  }
  const at = digits.map((_, i) => i);
  if (order.unordered !== undefined) {
    at.sort((a, b) => digits[a] - digits[b]);
    return { digits: at.map((i) => digits[i]), at };
  }
  return { digits, at };
}

/**
 * Writes `digits`, in `[0, radix)` and meeting `order` in the shape
 * `ordinalDigits` returns them, with the coding the restrictions allow;
 * `order` restricts something.
 */
export function writeOrdinal(
  enc: Encoder,
  digits: readonly number[],
  radix: number,
  order: Order
): void {
  if (order.sorted === undefined && order.unordered === undefined) {
    const ranks = arrangementRanks(digits);
    for (let i = 0; i < ranks.length; i++) {
      enc.compose(ranks[i], radix - i);
    }
    return;
  }
  const repeats = order.unique === undefined;
  enc.composeBig(subsetRank(digits, radix, repeats), subsetCount(radix, digits.length, repeats));
}

/** Reads `count` digits written by `writeOrdinal` under the same radix and order. */
export function readOrdinal(dec: Decoder, radix: number, count: number, order: Order): number[] {
  // No run of distinct digits is longer than its radix.
  if (order.unique !== undefined && count > radix) {
    throw new CorruptInputError(`${count} distinct values do not fit ${radix} digits`);
  }
  if (order.sorted === undefined && order.unordered === undefined) {
    const ranks: number[] = [];
    for (let i = 0; i < count; i++) {
      ranks.push(dec.parse(radix - i));
    }
    return arrangementDigits(ranks);
  }
  const repeats = order.unique === undefined;
  const total = subsetCount(radix, count, repeats);
  return subsetUnrank(dec.parseBig(total), radix, count, repeats);
}

/**
 * Digits used so far, ascending, in sorted blocks of at most twice `cap`, so
 * finding a digit's place and inserting it both cost O(count / cap + cap).
 */
class UsedDigits {
  private readonly blocks: number[][] = [[]];

  constructor(private readonly cap: number) {}

  /** How many used digits lie below `digit`. */
  below(digit: number): number {
    let before = 0;
    for (const block of this.blocks) {
      if (block.length > 0 && block[block.length - 1] < digit) {
        before += block.length;
        continue;
      }
      return before + firstIndex(block, (d) => d >= digit);
    }
    return before;
  }

  /**
   * The unused digit with `rank` unused digits below it. It is `rank` plus
   * the used digits below it, which are the used digits `d` at index `i`
   * whose `d - i` unused digits below them come to at most `rank`.
   */
  unused(rank: number): number {
    let before = 0;
    for (const block of this.blocks) {
      if (block.length > 0 && block[block.length - 1] - (before + block.length - 1) <= rank) {
        before += block.length;
        continue;
      }
      return rank + before + firstIndex(block, (d, i) => d - (before + i) > rank);
    }
    return rank + before;
  }

  /** Marks `digit`, unused so far, as used. */
  add(digit: number): void {
    const { blocks } = this;
    let b = 0;
    while (b < blocks.length - 1 && blocks[b][blocks[b].length - 1] < digit) {
      b++;
    }
    const block = blocks[b];
    block.splice(
      firstIndex(block, (d) => d > digit),
      0,
      digit
    );
    if (block.length > 2 * this.cap) {
      blocks.splice(b + 1, 0, block.splice(this.cap));
    }
  }
}

/**
 * The first index in `[lo, hi)` of `list` meeting `test`, which once met
 * stays met; `hi` when none does.
 */
function firstIndex(
  list: readonly number[],
  test: (value: number, i: number) => boolean,
  lo = 0,
  hi = list.length
): number {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (test(list[mid], mid)) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/** The block size that balances scanning the blocks against inserting into one. */
const blockCap = (count: number): number => Math.max(16, Math.ceil(Math.sqrt(count)));

/**
 * Each of the distinct `digits` as its rank among the digits not used
 * before it: the i-th rank lies in `[0, radix − i)` for any radix above
 * every digit.
 */
export function arrangementRanks(digits: readonly number[]): number[] {
  const used = new UsedDigits(blockCap(digits.length));
  return digits.map((digit) => {
    const rank = digit - used.below(digit);
    used.add(digit);
    return rank;
  });
}

/** The digits `arrangementRanks` gave `ranks`. */
export function arrangementDigits(ranks: readonly number[]): number[] {
  const used = new UsedDigits(blockCap(ranks.length));
  return ranks.map((rank) => {
    const digit = used.unused(rank);
    used.add(digit);
    return digit;
  });
}

/** The product of `f(t)` over t in `[lo, hi)`, multiplied as a balanced tree so the big products pair up evenly. */
function product(lo: number, hi: number, f: (t: number) => bigint): bigint {
  if (hi - lo <= 8) {
    let result = 1n;
    for (let t = lo; t < hi; t++) {
      result *= f(t);
    }
    return result;
  }
  const mid = Math.floor((lo + hi) / 2);
  return product(lo, mid, f) * product(mid, hi, f);
}

/** C(n, c) for a non-negative `n` and an integer `c`: zero outside `[0, n]`. */
export function binomial(n: bigint, c: number): bigint {
  if (c < 0 || BigInt(c) > n) {
    return 0n;
  }
  // C(n, c) = C(n, n − c), whichever multiplies fewer factors.
  const k = Math.min(c, Number(n - BigInt(c)));
  return product(0, k, (t) => n - BigInt(t)) / product(1, k + 1, BigInt);
}

/**
 * The number of runs of `count` ascending digits in `[0, radix)`, `radix`
 * positive: sets C(radix, count), or with `repeats` multisets
 * C(radix + count − 1, count).
 */
export function subsetCount(radix: number, count: number, repeats: boolean): bigint {
  return repeats
    ? binomial(BigInt(radix) + BigInt(count - 1), count)
    : binomial(BigInt(radix), count);
}

/**
 * The sums over `[a, b)` of the series whose terms step by `p(t) / q(t)`
 * from 1 at `a`: `[P, Q, T]` with P and Q the products of `p` and `q`, and
 * the sum T / Q. Binary splitting keeps the big products balanced, so a sum
 * of n terms costs a few multiplications of its own size instead of n.
 */
function series(
  a: number,
  b: number,
  p: (t: number) => bigint,
  q: (t: number) => bigint
): [bigint, bigint, bigint] {
  if (b - a === 1) {
    const qa = q(a);
    return [p(a), qa, qa];
  }
  const mid = Math.floor((a + b) / 2);
  const [p1, q1, t1] = series(a, mid, p, q);
  const [p2, q2, t2] = series(mid, b, p, q);
  return [p1 * p2, q1 * q2, t1 * q2 + p1 * t2];
}

/**
 * Runs of `count` ascending digits in `[0, n)`, `n` at least 2, by how many
 * of them fall in the lower `low` digits: the runs with `j` there pair any
 * lower run of `j` with any upper run of `count − j`. Ranking by `j` first
 * makes the runs before `j` a sum of such products, whose terms step by a
 * ratio of small factors.
 */
class Split {
  readonly low: number;
  readonly high: number;
  /** The smallest and largest number of digits the lower part can hold. */
  readonly from: number;
  readonly to: number;
  /** The ratio of consecutive terms, `p(j) / q(j)` from `j` to `j + 1`. */
  private readonly p: (j: number) => bigint;
  private readonly q: (j: number) => bigint;
  private first?: bigint;

  constructor(
    n: number,
    private readonly count: number,
    private readonly repeats: boolean
  ) {
    const low = Math.floor(n / 2);
    const high = n - low;
    this.low = low;
    this.high = high;
    const c = count;
    if (repeats) {
      this.from = 0;
      this.to = c;
      this.p = (j) => BigInt(low + j) * BigInt(c - j);
      this.q = (j) => BigInt(j + 1) * BigInt(high + c - j - 1);
    } else {
      this.from = Math.max(0, c - high);
      this.to = Math.min(c, low);
      this.p = (j) => BigInt(low - j) * BigInt(c - j);
      this.q = (j) => BigInt(j + 1) * BigInt(high - c + j + 1);
    }
  }

  /** The runs of the upper part when the lower holds `j`. */
  upper(j: number): bigint {
    return subsetCount(this.high, this.count - j, this.repeats);
  }

  /** The runs whose lower part holds fewer than `j` digits, `j` in `[from, to]`. */
  before(j: number): bigint {
    if (j === this.from) {
      return 0n;
    }
    this.first ??= subsetCount(this.low, this.from, this.repeats) * this.upper(this.from);
    const [, q, t] = series(this.from, j, this.p, this.q);
    return (this.first * t) / q;
  }
}

/**
 * The rank of the ascending `digits` among all runs of their count in
 * `[0, radix)`, in `[0, subsetCount(radix, digits.length, repeats))`; the
 * digits are strictly ascending unless `repeats`.
 */
export function subsetRank(digits: readonly number[], radix: number, repeats: boolean): bigint {
  const rank = (a: number, b: number, base: number, n: number): bigint => {
    const c = b - a;
    if (c === 0 || n === 1) {
      return 0n;
    }
    if (c === 1) {
      return BigInt(digits[a] - base);
    }
    if (!repeats && c === n) {
      return 0n;
    }
    const split = new Split(n, c, repeats);
    const mid = base + split.low;
    const m = firstIndex(digits, (d) => d >= mid, a, b);
    const j = m - a;
    return (
      split.before(j) + rank(a, m, base, split.low) * split.upper(j) + rank(m, b, mid, split.high)
    );
  };
  return rank(0, digits.length, 0, radix);
}

/** The ascending digits of `rank` under `subsetRank`, `rank` in `[0, subsetCount(radix, count, repeats))`. */
export function subsetUnrank(
  rank: bigint,
  radix: number,
  count: number,
  repeats: boolean
): number[] {
  const digits: number[] = [];
  const unrank = (r: bigint, base: number, n: number, c: number): void => {
    if (c === 0) {
      return;
    }
    if (n === 1) {
      for (let i = 0; i < c; i++) {
        digits.push(base);
      }
      return;
    }
    if (c === 1) {
      digits.push(base + Number(r));
      return;
    }
    if (!repeats && c === n) {
      for (let i = 0; i < c; i++) {
        digits.push(base + i);
      }
      return;
    }
    const split = new Split(n, c, repeats);
    // The largest j whose runs before it number at most r.
    let lo = split.from;
    let hi = split.to;
    let before = 0n;
    while (lo < hi) {
      const j = Math.ceil((lo + hi) / 2);
      const at = split.before(j);
      if (at <= r) {
        lo = j;
        before = at;
      } else {
        hi = j - 1;
      }
    }
    const upper = split.upper(lo);
    const rest = r - before;
    unrank(rest / upper, base, split.low, lo);
    unrank(rest % upper, base + split.low, split.high, c - lo);
  };
  unrank(rank, 0, radix, count);
  return digits;
}
