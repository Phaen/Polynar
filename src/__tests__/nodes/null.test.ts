/**
 * `p.null()`: null, in zero bits.
 */

import { p } from '../../index';
import { STRUCT } from '../../predictor/types';
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

  it('spells null first as the null symbol', () => {
    expect(p.null()._markers()).toEqual(new Set([STRUCT.NULL]));
    expect(p.null()._marker(null)).toBe(STRUCT.NULL);
    const Row = p.object({ n: p.null(), v: p.union([p.null(), p.int()]) }).adaptive();
    expect(trip(Row, { n: null, v: null })).toEqual({ n: null, v: null });
    expect(trip(Row, { n: null, v: 4 })).toEqual({ n: null, v: 4 });
  });
});
