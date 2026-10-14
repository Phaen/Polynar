/**
 * `p.array()`: sequences of one item type, with an optional count range.
 * Arrays of items that read one plain digit (`_radix`) read as one run.
 */

import { p, CorruptInputError, type PNode } from '../../index';
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
      for (const o of [{}, { blockBits: 128 }]) {
        const node = p.array(item);
        expect(node.decode(node.encode(value, o), o)).toEqual(value);
        const text = node.encode(value, { ...o, type: 'text' });
        expect(node.decode(text, o)).toEqual(value);
      }
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

  it('fails on a truncated run like a per-item read', () => {
    const node = p.array(p.int().min(0).max(999)).length(500);
    const bytes = node.encode(Array.from({ length: 500 }, () => below(1000)));
    expect(() => node.decode(bytes.slice(0, bytes.length - 3))).toThrow(
      new CorruptInputError('Unexpected end of input while parsing: truncated or corrupted')
    );
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
    expect(() => p.array(p.int()).adaptive()).toThrow(
      new TypeError('p.array adaptive requires a max count')
    );
    const cdf = new TypeError('p.array adaptive takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).adaptive()).toThrow(cdf);
    expect(() => plain.adaptive().cdf((v) => v)).toThrow(cdf);
  });
});
