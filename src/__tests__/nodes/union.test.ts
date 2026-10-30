/**
 * `p.union()`: one member per JS kind, picked by the value's kind.
 */

import { p, PNode, Encoder, Decoder, CorruptInputError } from '../../index';
import { STRUCT } from '../../predictor/types';
import { mulberry32, trip } from '../support';

/** Text of one bit per digit, so a size counts bits. */
const BITS = { type: 'text', charset: '01' } as const;

describe('Schema union', () => {
  it('routes a value to the member that owns its kind', () => {
    const Node = p.union([p.enum(['a', 'b']), p.int(), p.date()]);
    expect(trip(Node, 'a')).toBe('a');
    expect(trip(Node, 3)).toBe(3);
    expect(trip(Node, new Date(0))).toEqual(new Date(0));
    expect(() => p.union([p.enum(['a', 1]), p.int()])).toThrow('overlap on kind "number"');
  });

  it('gives bigints, regular expressions and buffers kinds of their own', () => {
    const pattern = /a/g;
    const Node = p.union([p.enum([1n, 2n]), p.enum([pattern]), p.object({})]);
    expect(trip(Node, 2n)).toBe(2n);
    expect(trip(Node, pattern)).toBe(pattern);
    expect(() => Node.encode(/b/ as never)).toThrow(RangeError);
    expect(() => Node.encode(new ArrayBuffer(1) as never)).toThrow('Kind "ArrayBuffer" is not');
    expect(() => p.union([p.any(), p.enum([1n])])).toThrow('overlap on kind "bigint"');
    expect(() => p.union([p.any(), p.enum([pattern])])).toThrow('overlap on kind "regexp"');
  });

  it('tells Maps and Sets from objects and arrays', () => {
    const Node = p.union([
      p.map(p.string(), p.int()),
      p.set(p.int()),
      p.record(p.bool()),
      p.array(p.int()),
    ]);
    const map = new Map([['a', 1]]);
    expect(trip(Node, map)).toEqual(map);
    expect(trip(Node, new Set([1, 2]))).toEqual(new Set([1, 2]));
    expect(trip(Node, { a: true })).toEqual({ a: true });
    expect(trip(Node, [3])).toEqual([3]);
    expect(() => p.union([p.set(p.int()), p.set(p.string())])).toThrow('overlap on kind "set"');
    expect(() => p.union([p.any(), p.map(p.int(), p.int())])).toThrow('overlap on kind "map"');
  });

  it('rejects members that claim the same kind', () => {
    expect(() => p.union([p.array(p.int()), p.array(p.string())])).toThrow(
      'overlap on kind "array"'
    );
    expect(() => p.union([p.object({ a: p.int() }), p.object({ b: p.int() })])).toThrow(
      'overlap on kind "object"'
    );
    expect(() => p.union([p.int(), p.float()])).toThrow('overlap on kind "number"');
    expect(() => p.union([p.any(), p.string()])).toThrow('overlap on kind');
    expect(() => p.union([p.any(), p.binary(Int16Array)])).toThrow('overlap on kind "Int16Array"');
  });

  it('takes p.any as its only member', () => {
    const Loose = p.union([p.any()]);
    expect(trip(Loose, [1, 'a'])).toEqual([1, 'a']);
    expect(trip(Loose, Uint8Array.of(9))).toEqual(Uint8Array.of(9));
  });

  it('rejects a value whose kind no member declares', () => {
    // The member's type admits numbers, but its kinds claim only strings.
    class PLabel extends PNode<string | number> {
      readonly _kinds = ['string'];
      _write(enc: Encoder, value: string | number): void {
        p.string()._write(enc, String(value));
      }
      _read(dec: Decoder): string {
        return p.string()._read(dec);
      }
    }
    const Label = p.union([new PLabel()]);
    expect(() => Label._write(new Encoder(), 1)).toThrow(
      new TypeError('Kind "number" is not one of "string"')
    );
  });

  it('rejects an empty list and members without declared kinds', () => {
    expect(() => p.union([])).toThrow('at least one member');
    class PBit extends PNode<number> {
      _write(enc: Encoder, value: number): void {
        enc.compose(value, 2);
      }
      _read(dec: Decoder): number {
        return dec.parse(2);
      }
    }
    expect(() => p.union([new PBit(), p.string()])).toThrow('must declare their kinds');
  });

  it('nests, with overlap detected across nesting', () => {
    const Nested = p.union([p.union([p.string(), p.null()]), p.int()]);
    expect(trip(Nested, null)).toBeNull();
    expect(trip(Nested, 'x')).toBe('x');
    expect(trip(Nested, 7)).toBe(7);
    expect(() => p.union([p.union([p.string(), p.int()]), p.float()])).toThrow('overlap');
  });

  it('gives undefined to an optional member', () => {
    const Maybe = p.union([p.optional(p.string()), p.int()]);
    expect(trip(Maybe, undefined)).toBeUndefined();
    expect(trip(Maybe, 'x')).toBe('x');
    // p.any already claims undefined, so a second optional member overlaps.
    expect(() => p.union([p.optional(p.int()), p.optional(p.any())])).toThrow(
      'overlap on kind "undefined"'
    );
  });
});

