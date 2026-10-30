/**
 * `p.tagged()`: object shapes picked by a tag field.
 */

import { p } from '../../index';
import { loadedPriors } from '../../predictor/prior';
import { STRUCT } from '../../predictor/types';
import type { Infer, PObject } from '../../index';
import { mulberry32, trip } from '../support';

const Op = p.tagged('type', {
  insert: p.object({ pos: p.int().min(0), text: p.string().max(100) }),
  delete: p.object({ pos: p.int().min(0), len: p.int().min(1).max(1000) }),
  format: p.object({ pos: p.int().min(0), bold: p.bool(), url: p.optional(p.string()) }),
  cursor: p.object({ pos: p.int().min(0) }),
});
type Op = Infer<typeof Op>;

const Delete = p.object({ pos: p.int().min(0).max(1000), len: p.int().min(1).max(100) });
const Two = p.tagged('type', {
  insert: p.object({ pos: p.int().min(0).max(1000), ch: p.int().min(0).max(255) }),
  delete: Delete,
});
type Two = Infer<typeof Two>;

describe('Schema tagged', () => {
  it.each<Op>([
    { type: 'insert', pos: 3, text: 'hi' },
    { type: 'format', pos: 12, bold: true, url: 'https://x.y' },
    { type: 'cursor', pos: 99 },
  ])('decodes $type with the tag as the first key', (op) => {
    expect(Object.keys(trip(Op, op))[0]).toBe('type');
  });

  it('spends log2(members) bits on the tag', () => {
    const deletes = Array.from({ length: 256 }, (_, i) => ({ pos: i, len: 1 + (i % 100) }));
    const ops: Two[] = deletes.map((d) => ({ type: 'delete', ...d }));
    const tagged = p.array(Two).length(256).encode(ops);
    const bare = p.array(Delete).length(256).encode(deletes);
    expect(tagged.length - bare.length).toBe(32);
  });

  it('spends no tag bits on a single member', () => {
    const One = p.tagged('type', { only: p.object({ pos: p.int().min(0).max(1000) }) });
    const Bare = p.object({ pos: p.int().min(0).max(1000) });
    expect(One.encode({ type: 'only', pos: 7 })).toEqual(Bare.encode({ pos: 7 }));
    expect(trip(One, { type: 'only', pos: 7 })).toEqual({ type: 'only', pos: 7 });
  });

  it('rejects array-index tags, which JS would reorder', () => {
    expect(() => p.tagged('t', { a: p.object({}), '2': p.object({}) })).toThrow(
      new TypeError(
        'p.tagged tag "2" is an array index, which JS lists before other keys; a non-digit like "v2" keeps the order'
      )
    );
    for (const tag of ['01', '-1', '1.5', '4294967295']) {
      expect(() => p.tagged('t', { a: p.object({}), [tag]: p.object({}) })).not.toThrow();
    }
  });

  it('rejects an empty member map and a member that declares the tag key', () => {
    expect(() => p.tagged('type', {})).toThrow('p.tagged requires at least one member');
    expect(() =>
      p.tagged('type', {
        a: p.object({ x: p.int() }),
        b: p.object({ type: p.string(), x: p.int() }),
      })
    ).toThrow('p.tagged member "b" cannot have a "type" field; the tag carries it');
  });

  it('names the tag field for a tag outside the member map', () => {
    // A member map assembled at runtime leaves the tag typed as string, so an
    // unknown tag is a value error, not a schema error.
    const members: Record<string, PObject<any>> = {
      a: p.object({ x: p.int() }),
      b: p.object({ y: p.int() }),
    };
    expect(() => p.tagged('type', members).encode({ type: 'c', x: 1 })).toThrow(
      new RangeError('type: Value "c" is not one of "a", "b"')
    );
  });

  it('names a field inside a member with no extra path segment', () => {
    expect(() => Two.encode({ type: 'delete', pos: 1, len: 0 })).toThrow(
      'len: Value 0 is below the minimum 1'
    );
    const ops: Two[] = [
      { type: 'delete', pos: 1, len: 1 },
      { type: 'insert', pos: 1, ch: 1 },
      { type: 'delete', pos: 1, len: 0 },
    ];
    expect(() => p.array(Two).encode(ops)).toThrow('[2].len: Value 0 is below the minimum 1');
  });

  it('is of kind object', () => {
    const Nullable = p.union([Op, p.null()]);
    expect(trip(Nullable, null)).toBeNull();
    expect(trip(Nullable, { type: 'cursor', pos: 4 })).toEqual({ type: 'cursor', pos: 4 });
    expect(() => p.union([Op, p.object({})])).toThrow('overlap on kind "object"');
  });
});

