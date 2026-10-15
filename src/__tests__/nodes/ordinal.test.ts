/**
 * The combinatorics behind `.sorted()`, `.unique()` and `.unordered()`:
 * ranks of sets, multisets and arrangements of digits, checked against brute
 * enumeration on small radices and round-tripped through the coder on large
 * ones.
 */

import { p, Encoder, Decoder, CorruptInputError } from '../../index';
import {
  arrangementDigits,
  arrangementRanks,
  binomial,
  checkOrder,
  ordinalDigits,
  readOrdinal,
  restricts,
  subsetCount,
  subsetRank,
  subsetUnrank,
  writeOrdinal,
  type Order,
} from '../../nodes/ordinal';
import { mulberry32 } from '../support';

const rand = mulberry32(0x0d1a);
const below = (n: number): number => Math.floor(rand() * n);

/** Every ascending run of `c` digits in `[start, n)`, strictly unless `repeats`, in lexicographic order. */
function* runs(n: number, c: number, repeats: boolean, start = 0): Generator<number[]> {
  if (c === 0) {
    yield [];
    return;
  }
  for (let d = start; d < n; d++) {
    for (const rest of runs(n, c - 1, repeats, repeats ? d : d + 1)) {
      yield [d, ...rest];
    }
  }
}

/** Every arrangement of `c` distinct digits in `[0, n)`. */
function* arrangements(n: number, c: number, used: number[] = []): Generator<number[]> {
  if (used.length === c) {
    yield [...used];
    return;
  }
  for (let d = 0; d < n; d++) {
    if (!used.includes(d)) {
      used.push(d);
      yield* arrangements(n, c, used);
      used.pop();
    }
  }
}

/** `count` distinct digits below `radix`, ascending. */
const distinct = (count: number, radix: number): number[] => {
  const set = new Set<number>();
  while (set.size < count) {
    set.add(below(radix));
  }
  return [...set].sort((a, b) => a - b);
};

describe('binomial', () => {
  it('counts the ways to pick c of n', () => {
    expect(binomial(0n, 0)).toBe(1n);
    expect(binomial(5n, 2)).toBe(10n);
    expect(binomial(5n, 5)).toBe(1n);
    expect(binomial(52n, 5)).toBe(2598960n);
    expect(binomial(100n, 50)).toBe(100891344545564193334812497256n);
    expect(binomial(2n ** 60n, 2)).toBe((2n ** 60n * (2n ** 60n - 1n)) / 2n);
  });

  it('is zero outside [0, n]', () => {
    expect(binomial(5n, 6)).toBe(0n);
    expect(binomial(5n, -1)).toBe(0n);
  });
});

describe('subsetCount', () => {
  it('counts sets and multisets', () => {
    expect(subsetCount(8, 4, false)).toBe(70n);
    expect(subsetCount(8, 9, false)).toBe(0n);
    expect(subsetCount(3, 2, true)).toBe(6n);
    expect(subsetCount(1, 5, true)).toBe(1n);
    expect(subsetCount(4, 0, false)).toBe(1n);
    expect(subsetCount(4, 0, true)).toBe(1n);
  });

  it('counts multisets past the safe integers exactly', () => {
    const radix = Number.MAX_SAFE_INTEGER;
    const n = BigInt(radix);
    expect(subsetCount(radix, 3, true)).toBe(((n + 2n) * (n + 1n) * n) / 6n);
  });
});

describe('subsetRank / subsetUnrank', () => {
  it.each([false, true])(
    'rank every run of a small radix onto [0, count), repeats %p',
    (repeats) => {
      for (let n = 1; n <= 9; n++) {
        for (let c = 0; c <= (repeats ? 6 : n); c++) {
          const total = subsetCount(n, c, repeats);
          let seen = 0n;
          const ranks = new Set<bigint>();
          for (const run of runs(n, c, repeats)) {
            const rank = subsetRank(run, n, repeats);
            expect(rank >= 0n && rank < total).toBe(true);
            ranks.add(rank);
            expect(subsetUnrank(rank, n, c, repeats)).toEqual(run);
            seen++;
          }
          expect(seen).toBe(total);
          expect(BigInt(ranks.size)).toBe(total);
        }
      }
    }
  );

  it.each([
    [1000, 2 ** 32, false],
    [1000, 2 ** 32, true],
    [300, Number.MAX_SAFE_INTEGER, false],
    [300, Number.MAX_SAFE_INTEGER, true],
    [500, 600, false],
    [500, 3, true],
  ])('round-trip %p digits below %p, repeats %p', (count, radix, repeats) => {
    const digits = repeats
      ? Array.from({ length: count }, () => below(radix)).sort((a, b) => a - b)
      : distinct(count, radix);
    const rank = subsetRank(digits, radix, repeats);
    expect(rank < subsetCount(radix, count, repeats)).toBe(true);
    expect(subsetUnrank(rank, radix, count, repeats)).toEqual(digits);
  });

  it('rank the full set, the only one of its size, at 0', () => {
    expect(subsetRank([0, 1, 2, 3], 4, false)).toBe(0n);
    expect(subsetUnrank(0n, 4, 4, false)).toEqual([0, 1, 2, 3]);
  });
});

