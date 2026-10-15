/**
 * Priors: `weights` and `cdf` on the nodes that take them, shared rules and
 * how each node maps its values onto the prior, then the weights module's
 * helpers directly.
 */

import { p, Encoder, Decoder, type Cdf, type PNode } from '../../index';
import {
  RangePrior,
  buildWeights,
  checkIndex,
  checkRange,
  priorKind,
  readTable,
  validateCdf,
  writeTable,
} from '../../nodes/weights';
import { mulberry32, trip } from '../support';

describe('Schema priors', () => {
  it('weights validate as positive integers of the right count', () => {
    expect(() => p.enum(['a', 'b']).weights([1])).toThrow(TypeError);
    expect(() => p.enum(['a', 'b']).weights([1, 0])).toThrow(TypeError);
    expect(() => p.bool().weights([1.5, 1])).toThrow(TypeError);
    expect(() => p.optional(p.int()).weights([0, 1])).toThrow(
      new TypeError('p.optional weights must be positive integers, got 0')
    );
  });

  it('a cdf rejects zero-weight values and bad shapes', () => {
    // All ten weights on v = 5: it encodes for free, everything else throws.
    const spike = (v: number) => (v <= 5 ? 0 : 10);
    const node = p.int().min(0).max(9).cdf(spike);
    expect(trip(node, 5)).toBe(5);
    expect(() => node.encode(3)).toThrow(
      new RangeError('Value 3 has zero weight under the declared cdf')
    );
    expect(() => p.int().cdf((v) => v)).toThrow('requires both bounds');
    // Only relative masses matter: an offset cdf rebases instead of failing.
    const offset = p
      .int()
      .min(1)
      .max(5)
      .cdf((v) => v + 100);
    for (const v of [1, 3, 5]) {
      expect(trip(offset, v)).toBe(v);
    }
    // A constant carries no mass anywhere.
    expect(() =>
      p
        .int()
        .min(1)
        .max(5)
        .cdf(() => 1)
    ).toThrow('p.int cdf must put positive weight on the range, got 0');
    // Interior non-monotonicity is not checked eagerly, as a range may be
    // huge; a value whose own weight is negative fails at its encode.
    const parabola = p
      .int()
      .min(0)
      .max(100)
      .cdf((v) => v * (101 - v) + Math.floor(v / 100));
    expect(() => parabola.encode(80)).toThrow('non-decreasing integer function, fails at 80');
  });

  it('a cdf that goes down elsewhere in the range cannot encode a value it would misdecode', () => {
    // 6 -> 7 descends, so 7's bucket [50, 80) overlaps 5's and 6's. The
    // decoder bisects the range on the cdf: for 7 it probes 5, 8 and 6, finds
    // 60 above 7's bucket and lands on 5. Encode refuses instead, while 5,
    // whose own bucket decodes to 5, still works.
    const sums = [0, 10, 20, 30, 40, 50, 60, 50, 80, 90, 100, 110];
    const dip = p
      .int()
      .min(0)
      .max(10)
      .cdf((v) => sums[v]);
    expect(() => dip.encode(7)).toThrow(
      new TypeError('p.int cdf must be a non-decreasing integer function, fails between 6 and 7')
    );
    expect(() => dip.encode(6)).toThrow(
      new TypeError('p.int cdf must be a non-decreasing integer function, fails at 6')
    );
    for (const v of [0, 1, 2, 3, 4, 5, 8, 9, 10]) {
      expect(trip(dip, v)).toBe(v);
    }
    // A descent can also fake a bucket spanning the whole total at residual
    // 0, which the decoder would take as a symbol written for free. Value 3
    // passes its probes, so the decoder has to notice from the other end.
    const fake = [0, 110, 50, 60, 70, 80, 90, 100, 105, 108, 109, 110];
    const node = p
      .int()
      .min(0)
      .max(10)
      .cdf((v) => fake[v]);
    const list = p.array(node).length(2);
    expect(trip(list, [3, 3])).toEqual([3, 3]);
  });

  it('a bad cdf either refuses a value at encode or round-trips it', () => {
    const rand = mulberry32(11);
    const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
    let encoded = 0;
    for (let c = 0; c < 2000; c++) {
      const n = randInt(2, 24);
      const sums = [0];
      for (let i = 0; i < n; i++) {
        sums.push(sums[i] + randInt(0, 20));
      }
      for (let d = randInt(1, 3); d > 0; d--) {
        sums[randInt(1, n - 1)] = randInt(0, sums[n]);
      }
      if (sums[n] < 1) {
        continue;
      }
      const node = p
        .int()
        .min(0)
        .max(n - 1)
        .cdf((v) => sums[v]);
      // Alone, so its symbol is the message's last, and after an int that
      // leaves the state anywhere.
      const schema = p.object({
        a: p
          .int()
          .min(0)
          .max(2 ** randInt(4, 40)),
        b: node,
      });
      for (const [target, value] of [
        [node, randInt(0, n - 1)],
        [schema, { a: randInt(0, 2 ** 4), b: randInt(0, n - 1) }],
      ] as const) {
        let bytes: Uint8Array;
        try {
          bytes = (target as typeof node).encode(value as number);
        } catch (e) {
          // The cdf fails along the probes, or the value has no weight.
          expect([TypeError, RangeError]).toContain((e as Error).constructor);
          continue;
        }
        encoded++;
        expect((target as typeof node).decode(bytes)).toEqual(value);
      }
    }
    expect(encoded).toBeGreaterThan(300);
  });

  it('int weights are a histogram over the bounded range', () => {
    const stars = p.int().min(1).max(5).weights([5, 2, 3, 10, 80]);
    for (const v of [1, 2, 3, 4, 5]) {
      expect(trip(stars, v)).toBe(v);
    }
    // The same prior as its running total encodes identically.
    const sums = [0, 5, 7, 10, 20, 100];
    const cdf = p
      .int()
      .min(1)
      .max(5)
      .cdf((v) => sums[v - 1]);
    const ratings = [5, 5, 4, 5, 5, 5, 1, 5, 5, 4, 5, 5, 5, 5, 3, 5, 5, 4, 5, 5];
    const list = (node: typeof stars) => p.array(node).length(ratings.length);
    expect(list(stars).encode(ratings)).toEqual(list(cdf).encode(ratings));
    expect(() => p.int().weights([1])).toThrow('requires both bounds');
    expect(() => p.int().min(1).max(5).weights([1, 2])).toThrow(
      new TypeError('p.int weights must list one weight per value: expected 5, got 2')
    );
    expect(() => p.int().min(1).max(5).weights([1, 2, 0, 4, 5])).toThrow(
      'p.int weights must be positive integers, got 0'
    );
    // Both bounds are part of the prior's range, so neither can change after it.
    expect(() => stars.max(6)).toThrow(new TypeError('p.int max is already set'));
  });

  it('needs both bounds, or a max count', () => {
    expect(() => p.decimal(0.5).cdf((v) => v)).toThrow('requires both bounds');
    expect(() => p.decimal(0.5).weights([1])).toThrow('requires both bounds');
    expect(() => p.date().cdf((t) => t)).toThrow('p.date cdf requires both bounds');
    expect(() => p.array(p.bool()).cdf((n) => n)).toThrow('requires a max');
  });

  it('decimal, date and array weights encode like the equivalent cdf', () => {
    const running = (w: readonly number[]) =>
      w.map((_, i) => w.slice(0, i).reduce((a, b) => a + b, 0));

    // Grid points -1, -0.5, ..., 1: k runs -2..2.
    const dw = [1, 4, 10, 4, 1];
    const dsums = [...running(dw), 20];
    const dWeights = p.decimal(0.5).min(-1).max(1).weights(dw);
    const dCdf = p
      .decimal(0.5)
      .min(-1)
      .max(1)
      .cdf((k) => dsums[k + 2]);
    const dValues = [0, 0, -0.5, 1, 0, 0.5, -1, 0];
    for (const v of dValues) {
      expect(trip(dWeights, v)).toBe(v);
    }
    const dList = (node: typeof dWeights) => p.array(node).length(dValues.length);
    expect(dList(dWeights).encode(dValues)).toEqual(dList(dCdf).encode(dValues));

    // Four day buckets from the min bound's day; the cdf counts days from the epoch.
    const tw = [1, 2, 3, 50];
    const tsums = [...running(tw), 56];
    const start = new Date('2026-01-01');
    const day0 = start.getTime() / 86_400_000;
    const end = new Date('2026-01-04');
    const tWeights = p.date().min(start).max(end).precision('day').weights(tw);
    const tCdf = p
      .date()
      .min(start)
      .max(end)
      .precision('day')
      .cdf((b) => tsums[b - day0]);
    const tValues = [end, end, start, new Date('2026-01-02'), end];
    for (const v of tValues) {
      expect(trip(tWeights, v).getTime()).toBe(v.getTime());
    }
    const tList = (node: typeof tWeights) => p.array(node).length(tValues.length);
    expect(tList(tWeights).encode(tValues)).toEqual(tList(tCdf).encode(tValues));

    // Counts 1..4.
    const aw = [8, 4, 2, 1];
    const asums = [...running(aw), 15];
    const aWeights = p.array(p.bool()).min(1).max(4).weights(aw);
    const aCdf = p
      .array(p.bool())
      .min(1)
      .max(4)
      .cdf((n) => asums[n - 1]);
    const aValues = [[true], [false, true], [true], [true, true, false, false], [false]];
    for (const v of aValues) {
      expect(trip(aWeights, v)).toEqual(v);
    }
    const aList = (node: typeof aWeights) => p.array(node).length(aValues.length);
    expect(aList(aWeights).encode(aValues)).toEqual(aList(aCdf).encode(aValues));

    // A change to the range re-checks the count against it.
    expect(() => tWeights.precision('hour')).toThrow('one weight per value');
    expect(() => p.array(p.bool()).max(4).weights(aw).min(0)).toThrow('one weight per value');
    expect(() => dWeights.max(1.5)).toThrow('p.decimal max is already set');
  });

  it('a weighted prior spends fractional bits on likely values', () => {
    // 99 draws of a 90% member and a 9% one cost ~19 bits; the uniform enum
    // pays log2(3) per slot for the same array up to its last nonzero one.
    const heavy = p.array(p.enum(['ok', 'warn', 'error']).weights([90, 9, 1])).length(100);
    const flat = p.array(p.enum(['ok', 'warn', 'error'])).length(100);
    const all = [...Array<'ok'>(99).fill('ok'), 'warn' as const];
    expect(heavy.encode(all).length).toBeLessThanOrEqual(4);
    expect(flat.encode(all).length).toBeGreaterThan(18);
  });

  it('a zero-weight value names itself as the node sees it', () => {
    const spike = (v: number) => (v <= 1 ? 0 : 10);
    expect(() => p.array(p.bool()).max(2).cdf(spike).encode([])).toThrow(
      new RangeError('Array length 0 has zero weight under the declared cdf')
    );
    expect(() => p.decimal(0.5).min(0).max(1).cdf(spike).encode(0)).toThrow(
      'Value 0 has zero weight under the declared cdf'
    );
    const day = p
      .date()
      .min(new Date('2020-01-01Z'))
      .max(new Date('2020-01-03Z'))
      .precision('day')
      .cdf((d) => spike(d - 18262));
    expect(() => day.encode(new Date('2020-01-01T12:00:00Z'))).toThrow(
      'Date 2020-01-01T12:00:00.000Z has zero weight under the declared cdf'
    );
  });

  it('date cdf sees the bucket number from the epoch, as int cdf sees the value', () => {
    const fn = (b: number) => (b - 20000) * 3 + (b % 2);
    const start = new Date('2026-01-01');
    const end = new Date('2026-01-31');
    const day0 = start.getTime() / 86_400_000;
    const dates = p.date().min(start).max(end).precision('day').cdf(fn);
    const days = p
      .int()
      .min(day0)
      .max(day0 + 30)
      .cdf(fn);
    for (const offset of [0, 7, 30]) {
      const date = new Date(start.getTime() + offset * 86_400_000);
      expect(dates.encode(date)).toEqual(days.encode(day0 + offset));
    }
    // A zero-weight day stays the same day whichever min the range starts at.
    const sixth = new Date('2026-01-06');
    const gap = (b: number) => (b > day0 + 5 ? b - 1 : b);
    for (const min of [start, new Date('2026-01-03')]) {
      const node = p.date().min(min).max(end).precision('day').cdf(gap);
      expect(() => node.encode(sixth)).toThrow('has zero weight under the declared cdf');
      expect(trip(node, end).getTime()).toBe(end.getTime());
    }
  });

  it('priors reject malformed weights and cdfs eagerly', () => {
    expect(() => p.enum(['a', 'b']).weights([2 ** 53, 2 ** 53])).toThrow('sum to a safe integer');
    expect(() =>
      p
        .int()
        .min(0)
        .max(1)
        .cdf((v) => v + 0.5)
    ).toThrow('cdf must return safe integers, got 0.5 at 0');
    expect(() =>
      p
        .int()
        .min(0)
        .max(100)
        .cdf((v) => v * 1.5)
    ).toThrow('cdf must return safe integers, got 151.5 at 101');
  });

  it.each<[string, PNode<any> & { adaptive(): PNode<any> }, unknown]>([
    ['p.bool', p.bool(), true],
    ['p.enum', p.enum(['a', 'b']), 'b'],
    ['p.union', p.union([p.int(), p.string()]), 'x'],
    ['p.tagged', p.tagged('kind', { a: p.object({}) }), { kind: 'a' }],
    ['p.optional', p.optional(p.int()), undefined],
    ['p.nullable', p.nullable(p.int()), null],
    ['p.int', p.int().min(0).max(9), 7],
    ['p.decimal', p.decimal(0.5).min(0).max(2), 1.5],
    ['p.date', p.date().min(new Date(0)).max(new Date(9)), new Date(7)],
    ['p.string', p.string().max(3), 'ab'],
    ['p.binary', p.binary().max(3), Uint8Array.of(1, 2)],
    ['p.array', p.array(p.int()).max(3), [1, 2]],
    ['p.map', p.map(p.string(), p.int()).max(3), new Map([['a', 1]])],
    ['p.record', p.record(p.int()).max(3), { a: 1 }],
    ['p.set', p.set(p.int()).max(3), new Set([1])],
  ])('%s refines into an adaptive node of the same class', (_, node, value) => {
    const adaptive = node.adaptive();
    expect(adaptive).not.toBe(node);
    expect(adaptive.constructor).toBe(node.constructor);
    expect(trip(adaptive, value)).toEqual(value);
  });
});