describe('p.tagged compress', () => {
  const plain = p.tagged('kind', { a: p.object({}), b: p.object({ n: p.int().min(0).max(3) }) });
  const weights = [9, 1];
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () =>
      rnd() < 0.9 ? { kind: 'a' as const } : { kind: 'b' as const, n: 2 }
    );
  };
  const members = (node: typeof plain) =>
    (node as unknown as { _members: Record<string, PObject<any>> })._members;

  it('round-trips a run of values, alone, in an array and in a compressed object', () => {
    const values = run(300, 1);
    for (const node of [plain.compress(), plain.weights(weights).compress({ window: 8 })]) {
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(p.array(node).compress(), values)).toEqual(values);
      for (const value of values.slice(0, 20)) {
        expect(trip(node, value)).toEqual(value);
        expect(trip(p.object({ op: node }), { op: value })).toEqual({ op: value });
        expect(trip(p.object({ op: plain }).compress(), { op: value })).toEqual({ op: value });
      }
    }
  });

  it('adapts its members, which take their start from the tag', () => {
    const node = plain.compress({ window: 64 });
    expect(node._compress).toEqual({ window: 64, prior: loadedPriors.json.source });
    expect(members(node).a._compress).toEqual({ window: 64, prior: loadedPriors.json.source });
    expect(members(node).b._compress).toEqual({ window: 64, prior: loadedPriors.json.source });
    expect(trip(node, { kind: 'b', n: 3 })).toEqual({ kind: 'b', n: 3 });
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).compress({ window: 64 })).encode(values)).toEqual(
      p.array(plain.compress({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('learns a skew', () => {
    const values = run(2000, 3);
    const size = (node: typeof plain) => {
      expect(trip(p.array(node), values)).toEqual(values);
      return p.array(node).encode(values).length;
    };
    expect(size(plain.compress())).toBeLessThan(size(plain));
    expect(size(plain.learn())).toBeLessThan(size(plain));
    expect(size(plain.learn({ window: 8 }))).toBeLessThan(size(plain));
  });

  it('holds compress where it or a member adapts', () => {
    expect(plain._holdsCompress).toBe(false);
    expect(plain.learn()._holdsCompress).toBe(false);
    expect(plain.compress()._holdsCompress).toBe(true);
    const holding = p.tagged('kind', { a: p.object({ s: p.string().compress() }) });
    expect(holding._holdsCompress).toBe(true);
    expect(trip(holding, { kind: 'a', s: 'x' })).toEqual({ kind: 'a', s: 'x' });
  });

  it('stays as it is under a compressed container when it learns', () => {
    const learned = plain.learn();
    const outer = p.object({ op: learned }).compress();
    const field = (outer as unknown as { _shape: { op: typeof plain } })._shape.op;
    expect(field).toBe(learned);
    expect(trip(outer, { op: { kind: 'b', n: 1 } })).toEqual({ op: { kind: 'b', n: 1 } });
  });

  it('locates a missing tag at its key', () => {
    for (const node of [plain, plain.compress()]) {
      expect(() => node.encode({} as never)).toThrow(
        new TypeError('kind: Required field is missing')
      );
    }
  });

  it('starts every value with the object marker', () => {
    expect(plain._marker()).toBe(STRUCT.OBJ_START);
    expect([...plain._markers()]).toEqual([STRUCT.OBJ_START]);
  });

  it('sets each method once, and not both', () => {
    expect(() => plain.learn().learn()).toThrow(new TypeError('p.tagged learn is already set'));
    expect(() => plain.compress().compress()).toThrow(
      new TypeError('p.tagged compress is already set')
    );
    expect(() => plain.learn().compress()).toThrow(
      new TypeError('p.tagged learn and compress cannot both be set')
    );
    expect(() => plain.compress().learn()).toThrow(
      new TypeError('p.tagged learn and compress cannot both be set')
    );
  });

  it('refuses bad options', () => {
    expect(() => plain.compress({ window: 0 })).toThrow(
      new RangeError('p.tagged: compress window must be at least 1')
    );
    expect(() => plain.compress().weights([1])).toThrow(
      new TypeError('p.tagged weights must list one weight per value: expected 2, got 1')
    );
  });
});
