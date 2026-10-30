/**
 * `p.nullable()`: the value or null.
 */

import { p, Encoder, Decoder, PNode } from '../../index';
import { loadedPriors } from '../../predictor/prior';
import { STRUCT } from '../../predictor/types';
import { mulberry32, trip } from '../support';

/** Text of one bit per digit, so a size counts bits. */
const BITS = { type: 'text', charset: '01' } as const;

describe('Schema nullable', () => {
  it('writes the same bits as a union with p.null', () => {
    const nick = p.nullable(p.string().max(8));
    expect(trip(nick, null)).toBeNull();
    expect(nick.encode('Ada')).toEqual(p.union([p.string().max(8), p.null()]).encode('Ada'));
    expect(p.nullable(nick)).toBe(nick);
  });

  it('lists weights value first', () => {
    const nulls = Array(64).fill(null);
    const list = (weights: [number, number]) =>
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

describe('p.nullable structure symbols', () => {
  it('spells null as NULL and a value as its inner node does', () => {
    const node = p.nullable(p.int());
    expect([node._marker(null), node._marker(5)]).toEqual([STRUCT.NULL, STRUCT.INT]);
    expect(p.nullable(p.bool())._marker(false)).toBe(STRUCT.FALSE);
    expect(node._markers()).toEqual(new Set([STRUCT.NULL, STRUCT.INT]));
    expect(p.nullable(p.any())._markers()).toBeUndefined();
    expect(node._markerPrior()).toBeUndefined();
  });

  it('weighs the null side against the value’s own symbols', () => {
    expect(p.nullable(p.bool()).weights([2, 1]).compress()._markerPrior()?.counts).toEqual([
      [STRUCT.TRUE, 16],
      [STRUCT.FALSE, 16],
      [STRUCT.NULL, 16],
    ]);
    expect(p.nullable(p.any()).weights([2, 1]).compress()._markerPrior()?.counts).toEqual([
      [STRUCT.NULL, 16],
    ]);
  });

  it('takes undefined when its inner node does', () => {
    expect(p.nullable(p.int())._takesUndefined()).toBe(false);
    expect(p.nullable(p.optional(p.int()))._takesUndefined()).toBe(true);
  });

  it('holds compress coding when it or its inner node codes compressed', () => {
    expect(p.nullable(p.bool())._holdsCompress).toBe(false);
    expect(p.nullable(p.bool().compress())._holdsCompress).toBe(true);
    expect(p.nullable(p.bool()).compress()._holdsCompress).toBe(true);
  });
});

describe('p.nullable learn', () => {
  const plain = p.nullable(p.int().min(0).max(3));
  const values = (() => {
    const rnd = mulberry32(5);
    return Array.from({ length: 300 }, () => (rnd() < 0.9 ? null : Math.floor(rnd() * 4)));
  })();

  it('round-trips a run, learning the skew under its options', () => {
    for (const node of [plain.learn(), plain.learn({ window: 8 }), plain.weights([1, 9]).learn()]) {
      expect(trip(p.array(node), values)).toEqual(values);
    }
    expect(p.array(plain.learn()).encode(values)).not.toEqual(p.array(plain).encode(values));
  });

  it('sets each method once, and not both', () => {
    expect(() => plain.learn().learn()).toThrow(new TypeError('p.nullable learn is already set'));
    expect(() => plain.learn().compress()).toThrow(
      new TypeError('p.nullable learn and compress cannot both be set')
    );
    expect(() => plain.compress().learn()).toThrow(
      new TypeError('p.nullable learn and compress cannot both be set')
    );
    expect(() => plain.compress().compress()).toThrow(
      new TypeError('p.nullable compress is already set')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.learn({ window: 0 })).toThrow(
      new RangeError('p.nullable learning window must be a positive integer, got 0')
    );
  });
});

describe('p.nullable compress', () => {
  const plain = p.nullable(p.int().min(0).max(3));
  const weights: [number, number] = [1, 9];
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => (rnd() < 0.7 ? null : Math.floor(rnd() * 4)));
  };

  it('round-trips a run alone, in a plain array and in a compressed object', () => {
    const values = run(200, 1);
    for (const node of [plain.compress(), plain.weights(weights).compress({ window: 8 })]) {
      for (const value of values.slice(0, 20)) expect(trip(node, value)).toBe(value);
      expect(trip(p.array(node), values)).toEqual(values);
    }
    const Row = p.object({ n: plain, flag: p.nullable(p.bool()) });
    const rows = values.map((n, i) => ({ n, flag: i % 3 === 0 ? null : i % 2 === 0 }));
    expect(trip(p.array(Row.compress()), rows)).toEqual(rows);
    expect(trip(p.array(Row).compress(), rows)).toEqual(rows);
  });

  it('names the side of a NULL when its inner node may spell NULL too', () => {
    const rnd = mulberry32(3);
    const values = Array.from({ length: 120 }, () => {
      const r = rnd();
      return r < 0.4 ? null : r < 0.7 ? Math.floor(r * 10) : 'x';
    });
    for (const inner of [p.any(), p.enum([null, 1, 2, 3, 4, 5, 6, 'x'])]) {
      const node = p.nullable(inner);
      expect(trip(p.array(node.compress()), values)).toEqual(values);
      expect(trip(p.array(node).compress(), values)).toEqual(values);
    }
    const union = p.nullable(p.union([p.null(), p.int(), p.string()]));
    expect(trip(p.array(union).compress(), values)).toEqual(values);
  });

  it('names the value side of a NULL its inner node spells for a value of its own', () => {
    // A custom node spelling the empty string with the null symbol.
    class PBlank extends PNode<string> {
      _marker(value: unknown): number {
        return value === '' ? STRUCT.NULL : STRUCT.STR;
      }
      _write(enc: Encoder, value: string): void {
        p.string()._write(enc, value);
      }
      _read(dec: Decoder): string {
        return p.string()._read(dec);
      }
    }
    const values = ['', null, 'a', '', null, null, '', 'b'];
    const node = p.nullable(new PBlank());
    expect(trip(p.array(node.compress()), values)).toEqual(values);
    expect(trip(p.array(node).compress(), values)).toEqual(values);
  });

  it('adapts its inner node unless that one learns or adapts already', () => {
    expect(p.nullable(p.bool()).compress().inner._compress).toEqual({
      prior: loadedPriors.json.source,
    });
    const learning = p.bool().learn();
    expect(p.nullable(learning).compress().inner).toBe(learning);
    const values = [true, null, false, true, null];
    expect(trip(p.array(p.nullable(learning).compress()), values)).toEqual(values);
  });

  it('stays as it is under a compressed parent when it learns', () => {
    const node = plain.learn();
    expect(node._adapted({}, new Map())).toBe(node);
    const Row = p.object({ n: node }).compress();
    expect(trip(Row, { n: 2 })).toEqual({ n: 2 });
    expect(trip(Row, { n: null })).toEqual({ n: null });
  });

  it('takes its weights as prior counts of its symbols', () => {
    const nulls = Array<null>(12).fill(null);
    const size = (w: [number, number], parent: boolean) => {
      const node = plain.weights(w);
      const list = parent
        ? p.array(node).length(12).compress()
        : p.array(node.compress()).length(12);
      return list.encode(nulls, BITS).length;
    };
    expect(size([1, 30], true)).toBeLessThan(size([30, 1], true));
    expect(size([1, 30], false)).toBeLessThanOrEqual(size([30, 1], false));
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).compress({ window: 64 })).encode(values)).toEqual(
      p.array(plain.compress({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.compress({ window: 0 })).toThrow(
      new RangeError('p.nullable: compress window must be at least 1')
    );
    expect(() => plain.compress({ window: 2.5 })).toThrow(
      new TypeError('p.nullable: compress window must be an integer, got 2.5')
    );
  });
});
