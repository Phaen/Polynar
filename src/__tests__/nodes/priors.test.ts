/**
 * Schema priors (weights and cdf) — non-uniform encoding costs across node types.
 */

import { p } from '../../index';
import { trip } from '../support';

describe('Schema priors', () => {
  it('weighted enums, bools and presence round-trip both ways', () => {
    const status = p.enum(['ok', 'warn', 'error']).weights([90, 9, 1]);
    for (const v of ['ok', 'warn', 'error'] as const) {
      expect(trip(status, v)).toBe(v);
    }
    expect(trip(p.bool().weights([1, 20]), true)).toBe(true);
    expect(trip(p.bool().weights([1, 20]), false)).toBe(false);
    const o = p.object({ nick: p.string().max(8).optional().weights([1, 99]) });
    expect(trip(o, { nick: 'Ada' })).toEqual({ nick: 'Ada' });
    expect(trip(o, {})).toEqual({});
  });

  it('weights validate as positive integers of the right count', () => {
    expect(() => p.enum(['a', 'b']).weights([1])).toThrow(TypeError);
    expect(() => p.enum(['a', 'b']).weights([1, 0])).toThrow(TypeError);
    expect(() => p.bool().weights([1.5, 1])).toThrow(TypeError);
    expect(() => p.int().optional().weights([0, 1])).toThrow(TypeError);
  });

  it('a cdf prior round-trips and spends by weight', () => {
    // cdf(v) = v² gives value v the weight 2v + 1: high values cheap.
    const node = p
      .int()
      .min(0)
      .max(100)
      .cdf((v) => v * v);
    for (const v of [0, 1, 50, 100]) {
      expect(trip(node, v)).toBe(v);
    }
    const heavy = p.array(node).length(20);
    const flat = p.array(p.int().min(0).max(100)).length(20);
    const highs = Array<number>(20).fill(100);
    expect(heavy.encode(highs).length).toBeLessThan(flat.encode(highs).length);
  });

  it('a cdf rejects zero-weight values and bad shapes', () => {
    // All ten weights on v = 5: it encodes for free, everything else throws.
    const spike = (v: number) => (v <= 5 ? 0 : 10);
    const node = p.int().min(0).max(9).cdf(spike);
    expect(trip(node, 5)).toBe(5);
    expect(() => node.encode(3)).toThrow('zero weight');
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
    ).toThrow('positive weight');
    // Interior non-monotonicity is the caller's contract; it fails loudly at
    // the first encode or decode that touches the descent, not eagerly.
    const parabola = p
      .int()
      .min(0)
      .max(100)
      .cdf((v) => v * (101 - v) + Math.floor(v / 100));
    expect(() => parabola.encode(80)).toThrow(TypeError);
  });

  it('cdf priors ride decimal grids, date buckets and array counts', () => {
    // Latitude with a quadratic stand-in for the spherical prior.
    const lat = p
      .decimal(0.5)
      .min(-90)
      .max(90)
      .cdf((v) => (v + 90) * 2 * ((v + 90) * 2 + 1));
    for (const v of [-90, -0.5, 0, 45.5, 90]) {
      expect(trip(lat, v)).toBe(v);
    }

    const when = p
      .date()
      .min(new Date('2026-01-01'))
      .max(new Date('2026-12-31'))
      .interval('day')
      .cdf((t) => {
        const day = (t - new Date('2026-01-01').getTime()) / 86_400_000;
        return day * day + day;
      });
    const date = new Date('2026-07-17');
    expect(trip(when, date).getTime()).toBe(date.getTime());

    // Short arrays likelier, at a modest total: a trailing prior cannot
    // amortize its bucket offset into following symbols, so the message
    // pays ~log2(total) for it — keep totals small on short messages.
    const shortish = (n: number): number => Math.min(n * 3, 12 + Math.max(0, n - 4));
    const counts = p.array(p.bool()).max(20).cdf(shortish);
    expect(trip(counts, [true, false])).toEqual([true, false]);
    expect(trip(counts, [])).toEqual([]);
    expect(counts.encode([true]).length).toBeLessThanOrEqual(
      p.array(p.bool()).max(20).encode([true]).length
    );

    expect(() => p.decimal(0.5).cdf((v) => v)).toThrow('requires both bounds');
    expect(() => p.array(p.bool()).cdf((n) => n)).toThrow('requires a max');
    expect(() =>
      p
        .array(p.bool())
        .length(3)
        .cdf((n) => n)
    ).toThrow('meaningless on a fixed length');
  });

  it('a weighted prior spends fractional bits on likely values', () => {
    // 100 draws of a 90% member cost ~15 bits; the uniform enum pays
    // log2(3) per slot for the same array.
    const heavy = p.array(p.enum(['ok', 'warn', 'error']).weights([90, 9, 1])).length(100);
    const flat = p.array(p.enum(['ok', 'warn', 'error'])).length(100);
    const all = Array<'ok'>(100).fill('ok');
    expect(heavy.encode(all).length).toBeLessThanOrEqual(4);
    expect(flat.encode(all).length).toBeGreaterThan(18);
  });
});
