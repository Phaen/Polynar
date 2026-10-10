/**
 * `p.tagged()`: object shapes picked by a tag field.
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

  it('rejects numeric tags, which JS would reorder', () => {
    expect(() => p.tagged('t', { a: p.object({}), '2': p.object({}) })).toThrow(
      'p.tagged tag "2" is a number'
    );
    expect(() => p.tagged('t', { v01: p.object({}), '01': p.object({}) })).not.toThrow();
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