/** A string member that declares no structure symbols, so it may spell any first. */
class PLoose extends PNode<string> {
  readonly _kinds = ['string'];
  _write(enc: Encoder, value: string): void {
    p.string()._write(enc, value);
  }
  _read(dec: Decoder): string {
    return p.string()._read(dec);
  }
}

/** A number member that declares no structure symbols either. */
class PLooseInt extends PNode<number> {
  readonly _kinds = ['number'];
  _write(enc: Encoder, value: number): void {
    p.int()._write(enc, value);
  }
  _read(dec: Decoder): number {
    return p.int()._read(dec);
  }
}

describe('p.union structure symbols', () => {
  it('spells a value as the member that takes its kind, by kind when none does', () => {
    const node = p.union([p.int(), p.bool(), p.string()]);
    expect([node._marker(5), node._marker(false), node._marker('x')]).toEqual([
      STRUCT.INT,
      STRUCT.FALSE,
      STRUCT.STR,
    ]);
    expect(node._marker(null)).toBe(STRUCT.NULL);
    expect(node._marker([])).toBe(STRUCT.ARR_START);
    expect(node._markers()).toEqual(new Set([STRUCT.INT, STRUCT.TRUE, STRUCT.FALSE, STRUCT.STR]));
    expect(p.union([p.int(), new PLoose()])._markers()).toBeUndefined();
    expect(node._markerPrior()).toBeUndefined();
  });

  it('weighs each member over the symbols it spells first', () => {
    expect(p.union([p.int(), p.bool()]).weights([2, 2]).compress()._markerPrior()?.counts).toEqual([
      [STRUCT.INT, 24],
      [STRUCT.TRUE, 12],
      [STRUCT.FALSE, 12],
    ]);
  });

  it('holds compress coding when it or a member codes compressed', () => {
    expect(p.union([p.int(), p.bool()])._holdsCompress).toBe(false);
    expect(p.union([p.int(), p.bool().compress()])._holdsCompress).toBe(true);
    expect(p.union([p.int(), p.bool()]).compress()._holdsCompress).toBe(true);
  });
});

