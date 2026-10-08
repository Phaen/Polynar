/**
 * Schema tagged union node (`p.tagged()`) — object shapes picked by a tag field.
 */

import { p } from '../../index';
import type { Infer, PObject } from '../../index';
import { trip } from '../support';

const Op = p.tagged('type', {
  insert: p.object({ pos: p.int().min(0), text: p.string().max(100) }),
  delete: p.object({ pos: p.int().min(0), len: p.int().min(1).max(1000) }),
  format: p.object({ pos: p.int().min(0), bold: p.bool(), url: p.optional(p.string()) }),
  cursor: p.object({ pos: p.int().min(0) }),
});
type Op = Infer<typeof Op>;

const Two = p.tagged('type', {
  insert: p.object({ pos: p.int().min(0).max(1000), ch: p.int().min(0).max(255) }),
  delete: p.object({ pos: p.int().min(0).max(1000), len: p.int().min(1).max(100) }),
});
type Two = Infer<typeof Two>;
const Delete = p.object({ pos: p.int().min(0).max(1000), len: p.int().min(1).max(100) });

describe('Schema tagged union', () => {
  it('round-trips each member, tag first', () => {
    const ops: Op[] = [
      { type: 'insert', pos: 3, text: 'hi' },
      { type: 'delete', pos: 0, len: 7 },
      { type: 'format', pos: 12, bold: true, url: 'https://x.y' },
      { type: 'format', pos: 12, bold: false },
      { type: 'cursor', pos: 99 },
    ];
    for (const op of ops) {
      const decoded = trip(Op, op);
      expect(decoded).toEqual(op);
      expect(Object.keys(decoded)[0]).toBe('type');
    }
  });

  it('the tag costs log2(members) bits on top of the member', () => {
    const deletes = Array.from({ length: 256 }, (_, i) => ({ pos: i, len: 1 + (i % 100) }));
    const ops: Two[] = deletes.map((d) => ({ type: 'delete', ...d }));
    const tagged = p.array(Two).length(256).encode(ops);
    const bare = p.array(Delete).length(256).encode(deletes);
    expect(tagged.length - bare.length).toBe(32);
  });

  it('a single member costs no tag bits', () => {
    const One = p.tagged('type', { only: p.object({ pos: p.int().min(0).max(1000) }) });
    const Bare = p.object({ pos: p.int().min(0).max(1000) });
    expect(One.encode({ type: 'only', pos: 7 })).toEqual(Bare.encode({ pos: 7 }));
    expect(trip(One, { type: 'only', pos: 7 })).toEqual({ type: 'only', pos: 7 });
  });

  it('weights make the likely member cheaper', () => {
    const Skewed = Two.weights([1, 99]);
    const ops: Two[] = Array.from({ length: 64 }, (_, i) => ({ type: 'delete', pos: i, len: 5 }));
    const uniform = p.array(Two).encode(ops);
    const skewed = p.array(Skewed).encode(ops);
    expect(skewed.length).toBeLessThan(uniform.length);
    expect(p.array(Skewed).decode(skewed)).toEqual(ops);
    expect(trip(Skewed, { type: 'insert', pos: 1, ch: 65 })).toEqual({
      type: 'insert',
      pos: 1,
      ch: 65,
    });
    expect(() => Two.weights([1])).toThrow('p.tagged weights must list one weight per value');
  });

  it('a tag outside the member map names the tag field', () => {
    // A member map assembled at runtime leaves the tag typed as string, so an
    // unknown tag is a value error, not a schema error.
    const members: Record<string, PObject<any>> = {
      a: p.object({ x: p.int() }),
      b: p.object({ y: p.int() }),
    };
    const Dynamic = p.tagged('type', members);
    expect(() => Dynamic.encode({ type: 'c', x: 1 })).toThrow("type: Value 'c' not found in tags");
  });

  it('a field error inside a member names the field, with no extra segment', () => {
    expect(() => Two.encode({ type: 'delete', pos: 1, len: 0 })).toThrow(
      "len: Value '0' exceeds range bounds"
    );
    const ops: Two[] = [
      { type: 'delete', pos: 1, len: 1 },
      { type: 'insert', pos: 1, ch: 1 },
      { type: 'delete', pos: 1, len: 1 },
      { type: 'delete', pos: 1, len: 0 },
    ];
    expect(() => p.array(Two).encode(ops)).toThrow("[3].len: Value '0' exceeds range bounds");
  });

  it('rejects an empty member map and a member that declares the tag key', () => {
    expect(() => p.tagged('type', {})).toThrow('p.tagged requires at least one member');
    expect(() =>
      p.tagged('type', {
        a: p.object({ x: p.int() }),
        b: p.object({ type: p.string(), x: p.int() }),
      })
    ).toThrow("p.tagged member 'b' cannot have a 'type' field; the tag carries it");
  });

  it('is of kind object and composes like one', () => {
    const Nullable = p.union([Op, p.null()]);
    expect(trip(Nullable, null)).toBeNull();
    expect(trip(Nullable, { type: 'cursor', pos: 4 })).toEqual({ type: 'cursor', pos: 4 });
    expect(() => p.union([Op, p.object({})])).toThrow("overlap on kind 'object'");

    const ops: Op[] = [
      { type: 'delete', pos: 0, len: 7 },
      { type: 'insert', pos: 3, text: 'hi' },
      { type: 'cursor', pos: 99 },
    ];
    expect(trip(p.array(Op), ops)).toEqual(ops);

    const Doc = p.object({ id: p.int(), last: p.optional(Op) });
    expect(trip(Doc, { id: 1 })).toEqual({ id: 1 });
    expect(trip(Doc, { id: 1, last: { type: 'cursor', pos: 2 } })).toEqual({
      id: 1,
      last: { type: 'cursor', pos: 2 },
    });
  });

  it('decoded values re-encode to identical bytes', () => {
    const ops: Op[] = [
      { type: 'insert', pos: 3, text: 'hi' },
      { type: 'delete', pos: 0, len: 7 },
      { type: 'format', pos: 12, bold: true, url: 'https://x.y' },
      { type: 'cursor', pos: 99 },
    ];
    for (const op of ops) {
      const bytes = Op.encode(op);
      expect(Op.encode(Op.decode(bytes))).toEqual(bytes);
    }
  });
});
