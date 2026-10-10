/**
 * `p.nullable()`: the value or null.
 */

import { p, Encoder, CorruptInputError, type PNode } from '../../index';
import { trip } from '../support';

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

  it('rejects a value side holding the inner node null', () => {
    // An inner `any`'s own null tag is a second spelling of null.
    const enc = new Encoder();
    enc.compose(0, 2);
    p.any()._write(enc, null);
    expect(() => p.nullable(p.any()).decode(enc.output())).toThrow(CorruptInputError);
  });
});