describe('buildWeights', () => {
  const table = buildWeights([1, 2, 5], 3, 'w');

  it('lays out running totals', () => {
    expect([table.cums, table.freqs, table.total]).toEqual([[0, 1, 3], [1, 2, 5], 8]);
  });

  it('refuses a state count that is not a positive integer', () => {
    expect(() => buildWeights([], 0, 'w')).toThrow(
      new RangeError('w weights need at least one value, got 0')
    );
    expect(() => buildWeights([], -1, 'w')).toThrow(RangeError);
    expect(() => buildWeights([1], 1.5, 'w')).toThrow(
      new TypeError('w weights need a whole number of values, got 1.5')
    );
    expect(() => buildWeights([1], NaN, 'w')).toThrow(TypeError);
    expect(() => buildWeights([1], Infinity, 'w')).toThrow(TypeError);
  });

  it('refuses a weight list of the wrong length or with bad weights', () => {
    expect(() => buildWeights([1, 1], 3, 'w')).toThrow(
      new TypeError('w weights must list one weight per value: expected 3, got 2')
    );
    for (const w of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => buildWeights([1, w], 2, 'w')).toThrow(
        new TypeError(`w weights must be positive integers, got ${w}`)
      );
    }
    expect(() => buildWeights([Number.MAX_SAFE_INTEGER, 1], 2, 'w')).toThrow(
      new RangeError('w weights must sum to a safe integer')
    );
  });

  it('locates the bucket holding a residual, clamping one outside [0, total)', () => {
    expect([0, 1, 2, 3, 7].map((r) => table.locate(r)[0])).toEqual([0, 1, 1, 2, 2]);
    expect(table.locate(3)).toEqual([2, 3, 5]);
    expect(table.locate(-1)[0]).toBe(0);
    expect(table.locate(NaN)[0]).toBe(0);
    expect(table.locate(8)[0]).toBe(2);
    expect(table.locate(Infinity)[0]).toBe(2);
  });

  it('locates every residual of a large table, guided or too wide to guide', () => {
    const rnd = mulberry32(5);
    for (const top of [1, 1000, 2 ** 40, 2 ** 47]) {
      const weights = Array.from({ length: 40 }, () => 1 + Math.floor(rnd() * top));
      const big = buildWeights(weights, weights.length, 'w');
      big.cums.forEach((cum, i) => {
        const end = cum + big.freqs[i] - 1;
        for (const r of [cum, end, cum + (end - cum) / 2]) {
          expect(big.locate(r)).toEqual([i, cum, big.freqs[i]]);
        }
      });
      expect(big.locate(-0.5)[0]).toBe(0);
      expect(big.locate(big.total)[0]).toBe(39);
    }
  });
});

