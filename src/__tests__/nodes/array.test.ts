/**
 * `p.array()`: sequences of one item type, with an optional count range.
 * Arrays of items that read one plain digit (`_radix`) read as one run.
 */

import { p, CorruptInputError, Decoder, Encoder, PArray, PNode } from '../../index';
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
      66_138,
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

describe('p.array adapt', () => {
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
    for (const node of [plain.adapt(), plain.weights(weights).adapt({ window: 8 })]) {
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(node, values[0])).toEqual(values[0]);
    }
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).adapt({ window: 64 })).encode(values)).toEqual(
      p.array(plain.adapt({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('learns a skew, at most a byte over the static prior of it', () => {
    const values = run(2000, 3);
    const size = (node: typeof plain) => p.array(node).encode(values).length;
    expect(size(plain.adapt())).toBeLessThan(size(plain));
    expect(size(plain.weights(weights).adapt())).toBeLessThanOrEqual(
      size(plain.weights(weights)) + 1
    );
  });

  it('written once, spends the bytes of its static form', () => {
    for (const value of run(20, 4)) {
      expect(plain.adapt().encode(value)).toEqual(plain.encode(value));
      expect(plain.weights(weights).adapt().encode(value)).toEqual(
        plain.weights(weights).encode(value)
      );
    }
  });

  it('learns a count without a max on the magnitude scale from the min', () => {
    const values = run(300, 5).map((value) => [1, ...value, ...value]);
    const open = p.array(p.int().min(0).max(3)).min(1);
    expect(trip(p.array(open.adapt()), values)).toEqual(values);
    expect(p.array(open.adapt()).encode(values).length).toBeLessThan(
      p.array(open).encode(values).length
    );
    expect(() => open.adapt().encode([])).toThrow(
      new RangeError('Array length 0 is below the minimum 1')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.adapt({ window: 0 })).toThrow(
      new RangeError('p.array learning window must be a positive integer, got 0')
    );
    expect(() => plain.adapt({ window: 1.5 })).toThrow(
      new TypeError('p.array learning window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(7).fill(1)]).adapt()).toThrow(
      new RangeError(
        'p.array adaptive prior 16 and window 1024 overflow with weights totalling 35184372088839'
      )
    );
    const cdf = new TypeError('p.array adapt takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).adapt()).toThrow(cdf);
    expect(() => plain.adapt().cdf((v) => v)).toThrow(cdf);
    expect(() => plain.adapt().adapt()).toThrow(new TypeError('p.array adapt is already set'));
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
      p.array(digit).unique().max(4).adapt(),
      p.array(digit).unique().max(4).compress(),
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
      p.bool().compress(),
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

/** A digit 0–9 as a custom ordinal node, which `.compress()` leaves as it is. */
class PDigit extends PNode<number> {
  readonly _radix = 10;
  _toDigit(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 9) {
      throw new RangeError(`Value ${value} is no digit`);
    }
    return value;
  }
  _fromDigit(digit: number): number {
    return digit;
  }
  _write(enc: Encoder, value: number): void {
    enc.compose(this._toDigit(value), 10);
  }
  _read(dec: Decoder): number {
    return dec.parse(10);
  }
}

/** Writes any number as a digit and refuses a 9 when it reads one back. */
class PNoNine extends PNode<number> {
  _write(enc: Encoder, value: number): void {
    enc.compose(value, 10);
  }
  _read(dec: Decoder): number {
    const digit = dec.parse(10);
    if (digit === 9) {
      throw new CorruptInputError('Nine');
    }
    return digit;
  }
}

describe('p.array compress', () => {
  const digit = p.int().min(0).max(9);
  const words = ['alpha', 'beta', 'alphabet', '', 'gamma', 'beta'];

  it('round-trips empty, one and many items', () => {
    expect(trip(p.array(digit).compress(), [])).toEqual([]);
    expect(trip(p.array(p.string()).compress({ window: 64 }), [])).toEqual([]);
    expect(trip(p.array(digit).compress(), [7])).toEqual([7]);
    const many = Array.from({ length: 300 }, () => below(10));
    expect(trip(p.array(digit).compress(), many)).toEqual(many);
    expect(trip(p.array(p.string()).compress(), words)).toEqual(words);
  });

  it('round-trips items of every kind', () => {
    const day = 86_400_000;
    const cases: [PNode<any>, unknown[]][] = [
      [p.bool(), [true, false, false, true]],
      [p.bool().weights([1, 3]), [true, false]],
      [p.enum(['a', 'b', 7, null]), ['a', 7, null, 'b']],
      [p.enum(['a', 'b']).weights([3, 1]), ['b', 'a']],
      [p.int(), [0, -5, 1e9, 3]],
      [digit, [1, 9, 0]],
      [p.decimal(0.01).min(-10).max(10), [1.25, -3.5, 0]],
      [p.date(), [new Date(0), new Date(day * 400)]],
      [p.float(), [1.5, -0, NaN, Infinity]],
      [p.string(), ['x', '', 'xyz']],
      [p.binary(), [new Uint8Array([1, 2]), new Uint8Array()]],
      [p.null(), [null, null]],
      [p.optional(digit), [1, undefined, 2]],
      [p.nullable(p.string()), ['a', null, 'b']],
      [p.nullable(p.optional(p.int())), [null, undefined, 4]],
      [p.union([p.string(), p.int(), p.bool()]), ['a', 3, true, false]],
      [p.union([p.object({ a: digit }), p.array(digit)]), [{ a: 1 }, [2]]],
      [p.nullable(p.array(digit)), [null, [1], []]],
      [
        p.tagged('t', {
          a: p.object({ n: digit }),
          b: p.object({ s: p.string() }),
        }),
        [
          { t: 'a', n: 3 },
          { t: 'b', s: 'q' },
        ],
      ],
      [
        p.object({ a: digit, b: p.string() }),
        [
          { a: 1, b: 'x' },
          { a: 2, b: '' },
        ],
      ],
      [p.array(digit), [[], [1, 2], [3]]],
      [p.array(p.array(p.string())), [[[]], [['a'], []], []]],
      [p.map(p.string(), digit), [new Map([['a', 1]]), new Map()]],
      [p.set(digit), [new Set([3, 1]), new Set()]],
      [p.record(p.string()), [{ a: 'x', b: '' }, {}]],
      [p.lazy(() => digit), [4, 5]],
      [p.any(), [1, 'a', [null], { b: true }]],
      [p.int().adapt(), [1, 2, 1, 1]],
      [new PDigit(), [3, 0, 9]],
    ];
    for (const [item, value] of cases) {
      const node = p.array(item).compress();
      expect(trip(node, value)).toEqual(value);
      expect(trip(p.array(node), [value, [], value])).toEqual([value, [], value]);
    }
  });

  it('round-trips nested and recursive containers', () => {
    interface Tree {
      v: number;
      kids: Tree[];
    }
    const tree: PNode<Tree> = p.object({ v: digit, kids: p.array(p.lazy(() => tree)) });
    const node = p.array(tree).compress();
    const value: Tree[] = [
      { v: 1, kids: [{ v: 2, kids: [] }] },
      { v: 3, kids: [] },
    ];
    expect(trip(node, value)).toEqual(value);
    const deep = p.object({ list: p.array(p.object({ m: p.map(digit, p.array(p.string())) })) });
    const inner = {
      list: [{ m: new Map([[1, ['a', 'b']]]) }, { m: new Map<number, string[]>() }],
    };
    expect(trip(deep.compress(), inner)).toEqual(inner);
  });

  it('codes no end at its max, and none at a fixed length', () => {
    const value = Array.from({ length: 5 }, (_, i) => i);
    const fixed = p.array(digit).length(5).compress();
    expect(trip(fixed, value)).toEqual(value);
    expect(fixed.encode(value).length).toBeLessThanOrEqual(
      p.array(digit).compress().encode(value).length
    );
    const capped = p.array(digit).max(5).compress();
    expect(trip(capped, value)).toEqual(value);
    expect(trip(capped, [1])).toEqual([1]);
  });

  it('decodes counts at and above the min, and refuses one out of range', () => {
    const node = p.array(digit).min(2).max(4).compress();
    for (const value of [
      [1, 2],
      [1, 2, 3],
      [1, 2, 3, 4],
    ]) {
      expect(trip(node, value)).toEqual(value);
    }
    expect(() => node.encode([1])).toThrow(new RangeError('Array length 1 is below the minimum 2'));
    expect(() => node.encode([1, 2, 3, 4, 5])).toThrow(
      new RangeError('Array length 5 is above the maximum 4')
    );
  });

  it('refuses weights or a cdf over the count, in either order', () => {
    const capped = p.array(digit).max(3);
    const message = new TypeError(
      'p.array compress cannot weigh the count: a compressed array ends with a symbol'
    );
    expect(() => capped.weights([1, 1, 1, 1]).compress()).toThrow(message);
    expect(() => capped.compress().weights([1, 1, 1, 1])).toThrow(message);
    expect(() => capped.cdf((n) => n).compress()).toThrow(message);
    expect(() => capped.compress().cdf((n) => n)).toThrow(message);
  });

  it('sets compress once, and not with adapt', () => {
    const node = p.array(digit);
    expect(() => node.compress().compress()).toThrow(
      new TypeError('p.array compress is already set')
    );
    expect(() => node.adapt().compress()).toThrow(
      new TypeError('p.array adapt and compress cannot both be set')
    );
    expect(() => node.compress().adapt()).toThrow(
      new TypeError('p.array adapt and compress cannot both be set')
    );
  });

  it('keeps an item that learns or adapts as it is', () => {
    const values = [3, 3, 1, 3];
    for (const item of [digit.adapt(), digit.compress({ window: 16 })]) {
      expect(trip(p.array(item).compress(), values)).toEqual(values);
    }
    const learned = p.object({ a: p.array(digit).adapt(), b: p.string() }).compress();
    expect(trip(learned, { a: values, b: 'x' })).toEqual({ a: values, b: 'x' });
  });

  it('keeps the order restrictions', () => {
    const shuffled = [5, 1, 5, 0];
    expect(trip(p.array(digit).unordered().compress(), shuffled)).toEqual([0, 1, 5, 5]);
    expect(trip(p.array(digit).sorted().compress(), [0, 1, 1, 4])).toEqual([0, 1, 1, 4]);
    expect(trip(p.array(digit).unique().compress(), [7, 2, 9])).toEqual([7, 2, 9]);
    expect(trip(p.array(p.string()).unordered().compress(), words)).toEqual([...words].sort());
    const distinct = [...new Set(words)];
    expect(trip(p.array(p.string()).unique().compress(), distinct)).toEqual(distinct);
    expect(() => p.array(digit).unique().compress().encode([7, 2, 7])).toThrow(
      new RangeError('[2]: Value 7 repeats an earlier one')
    );
    expect(() => p.array(digit).sorted().compress().encode([1, 4, 2])).toThrow(
      new RangeError('[2]: Value 2 is below the one before it')
    );
    expect(() => p.array(p.string()).sorted().compress().encode(['b', 'a'])).toThrow(
      new RangeError('[1]: Value "a" is below the one before it')
    );
    expect(() => p.array(p.string()).unique().compress().encode(['a', 'a'])).toThrow(
      new RangeError('[1]: Value "a" repeats an earlier one')
    );
  });

  it('keeps the order restrictions over an ordinal item', () => {
    const ordinal = new PDigit();
    const bag = new PArray(ordinal, {}, { unordered: true }, { compress: {} });
    expect(trip(bag, [9, 0, 4, 0])).toEqual([0, 0, 4, 9]);
    expect(trip(p.array(ordinal).unique().compress(), [3, 1, 2])).toEqual([3, 1, 2]);
    expect(() => p.array(ordinal).unique().compress().encode([3, 3])).toThrow(
      new RangeError('[1]: Value 3 repeats an earlier one')
    );
  });

  it('locates a value its item refuses', () => {
    expect(() => p.array(digit).compress().encode([1, 10])).toThrow(
      new RangeError('[1]: Value 10 is above the maximum 9')
    );
    expect(() =>
      p
        .array(p.array(digit))
        .compress()
        .encode([[1], [2, 10]])
    ).toThrow(new RangeError('[1][1]: Value 10 is above the maximum 9'));
    const bytes = p.array(new PNoNine()).compress().encode([1, 9]);
    expect(() => p.array(new PNoNine()).compress().decode(bytes)).toThrow(
      new CorruptInputError('[1]: Nine')
    );
  });

  it('round-trips inside plain containers', () => {
    const node = p.object({ a: p.array(digit).compress(), b: p.string() });
    expect(trip(node, { a: [1, 2], b: 'x' })).toEqual({ a: [1, 2], b: 'x' });
  });
});

describe('Plain p.array of compressed items', () => {
  const word = p.string().compress();
  const words = ['alpha', 'beta', 'alpha', '', 'alphabet'];

  it('round-trips items in order and under every restriction', () => {
    expect(trip(p.array(word), words)).toEqual(words);
    expect(trip(p.array(word), [])).toEqual([]);
    expect(trip(p.array(word).unordered(), words)).toEqual([...words].sort());
    const distinct = [...new Set(words)];
    expect(trip(p.array(word).unique(), distinct)).toEqual(distinct);
    expect(() => p.array(word).sorted().encode(['b', 'a'])).toThrow(
      new RangeError('[1]: Value "a" is below the one before it')
    );
    expect(trip(p.array(p.array(word)), [words, [], words])).toEqual([words, [], words]);
    expect(trip(p.array(p.int().min(0).max(9).compress()), [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('locates a value its item refuses, written or read', () => {
    expect(() => p.array(p.int().max(9).compress()).encode([1, 10])).toThrow(
      new RangeError('[1]: Value 10 is above the maximum 9')
    );
    const noNine = p.array(new PNoNine());
    expect(() => noNine.decode(noNine.encode([1, 9]))).toThrow(new CorruptInputError('[1]: Nine'));
    const holding = p.array(p.object({ n: new PNoNine(), s: word }));
    const bytes = holding.encode([
      { n: 1, s: 'a' },
      { n: 9, s: 'b' },
    ]);
    expect(() => holding.decode(bytes)).toThrow(new CorruptInputError('[1].n: Nine'));
  });
});
