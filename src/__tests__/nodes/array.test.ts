/**
 * `p.array()`: sequences of one item type, with an optional count range.
 * Arrays of items that read one plain digit (`_radix`) read as one run.
 */

import { p, CorruptInputError, type PArray, type PNode } from '../../index';
import { mulberry32, trip } from '../support';

const rand = mulberry32(0xa77a);
const below = (n: number): number => Math.floor(rand() * n);

describe('Schema array', () => {
  it('names the bound a count breaks', () => {
    const node = p.array(p.int().min(0).max(9)).min(2).max(4);
    expect(() => node.encode([1])).toThrow(new RangeError('Array length 1 is below the minimum 2'));
    expect(() => node.encode([1, 2, 3, 4, 5])).toThrow('Array length 5 is above the maximum 4');
  });

  it('spends no bits on a fixed count', () => {
    // 40 booleans are exactly 40 bits; the fixed count adds none: 5 bytes.
    const node = p.array(p.bool()).length(40);
    const value = Array.from({ length: 40 }, (_, i) => i % 3 === 0);
    expect(node.encode(value)).toHaveLength(5);
    expect(trip(node, value)).toEqual(value);
    expect(p.array(p.int()).length(0).encode([])).toHaveLength(0);
  });

  it('packs denser than encoding each value on its own', () => {
    const node = p.int().min(0).max(7);
    const values = Array.from({ length: 500 }, (_, i) => i % 8);
    const batch = p.array(node).encode(values).length;
    const individual = values.reduce((n, v) => n + node.encode(v).length, 0);
    expect(batch).toBeLessThan(individual);
  });

  it('decodes undefined items of an optional item type as values, not holes', () => {
    const decoded = trip(p.array(p.optional(p.int().min(0).max(9))), [1, undefined, 3]);
    expect(decoded).toEqual([1, undefined, 3]);
    expect(1 in decoded).toBe(true);
  });

  it('rejects a count no array can have, even when items take no bits', () => {
    const count = p
      .int()
      .min(0)
      .encode(2 ** 33);
    expect(() => p.array(p.null()).decode(count)).toThrow(CorruptInputError);
  });
});

describe('Schema array of single-digit items', () => {
  it.each([
    ['p.bool()', p.bool(), 2],
    ['weighted p.bool()', p.bool().weights([1, 3]), undefined],
    ['p.enum', p.enum(['a', 'b', 'c']), 3],
    ['weighted p.enum', p.enum(['a', 'b', 'c']).weights([1, 2, 3]), undefined],
    ['bounded p.int', p.int().min(-5).max(5), 11],
    ['min-only p.int', p.int().min(0), undefined],
    ['max-only p.int', p.int().max(0), undefined],
    ['unbounded p.int', p.int(), undefined],
    ['weighted p.int', p.int().min(0).max(3).weights([1, 2, 3, 4]), undefined],
    ['bounded p.decimal', p.decimal(0.25).min(-1).max(1), 9],
    ['min-only p.decimal', p.decimal(0.25).min(-1), undefined],
    ['bounded p.date', p.date().min(0).max(86_400_000).precision('hour'), 25],
    ['min-only p.date', p.date().min(0), undefined],
    [
      'p.date with a first bucket before the Date range',
      p.date().min(-8.64e15).max(-8.6e15).precision('week'),
      undefined,
    ],
    ['p.optional', p.optional(p.bool()), undefined],
    ['p.lazy', p.lazy(() => p.bool()), undefined],
  ] as [string, PNode<unknown>, number | undefined][])(
    'marks %s with radix %p',
    (_name, node, radix) => {
      expect(node._radix).toBe(radix);
    }
  );

  it('round-trips dates whose edge bucket starts outside the Date range', () => {
    const edge = p.date().min(-8.64e15).max(-8.6e15).precision('week');
    const values = [new Date(-8.63e15), new Date(-8.61e15)];
    const back = trip(p.array(edge), values);
    expect(back.map((d) => edge.encode(d))).toEqual(values.map((d) => edge.encode(d)));
  });

  const D0 = Date.UTC(2020, 0, 1);
  const cases: [string, PNode<any>, () => unknown][] = [
    ['bool', p.bool(), () => rand() < 0.5],
    ['enum', p.enum(['x', 'y', 'z', 7, null]), () => ['x', 'y', 'z', 7, null][below(5)]],
    ['int 0..255', p.int().min(0).max(255), () => below(256)],
    ['int -1e12..1e12', p.int().min(-1e12).max(1e12), () => below(2e12 + 1) - 1e12],
    ['decimal', p.decimal(0.01).min(-10).max(10), () => (below(2001) - 1000) / 100],
    [
      'date',
      p
        .date()
        .min(D0)
        .max(D0 + 365 * 86_400_000)
        .precision('day'),
      () => new Date(D0 + below(366) * 86_400_000),
    ],
    ['one-member enum', p.enum(['only']), () => 'only'],
  ];

  it.each(cases)('round-trips long arrays of %s', (_, item, make) => {
    for (const count of [0, 1, 3, 250, 5000]) {
      const value = Array.from({ length: count }, make);
      const node = p.array(item);
      expect(node.decode(node.encode(value))).toEqual(value);
      const text = node.encode(value, { type: 'text' });
      expect(node.decode(text)).toEqual(value);
    }
  });

  it('round-trips them inside other structures', () => {
    const node = p.object({
      flags: p.array(p.bool()),
      level: p
        .int()
        .min(1)
        .max(99)
        .weights(Array.from({ length: 99 }, (_, i) => i + 1)),
      bytes: p.array(p.int().min(0).max(255)).length(40),
      tag: p.enum(['a', 'b']).weights([3, 1]),
    });
    const value = {
      flags: Array.from({ length: 77 }, () => rand() < 0.3),
      level: 42,
      bytes: Array.from({ length: 40 }, () => below(256)),
      tag: 'b' as const,
    };
    expect(trip(node, value)).toEqual(value);
  });
});