describe('arrangementRanks / arrangementDigits', () => {
  it('rank every arrangement of a small radix onto the mixed radix of what is left', () => {
    for (let n = 1; n <= 6; n++) {
      for (let c = 0; c <= n; c++) {
        const codes = new Set<string>();
        for (const digits of arrangements(n, c)) {
          const ranks = arrangementRanks(digits);
          ranks.forEach((rank, i) => expect(rank).toBeLessThan(n - i));
          codes.add(ranks.join());
          expect(arrangementDigits(ranks)).toEqual(digits);
        }
        let total = 1;
        for (let i = 0; i < c; i++) {
          total *= n - i;
        }
        expect(codes.size).toBe(total);
      }
    }
  });

  it('round-trip long arrangements across many blocks', () => {
    // 5000 digits make blocks of 71, which split many times over.
    const perm = Array.from({ length: 5000 }, (_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) {
      const j = below(i + 1);
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    expect(arrangementDigits(arrangementRanks(perm))).toEqual(perm);
    const sparse = distinct(3000, 2 ** 40).reverse();
    expect(arrangementDigits(arrangementRanks(sparse))).toEqual(sparse);
    const ascending = distinct(3000, 2 ** 40);
    expect(arrangementDigits(arrangementRanks(ascending))).toEqual(ascending);
  });
});

describe('writeOrdinal / readOrdinal', () => {
  const trip = (digits: number[], radix: number, order: Order): Uint8Array => {
    const enc = new Encoder();
    writeOrdinal(enc, digits, radix, order);
    const bytes = enc.output();
    const dec = new Decoder(bytes);
    expect(readOrdinal(dec, radix, digits.length, order)).toEqual(digits);
    dec.finalize();
    return bytes;
  };

  it('spend at most the ceiling of the exact log2 count', () => {
    // 52! is 225.6 bits; C(2^32, 1000) is 23469 bits, 2934 bytes. A value
    // low among the count spends fewer.
    const deck = Array.from({ length: 52 }, (_, i) => (i * 7) % 52);
    expect(trip(deck, 52, { unique: true }).length).toBeLessThanOrEqual(29);
    expect(trip([1, 3, 4, 6], 8, { sorted: true, unique: true })).toHaveLength(1);
    // C(256, 3) = 2763520 is 21.4 bits; C(258, 3) = 2829056 too.
    expect(trip([0, 100, 255], 256, { unordered: true, unique: true }).length).toBeLessThanOrEqual(
      3
    );
    expect(trip([7, 7, 7], 256, { sorted: true }).length).toBeLessThanOrEqual(3);
    const ids = distinct(1000, 2 ** 32);
    const bytes = trip(ids, 2 ** 32, { sorted: true, unique: true }).length;
    expect(bytes).toBeLessThanOrEqual(2934);
    expect(bytes).toBeGreaterThan(2934 * 0.99);
  });

  it('meet the performance targets', () => {
    const cases: [number[], number][] = [
      [distinct(1000, 2 ** 32), 2 ** 32],
      [distinct(10_000, 2 ** 20), 2 ** 20],
    ];
    for (const [digits, radix] of cases) {
      const start = performance.now();
      trip(digits, radix, { sorted: true, unique: true });
      expect(performance.now() - start).toBeLessThan(digits.length === 1000 ? 200 : 2000);
    }
  });

  it('reject more distinct digits than the radix holds as corrupt', () => {
    for (const order of [{ unique: true }, { unordered: true, unique: true }] as Order[]) {
      expect(() => readOrdinal(new Decoder(new Uint8Array(0)), 3, 4, order)).toThrow(
        new CorruptInputError('4 distinct values do not fit 3 digits')
      );
    }
    // Multisets take any count.
    const dec = new Decoder(new Uint8Array(0));
    expect(readOrdinal(dec, 1, 4, { unordered: true })).toEqual([0, 0, 0, 0]);
    dec.finalize();
  });
});

describe('checkOrder / ordinalDigits / restricts', () => {
  it('accepts only nodes that spell a value as one digit, or spell runs', () => {
    expect(() => checkOrder(p.int().min(0).max(9), 'p.array', 'sorted', 'items')).not.toThrow();
    expect(() => checkOrder(p.string(), 'p.array', 'sorted', 'items')).not.toThrow();
    expect(() => checkOrder(p.int(), 'p.array', 'sorted', 'items')).toThrow(
      new TypeError(
        'p.array sorted requires items of p.string, or of bounded p.int, p.date or p.decimal, p.enum or p.bool without weights or adaptive'
      )
    );
    expect(() => checkOrder(p.bool().adaptive(), 'p.map', 'unordered', 'keys')).toThrow(
      'p.map unordered requires keys of'
    );
  });

  it('lists digits in write order, located errors first', () => {
    const node = p.int().min(0).max(9);
    const at = (i: number) => i;
    expect(ordinalDigits(node, [3, 1, 2], { unique: true }, at)).toEqual({
      digits: [3, 1, 2],
      at: [0, 1, 2],
    });
    expect(ordinalDigits(node, [3, 1, 3], { unordered: true }, at)).toEqual({
      digits: [1, 3, 3],
      at: [1, 0, 2],
    });
    expect(() => ordinalDigits(node, [3, 1, 3], { unique: true }, at)).toThrow(
      new RangeError('[2]: Value 3 repeats an earlier one')
    );
    expect(() => ordinalDigits(node, [1, 3, 2], { sorted: true }, (i) => `k${i}`)).toThrow(
      new RangeError('k2: Value 2 is below the one before it')
    );
    expect(() => ordinalDigits(node, [1, 10], { sorted: true }, at)).toThrow(
      new RangeError('[1]: Value 10 is above the maximum 9')
    );
  });

  it('tells whether an order restricts anything', () => {
    expect(restricts({})).toBe(false);
    expect(restricts({ sorted: true })).toBe(true);
    expect(restricts({ unique: true })).toBe(true);
    expect(restricts({ unordered: true })).toBe(true);
  });
});
