/**
 * `p.optional()`: the value or undefined, behind a presence bit.
 */

import { p, Encoder } from '../../index';
import { mulberry32, trip } from '../support';

describe('Schema optional', () => {
  it('hands a present value to its inner node whole', () => {
    // An optional `any` keeps an array whole instead of losing all but the
    // first element; only undefined means absent, so null reaches the inner
    // node.
    const loose = p.optional(p.any());
    expect(trip(loose, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(trip(loose, null)).toBeNull();
    expect(trip(loose, undefined)).toBeUndefined();
  });

  it('spends one presence bit however often it wraps', () => {
    const once = p.optional(p.string());
    expect(p.optional(once)).toBe(once);
    const Schema = p.object({ nick: p.optional(once) });
    expect(trip(Schema, {})).toEqual({});
    expect(trip(Schema, { nick: 'Ada' })).toEqual({ nick: 'Ada' });
  });

  it('reads a present value whose inner any holds its undefined tag as undefined', () => {
    // The encoder spells undefined by the absent bit alone.
    const present = new Encoder();
    present.compose(0, 2);
    p.any()._write(present, undefined);
    expect(p.optional(p.any()).decode(present.output())).toBeUndefined();
  });
});

describe('p.optional adaptive', () => {
  const plain = p.optional(p.int().min(0).max(3));
  const weights = [1, 9] as [number, number];
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => (rnd() < 0.9 ? undefined : Math.floor(rnd() * 4)));
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

  it('learns by `.learn()`, spending what `.adaptive()` does', () => {
    const values = run(300, 5);
    const size = (node: typeof plain) => p.array(node).encode(values);
    expect(size(plain.learn())).toEqual(size(plain.adaptive()));
    expect(size(plain.weights(weights).learn())).toEqual(size(plain.weights(weights).adaptive()));
    expect(size(plain.learn().weights(weights))).toEqual(size(plain.weights(weights).adaptive()));
    expect(size(plain.learning({ window: 8 }).learn())).toEqual(
      size(plain.adaptive({ window: 8 }))
    );
    expect(size(plain.learn())).not.toEqual(size(plain));
  });

  it('sets its learning once and each method once', () => {
    expect(() => plain.learning({}).learning({})).toThrow(
      new TypeError('p.optional learning is already set')
    );
    expect(() => plain.learn().learn()).toThrow(new TypeError('p.optional learn is already set'));
    expect(() => plain.learning({ window: 8 }).adaptive({ window: 8 })).toThrow(
      new TypeError('p.optional learning is already set')
    );
    expect(() => plain.adaptive({ window: 8 }).learning({ window: 8 })).toThrow(
      new TypeError('p.optional learning is already set')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.adaptive({ window: 0 })).toThrow(
      new RangeError('p.optional learning window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.optional learning window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, 2 ** 45] as [number, number]).adaptive()).toThrow(
      new RangeError(
        'p.optional adaptive prior 4 and window 1024 overflow with weights totalling 70368744177664'
      )
    );
  });
});
