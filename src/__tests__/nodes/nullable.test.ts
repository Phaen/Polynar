/**
 * `p.nullable()`: the value or null.
 */

import { p, Encoder, type PNode } from '../../index';
import { mulberry32, trip } from '../support';

describe('Schema nullable', () => {
  it('writes the same bits as a union with p.null', () => {
    const nick = p.nullable(p.string().max(8));
    expect(trip(nick, null)).toBeNull();
    expect(nick.encode('Ada')).toEqual(p.union([p.string().max(8), p.null()]).encode('Ada'));
    expect(p.nullable(nick)).toBe(nick);
  });

  it('lists weights value first', () => {
    const nulls = Array(64).fill(null);
    const list = (weights: number[]) =>
      p.array(p.nullable(p.int().min(0).max(9)).weights(weights)).length(64);
    expect(trip(list([1, 99]), nulls)).toEqual(nulls);
    expect(list([1, 99]).encode(nulls).length).toBeLessThan(list([99, 1]).encode(nulls).length);
  });

  it('combines with optional', () => {
    const User = p.object({ bio: p.optional(p.nullable(p.string())) });
    expect(trip(User, {})).toEqual({});
    expect(trip(User, { bio: null })).toEqual({ bio: null });
  });

  it('takes inner nodes a union cannot', () => {
    type Link = { id: number; next: Link | null };
    const Link: PNode<Link> = p.object({
      id: p.int().min(0).max(9),
      next: p.nullable(p.lazy(() => Link)),
    });
    const chain = { id: 1, next: { id: 2, next: null } };
    expect(trip(Link, chain)).toEqual(chain);

    const loose = p.nullable(p.any());
    expect(trip(loose, null)).toBeNull();
    expect(trip(loose, [1, 'x'])).toEqual([1, 'x']);
  });

  it('reads a value side holding the inner node null as null', () => {
    // An inner `any`'s own null tag spells null a second way.
    const enc = new Encoder();
    enc.compose(0, 2);
    p.any()._write(enc, null);
    expect(p.nullable(p.any()).decode(enc.output())).toBeNull();
  });
});

describe('p.nullable adaptive', () => {
  const plain = p.nullable(p.int().min(0).max(3));
  const weights = [1, 9];
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => (rnd() < 0.9 ? null : Math.floor(rnd() * 4)));
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
      new RangeError('p.nullable adaptive window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.nullable adaptive window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, 2 ** 45]).adaptive()).toThrow(
      new RangeError(
        'p.nullable adaptive prior 4 and window 1024 overflow with weights totalling 70368744177664'
      )
    );
    expect(() => plain.adaptive().weights([1])).toThrow(
      new TypeError('p.nullable weights must list one weight per value: expected 2, got 1')
    );
  });
});
