/**
 * `p.optional()`: the value or undefined, behind a presence bit.
 */

import { p, Encoder } from '../../index';
import { Priors } from '../../predictor/prior';
import { STRUCT } from '../../predictor/types';
import { mulberry32, trip } from '../support';

/** Text of one bit per digit, so a size counts bits. */
const BITS = { type: 'text', charset: '01' } as const;

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

describe('p.optional structure symbols', () => {
  it('spells presence as KEY or NOKEY', () => {
    const node = p.optional(p.int());
    expect([node._marker(5), node._marker(undefined)]).toEqual([STRUCT.KEY, STRUCT.NOKEY]);
    expect(node._markers()).toEqual(new Set([STRUCT.KEY, STRUCT.NOKEY]));
    expect(node._markerPrior()).toBeUndefined();
    expect(node.weights([1, 3]).adaptive()._markerPrior()?.counts).toEqual([
      [STRUCT.KEY, 8],
      [STRUCT.NOKEY, 24],
    ]);
  });

  it('holds adaptive coding when it or its inner node codes adaptively', () => {
    expect(p.optional(p.bool())._holdsAdaptive).toBe(false);
    expect(p.optional(p.bool().adaptive())._holdsAdaptive).toBe(true);
    expect(p.optional(p.bool()).adaptive()._holdsAdaptive).toBe(true);
  });
});

describe('p.optional learn', () => {
  const plain = p.optional(p.int().min(0).max(3));
  const values = (() => {
    const rnd = mulberry32(5);
    return Array.from({ length: 300 }, () => (rnd() < 0.9 ? undefined : Math.floor(rnd() * 4)));
  })();

  it('round-trips a run, learning the skew under its options', () => {
    for (const node of [plain.learn(), plain.learn({ window: 8 }), plain.weights([1, 9]).learn()]) {
      expect(trip(p.array(node), values)).toEqual(values);
    }
    expect(p.array(plain.learn()).encode(values)).not.toEqual(p.array(plain).encode(values));
  });

  it('sets each method once, and not both', () => {
    expect(() => plain.learn().learn()).toThrow(new TypeError('p.optional learn is already set'));
    expect(() => plain.learn().adaptive()).toThrow(
      new TypeError('p.optional learn and adaptive cannot both be set')
    );
    expect(() => plain.adaptive().learn()).toThrow(
      new TypeError('p.optional learn and adaptive cannot both be set')
    );
    expect(() => plain.adaptive().adaptive()).toThrow(
      new TypeError('p.optional adaptive is already set')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.learn({ window: 0 })).toThrow(
      new RangeError('p.optional learning window must be a positive integer, got 0')
    );
  });
});

describe('p.optional adaptive', () => {
  const plain = p.optional(p.int().min(0).max(3));
  const weights = [1, 9] as [number, number];
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => (rnd() < 0.7 ? undefined : Math.floor(rnd() * 4)));
  };

  it('round-trips a run alone, in a plain array and in an adaptive object', () => {
    const values = run(200, 1);
    for (const node of [plain.adaptive(), plain.weights(weights).adaptive({ window: 8 })]) {
      for (const value of values.slice(0, 20)) expect(trip(node, value)).toBe(value);
      expect(trip(p.array(node), values)).toEqual(values);
    }
    const Row = p.object({ n: plain, flag: p.optional(p.bool()), name: p.optional(p.string()) });
    const rows = values.map((n, i) => {
      const row: { n?: number; flag?: boolean; name?: string } = {};
      if (n !== undefined) row.n = n;
      if (i % 3 === 0) row.flag = i % 2 === 0;
      if (i % 4 === 1) row.name = `x${i % 5}`;
      return row;
    });
    expect(trip(p.array(Row.adaptive()), rows)).toEqual(rows);
    expect(trip(p.array(Row).adaptive(), rows)).toEqual(rows);
  });

  it('adapts its inner node unless that one learns or adapts already', () => {
    expect(p.optional(p.bool()).adaptive().inner._adaptive).toEqual({ prior: Priors.json.source });
    const learning = p.bool().learn();
    expect(p.optional(learning).adaptive().inner).toBe(learning);
    const values = [true, undefined, false, true, undefined];
    expect(trip(p.array(p.optional(learning).adaptive()), values)).toEqual(values);
  });

  it('stays as it is under an adaptive parent when it learns', () => {
    const node = plain.learn();
    expect(node._adapted({}, new Map())).toBe(node);
    const Row = p.object({ n: node }).adaptive();
    expect(trip(Row, { n: 2 })).toEqual({ n: 2 });
    expect(trip(Row, {})).toEqual({});
  });

  it('takes its weights as prior counts of its symbols, coded by itself or its parent', () => {
    const absent = Array<undefined>(12).fill(undefined);
    const size = (w: [number, number], parent: boolean) => {
      const node = plain.weights(w);
      const list = parent
        ? p.array(node).length(12).adaptive()
        : p.array(node.adaptive()).length(12);
      return list.encode(absent, BITS).length;
    };
    for (const parent of [false, true]) {
      expect(size([1, 30], parent)).toBeLessThan(size([30, 1], parent));
    }
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).adaptive({ window: 64 })).encode(values)).toEqual(
      p.array(plain.adaptive({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.adaptive({ window: 0 })).toThrow(
      new RangeError('p.optional: adaptive window must be at least 1')
    );
    expect(() => plain.adaptive([] as never)).toThrow(
      new TypeError('p.optional: adaptive options must be an object')
    );
  });
});