describe('p.array adaptive', () => {
  const plain = p.array(p.int().min(0).max(3)).max(7);
  const weights = Array.from({ length: 8 }, (_, i) => (i === 3 ? 29 : 1));
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () =>
      Array<number>(rnd() < 0.8 ? 3 : Math.floor(rnd() * 8)).fill(1)
    );
  };

  it('round-trips a run of values, inside an array too', () => {
    const values = run(300, 1);
    for (const node of [plain.adaptive(), plain.weights(weights).adaptive({ window: 8 })]) {
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(node, values[0])).toEqual(values[0]);
    }
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).adaptive({ window: 64 })).encode(values)).toEqual(
      p.array(plain.adaptive({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('learns a skew, at most a byte over the static prior of it', () => {
    const values = run(2000, 3);
    const size = (node: typeof plain) => p.array(node).encode(values).length;
    expect(size(plain.adaptive())).toBeLessThan(size(plain));
    expect(size(plain.weights(weights).adaptive())).toBeLessThanOrEqual(
      size(plain.weights(weights)) + 1
    );
  });

  it('written once, spends the bytes of its static form', () => {
    for (const value of run(20, 4)) {
      expect(plain.adaptive().encode(value)).toEqual(plain.encode(value));
      expect(plain.weights(weights).adaptive().encode(value)).toEqual(
        plain.weights(weights).encode(value)
      );
    }
  });

  it('learns a count without a max on the magnitude scale from the min', () => {
    const values = run(300, 5).map((value) => [1, ...value, ...value]);
    const open = p.array(p.int().min(0).max(3)).min(1);
    expect(trip(p.array(open.adaptive()), values)).toEqual(values);
    expect(p.array(open.adaptive()).encode(values).length).toBeLessThan(
      p.array(open).encode(values).length
    );
    expect(() => open.adaptive().encode([])).toThrow(
      new RangeError('Array length 0 is below the minimum 1')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.adaptive({ window: 0 })).toThrow(
      new RangeError('p.array adaptive window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.array adaptive window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(7).fill(1)]).adaptive()).toThrow(
      new RangeError(
        'p.array adaptive prior 16 and window 1024 overflow with weights totalling 35184372088839'
      )
    );
    const cdf = new TypeError('p.array adaptive takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).adaptive()).toThrow(cdf);
    expect(() => plain.adaptive().cdf((v) => v)).toThrow(cdf);
  });
});

describe('Schema array order restrictions', () => {
  const digit = p.int().min(0).max(9);
  const shuffled = (n: number): number[] => {
    const values = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = below(i + 1);
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  };

  it('codes a shuffled deck in log2 52! bits', () => {
    // 225.6 bits, 29 bytes, where 52 free items take 296.4 bits, 38 bytes.
    const deck = p.array(p.int().min(0).max(51)).length(52);
    const value = shuffled(52);
    expect(deck.unique().encode(value).length).toBeLessThanOrEqual(29);
    expect(deck.encode(value).length).toBeLessThanOrEqual(38);
    expect(trip(deck.unique(), value)).toEqual(value);
  });

  it('keeps sorted items in order and rejects a descent', () => {
    const node = p.array(digit).sorted();
    expect(trip(node, [1, 1, 4, 9])).toEqual([1, 1, 4, 9]);
    expect(trip(node, [])).toEqual([]);
    expect(() => node.encode([1, 4, 2])).toThrow(
      new RangeError('[2]: Value 2 is below the one before it')
    );
    expect(() => node.encode([1, 10])).toThrow(
      new RangeError('[1]: Value 10 is above the maximum 9')
    );
  });

  it('keeps unique items in their order and rejects a repeat', () => {
    const node = p.array(digit).unique();
    expect(trip(node, [7, 2, 9, 0])).toEqual([7, 2, 9, 0]);
    expect(() => node.encode([7, 2, 7])).toThrow(
      new RangeError('[2]: Value 7 repeats an earlier one')
    );
    expect(() => node.encode([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9])).toThrow('[10]: Value 9 repeats');
  });

  it('codes sorted unique items as a set', () => {
    // C(10, 4) = 210 sets, 8 bits with a fixed count.
    const node = p.array(digit).sorted().unique().length(4);
    expect(node.encode([1, 3, 5, 8])).toHaveLength(1);
    expect(trip(node, [1, 3, 5, 8])).toEqual([1, 3, 5, 8]);
    expect(() => node.encode([1, 3, 3, 8])).toThrow('[2]: Value 3 repeats an earlier one');
    expect(() => node.encode([1, 5, 3, 8])).toThrow('[2]: Value 3 is below the one before it');
  });

  it('decodes unordered items ascending', () => {
    const bag = p.array(digit).unordered();
    expect(trip(bag, [5, 1, 5, 0])).toEqual([0, 1, 5, 5]);
    const set = p.array(digit).unordered().unique();
    expect(trip(set, [5, 1, 0])).toEqual([0, 1, 5]);
    expect(() => set.encode([5, 1, 5])).toThrow('[2]: Value 5 repeats an earlier one');
    // C(10, 4) sets against C(13, 4) = 715 multisets.
    expect(set.length(4).encode([9, 0, 4, 2])).toHaveLength(1);
    expect(bag.length(4).encode([9, 0, 4, 2])).toHaveLength(2);
  });

  it('orders items by their digits', () => {
    const colours = ['red', 'green', 'blue'] as const;
    expect(trip(p.array(p.enum(colours)).unordered(), ['blue', 'red', 'green'])).toEqual([
      'red',
      'green',
      'blue',
    ]);
    expect(trip(p.array(p.bool()).unordered(), [false, true, false])).toEqual([true, false, false]);
    expect(trip(p.array(p.decimal(0.5).min(-1).max(1)).sorted(), [-1, 0, 0.5])).toEqual([
      -1, 0, 0.5,
    ]);
    const day = 86_400_000;
    const dates = p
      .array(
        p
          .date()
          .min(0)
          .max(day * 9)
          .precision('day')
      )
      .unique()
      .unordered();
    expect(trip(dates, [new Date(day * 3), new Date(day)])).toEqual([
      new Date(day),
      new Date(day * 3),
    ]);
    // Two dates in one bucket are one value.
    expect(() => dates.encode([new Date(day), new Date(day + 5)])).toThrow(
      '[1]: Value "1970-01-02T00:00:00.005Z" repeats an earlier one'
    );
  });

  it('keeps the restrictions through the count methods', () => {
    const value = [9, 4, 6];
    for (const node of [
      p.array(digit).unique().min(1),
      p.array(digit).unique().max(5),
      p.array(digit).unique().length(3),
      p.array(digit).unique().max(4).weights([1, 1, 1, 5, 1]),
      p
        .array(digit)
        .unique()
        .max(4)
        .cdf((n) => n),
      p.array(digit).unique().max(4).adaptive(),
    ]) {
      expect(trip(node, value)).toEqual(value);
      expect(() => node.encode([1, 1, 1])).toThrow('[1]: Value 1 repeats an earlier one');
    }
    expect(trip(p.array(digit).max(5).sorted(), [1, 2])).toEqual([1, 2]);
  });

  it('round-trips random runs under every restriction', () => {
    const item = p.int().min(-50).max(1000);
    const ascending = (values: number[]) => [...values].sort((a, b) => a - b);
    const free = () => Array.from({ length: below(80) }, () => below(1051) - 50);
    const distinct = () => [...new Set(free())];
    const cases: [PArray<number>, () => number[], (values: number[]) => number[]][] = [
      [p.array(item).sorted(), () => ascending(free()), (v) => v],
      [p.array(item).unique(), distinct, (v) => v],
      [p.array(item).unordered(), free, ascending],
      [p.array(item).sorted().unique(), () => ascending(distinct()), (v) => v],
      [p.array(item).unordered().unique(), distinct, ascending],
    ];
    for (const [node, make, expected] of cases) {
      for (let round = 0; round < 20; round++) {
        const value = make();
        expect(trip(node, value)).toEqual(expected(value));
      }
    }
  });

  it('rejects more unique items than the item has values as corrupt', () => {
    const count = p.int().min(0).encode(3);
    expect(() => p.array(p.bool()).unique().decode(count)).toThrow(CorruptInputError);
  });

  it('sets each restriction once, on items that have digits', () => {
    const node = p.array(digit);
    expect(() => node.sorted().sorted()).toThrow(new TypeError('p.array sorted is already set'));
    expect(() => node.unique().unique()).toThrow('p.array unique is already set');
    expect(() => node.unordered().unordered()).toThrow('p.array unordered is already set');
    expect(() => node.sorted().unordered()).toThrow(
      new TypeError('p.array takes sorted or unordered, not both')
    );
    expect(() => node.unordered().sorted()).toThrow('not both');
    for (const item of [
      p.int(),
      p.float(),
      p.enum(['a', 'b']).weights([1, 2]),
      p.bool().adaptive(),
    ]) {
      for (const restrict of [
        (a: PArray<unknown>) => a.sorted(),
        (a: PArray<unknown>) => a.unique(),
        (a: PArray<unknown>) => a.unordered(),
      ]) {
        expect(() => restrict(p.array(item as PNode<unknown>))).toThrow(
          /^p\.array (sorted|unique|unordered) requires items of p\.string, or of bounded p\.int/
        );
      }
    }
  });
});