describe('p.union learn', () => {
  const plain = p.union([p.int().min(0).max(3), p.string().max(3)]);
  const values = (() => {
    const rnd = mulberry32(5);
    return Array.from({ length: 300 }, () => (rnd() < 0.9 ? Math.floor(rnd() * 4) : 'x'));
  })();

  it('round-trips a run, learning the skew under its options', () => {
    for (const node of [plain.learn(), plain.learn({ window: 8 }), plain.weights([9, 1]).learn()]) {
      expect(trip(p.array(node), values)).toEqual(values);
    }
    expect(p.array(plain.learn()).encode(values)).not.toEqual(p.array(plain).encode(values));
  });

  it('sets each method once, and not both', () => {
    expect(() => plain.learn().learn()).toThrow(new TypeError('p.union learn is already set'));
    expect(() => plain.learn().compress()).toThrow(
      new TypeError('p.union learn and compress cannot both be set')
    );
    expect(() => plain.compress().learn()).toThrow(
      new TypeError('p.union learn and compress cannot both be set')
    );
    expect(() => plain.compress().compress()).toThrow(
      new TypeError('p.union compress is already set')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.learn({ window: 0 })).toThrow(
      new RangeError('p.union learning window must be a positive integer, got 0')
    );
  });
});

describe('p.union compress', () => {
  const plain = p.union([p.int().min(0).max(3), p.string().max(3), p.bool()]);
  const weights = [9, 1, 1];
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => {
      const r = rnd();
      return r < 0.7 ? Math.floor(r * 5) : r < 0.85 ? 'x' : r < 0.95;
    });
  };

  it('round-trips a run alone, in a plain array and in a compressed object', () => {
    const values = run(200, 1);
    for (const node of [plain.compress(), plain.weights(weights).compress({ window: 8 })]) {
      for (const value of values.slice(0, 20)) expect(trip(node, value)).toBe(value);
      expect(trip(p.array(node), values)).toEqual(values);
    }
    const Row = p.object({ v: plain, w: p.union([p.null(), p.date()]) });
    const rows = values.map((v, i) => ({ v, w: i % 3 === 0 ? null : new Date(i * 1000) }));
    expect(trip(p.array(Row.compress()), rows)).toEqual(rows);
    expect(trip(p.array(Row).compress(), rows)).toEqual(rows);
  });

  it('names the member among those that may spell the same symbol', () => {
    const rnd = mulberry32(7);
    const values = Array.from({ length: 150 }, () => (rnd() < 0.6 ? 'ab' : Math.floor(rnd() * 50)));
    const loose = p.union([new PLoose(), new PLooseInt()]);
    for (const node of [loose.compress(), loose.weights([3, 1]).compress()]) {
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(p.array(node).compress(), values)).toEqual(values);
      expect(trip(node, 'ab')).toBe('ab');
    }
  });

  it('refuses a structure symbol no member spells on decode', () => {
    const written = p.union([p.int(), p.string()]).compress().encode(5);
    const reader = p.union([p.string(), p.bool()]).compress();
    expect(() => reader.decode(written)).toThrow(
      new CorruptInputError(`p.union has no member for structure symbol ${STRUCT.INT}`)
    );
  });

  it('adapts its members unless they learn or adapt already', () => {
    const learning = p.bool().learn();
    const node = p.union([p.int(), learning]).compress();
    const values = [1, true, 2, false, true];
    expect(trip(p.array(node), values)).toEqual(values);
    const kept = p.union([p.int(), p.bool()]).learn();
    expect(kept._adapted({}, new Map())).toBe(kept);
    expect(trip(p.object({ v: kept }).compress(), { v: true })).toEqual({ v: true });
  });

  it('takes its weights as prior counts of its members’ symbols', () => {
    const ints = Array<number>(12).fill(1);
    const size = (w: number[], parent: boolean) => {
      const node = p.union([p.int().min(0).max(3), p.string()]).weights(w);
      const list = parent
        ? p.array(node).length(12).compress()
        : p.array(node.compress()).length(12);
      return list.encode(ints, BITS).length;
    };
    for (const parent of [false, true]) {
      expect(size([30, 1], parent)).toBeLessThan(size([1, 30], parent));
    }
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).compress({ window: 64 })).encode(values)).toEqual(
      p.array(plain.compress({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.compress({ window: 0 })).toThrow(
      new RangeError('p.union: compress window must be at least 1')
    );
    expect(() => plain.compress().weights([1])).toThrow(
      new TypeError('p.union weights must list one weight per value: expected 3, got 1')
    );
  });
});