describe('writeTable and readTable', () => {
  const table = buildWeights([3, 1], 2, 'w');

  it('round-trip each position', () => {
    const enc = new Encoder();
    for (const pos of [0, 1, 1, 0]) {
      writeTable(enc, table, pos);
    }
    const dec = new Decoder(enc.output());
    expect([0, 1, 2, 3].map(() => readTable(dec, table))).toEqual([0, 1, 1, 0]);
    dec.finalize();
  });

  it.each([-1, 2, 0.5, NaN, Infinity])('refuses position %p', (pos) => {
    expect(() => writeTable(new Encoder(), table, pos)).toThrow(
      new RangeError(`Position ${pos} is not one of the table's 2 entries`)
    );
  });
});

describe('checkRange', () => {
  it('passes integer bounds, either optional', () => {
    for (const [lo, hi] of [
      [undefined, undefined],
      [-(2 ** 60), undefined],
      [undefined, 2 ** 60],
      [3, 3],
    ]) {
      expect(() => checkRange('r', lo, hi)).not.toThrow();
    }
  });

  it('refuses non-integer bounds, an empty range and one too wide', () => {
    expect(() => checkRange('r', 0.5)).toThrow(new TypeError('r min must be an integer, got 0.5'));
    expect(() => checkRange('r', undefined, -Infinity)).toThrow(
      new TypeError('r max must be an integer, got -Infinity')
    );
    expect(() => checkRange('r', 1, 0, (i) => `#${i}`)).toThrow(
      new RangeError('r range is empty: min #1 exceeds max #0')
    );
    expect(() => checkRange('r', -1, Number.MAX_SAFE_INTEGER)).toThrow(
      'spans more than 2^53 values'
    );
  });
});

