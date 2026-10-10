/**
 * `p.null()`: null, in zero bits.
 */

import { p } from '../../index';
import { trip } from '../support';

describe('Schema null', () => {
  it('spends no bits', () => {
    expect(p.null().encode(null)).toHaveLength(0);
    expect(trip(p.null(), null)).toBeNull();
  });

  it('owns the null kind as a union member', () => {
    const Nullable = p.union([p.string(), p.null()]);
    expect(trip(Nullable, null)).toBeNull();
    expect(trip(Nullable, 'x')).toBe('x');
    expect(() => p.union([p.null(), p.nullable(p.int())])).toThrow('overlap on kind "null"');
  });
});
