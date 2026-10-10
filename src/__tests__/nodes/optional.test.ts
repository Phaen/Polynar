/**
 * `p.optional()`: the value or undefined, behind a presence bit.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import { trip } from '../support';

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

  it('rejects a present value whose inner any reads its undefined tag', () => {
    // undefined is spelled by the absent bit alone.
    const present = new Encoder();
    present.compose(1, 2);
    present.compose(0, 9); // TAG_UNDEFINED
    expect(() => p.optional(p.any()).decode(present.output())).toThrow(CorruptInputError);
  });
});