describe('checkIndex', () => {
  const subject = () => 'Item';

  it('passes an integer within the bounds', () => {
    expect(() => checkIndex(0, undefined, undefined, subject)).not.toThrow();
    expect(() => checkIndex(-0, 0, 0, subject)).not.toThrow();
    expect(() => checkIndex(2 ** 60, 0, undefined, subject)).not.toThrow();
  });

  it('refuses a non-integer, or an index past either bound', () => {
    for (const index of [0.5, NaN, Infinity]) {
      expect(() => checkIndex(index, undefined, undefined, subject)).toThrow(
        new TypeError('Item is not an integer')
      );
    }
    expect(() => checkIndex(-1, 0, undefined, subject, (i) => `#${i}`)).toThrow(
      new RangeError('Item is below the minimum #0')
    );
    expect(() => checkIndex(2, undefined, 1, subject)).toThrow(
      new RangeError('Item is above the maximum 1')
    );
  });
});

describe('validateCdf', () => {
  it('keeps a cdf that starts at 0 and rebases one that does not', () => {
    const square: Cdf = (v) => v * v;
    expect(validateCdf(square, 0, 3, 'c')).toEqual({ cdf: square, total: 16 });
    const { cdf, total } = validateCdf((v) => v + 100, 5, 9, 'c');
    expect([cdf(5), cdf(10), total]).toEqual([0, 5, 5]);
  });

  it('refuses a bad range', () => {
    expect(() => validateCdf((v) => v, 3, 2, 'c')).toThrow(
      new RangeError('c range is empty: min 3 exceeds max 2')
    );
    expect(() => validateCdf((v) => v, 0.5, 2, 'c')).toThrow(
      new TypeError('c min must be an integer, got 0.5')
    );
    expect(() => validateCdf((v) => v, 2 ** 53, 2 ** 53, 'c')).toThrow(
      new RangeError(
        `c cdf requires bounds within ±${Number.MAX_SAFE_INTEGER}, got [${2 ** 53}, ${2 ** 53}]`
      )
    );
    expect(() => validateCdf((v) => v, -(2 ** 53), -(2 ** 53), 'c')).toThrow(
      'requires bounds within'
    );
  });

  it('refuses unsafe values at either end and no mass in between', () => {
    expect(() => validateCdf((v) => (v < 1 ? NaN : v), 0, 1, 'c')).toThrow(
      new TypeError('c cdf must return safe integers, got NaN at 0')
    );
    expect(() => validateCdf((v) => (v > 1 ? 2 ** 53 : v), 0, 1, 'c')).toThrow(
      new TypeError(`c cdf must return safe integers, got ${2 ** 53} at 2`)
    );
    expect(() => validateCdf((v) => -v, 0, 1, 'c')).toThrow(
      new TypeError('c cdf must put positive weight on the range, got -2')
    );
  });
});

describe('priorKind', () => {
  it('tells a cdf from weights', () => {
    expect(priorKind((v) => v)).toBe('cdf');
    expect(priorKind([1])).toBe('weights');
  });
});

describe('RangePrior', () => {
  /** Writes values through `prior`, then reads as many back. */
  const roundTrip = (prior: RangePrior, values: number[]): number[] => {
    const enc = new Encoder();
    for (const v of values) {
      prior.write(enc, v, () => `Value ${v}`);
    }
    const dec = new Decoder(enc.output());
    const out = values.map(() => prior.read(dec));
    dec.finalize();
    return out;
  };

  it('round-trips values under weights and under a cdf', () => {
    const values = [-2, 0, 2, 1, -1, 2];
    expect(roundTrip(new RangePrior([1, 4, 1, 9, 2], -2, 2, 'r'), values)).toEqual(values);
    expect(roundTrip(new RangePrior((v) => v * v * v, -2, 2, 'r'), values)).toEqual(values);
    const single = new RangePrior([7], 5, 5, 'r');
    expect(single.declared).toEqual([7]);
    expect(roundTrip(single, [5, 5])).toEqual([5, 5]);
  });

  it('refuses a bad range with its own message, not as a weight error', () => {
    expect(() => new RangePrior([1], 3, 2, 'r')).toThrow(
      new RangeError('r range is empty: min 3 exceeds max 2')
    );
    expect(
      () =>
        new RangePrior(
          (v) => v,
          3,
          2,
          'r',
          (i) => `#${i}`
        )
    ).toThrow(new RangeError('r range is empty: min #3 exceeds max #2'));
    expect(() => new RangePrior([1], NaN, 2, 'r')).toThrow(
      new TypeError('r min must be an integer, got NaN')
    );
    expect(() => new RangePrior([1], 2 ** 53, 2 ** 53, 'r')).toThrow(
      new RangeError(
        `r weights requires bounds within ±${Number.MAX_SAFE_INTEGER}, got [${2 ** 53}, ${2 ** 53}]`
      )
    );
    expect(() => new RangePrior([1, 1], 0, 2, 'r')).toThrow('expected 3, got 2');
  });

  it('refuses a value that is not an integer within the range', () => {
    const prior = new RangePrior([1, 1, 1], 1, 3, 'r', (i) => `#${i}`);
    const subject = () => 'Item';
    expect(() => prior.write(new Encoder(), 1.5, subject)).toThrow(
      new TypeError('Item is not an integer')
    );
    expect(() => prior.write(new Encoder(), 0, subject)).toThrow(
      new RangeError('Item is below the minimum #1')
    );
    expect(() => prior.write(new Encoder(), 4, subject)).toThrow(
      new RangeError('Item is above the maximum #3')
    );
  });

  it('refuses a value of zero weight or where the cdf falls', () => {
    const steps = new RangePrior((v) => (v < 2 ? 0 : v === 2 ? 5 : 3), 0, 2, 'r');
    expect(() => steps.write(new Encoder(), 0, () => 'Item')).toThrow(
      new RangeError('Item has zero weight under the declared cdf')
    );
    expect(() => steps.write(new Encoder(), 2, () => 'Item')).toThrow(
      new TypeError('r cdf must be a non-decreasing integer function, fails at 2')
    );
    // A descent between a value and one of the decoder's probes for it, on
    // either side of the value.
    const below = new RangePrior((v) => [0, 1, 3, 2, 4][v], 0, 3, 'r');
    expect(() => below.write(new Encoder(), 3, () => 'Item')).toThrow(
      new TypeError('r cdf must be a non-decreasing integer function, fails between 2 and 3')
    );
    const above = new RangePrior((v) => [0, 3, 2, 3, 4][v], 0, 3, 'r');
    expect(() => above.write(new Encoder(), 0, () => 'Item')).toThrow(
      new TypeError('r cdf must be a non-decreasing integer function, fails between 1 and 2')
    );
  });
});
