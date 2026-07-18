/**
 * Schema enum node (`p.enum()`) — variants from a fixed list of members.
 */

import { p } from '../../index';
import { trip } from '../support';

describe('Schema enum', () => {
  it('enum round-trips a member', () => {
    expect(trip(p.enum(['admin', 'user', 'guest']), 'user')).toBe('user');
  });

  it('enum rejects an empty list at construction', () => {
    expect(() => p.enum([])).toThrow(TypeError);
  });

  it('enum rejects a value not in its list', () => {
    expect(() => p.enum(['a', 'b']).encode('c' as never)).toThrow("'c' not found in list");
  });

  it('enum accepts any primitive literals', () => {
    expect(trip(p.enum([256, 512, 1024]), 512)).toBe(512);
    expect(trip(p.enum([true, false]), false)).toBe(false);
    expect(trip(p.enum(['on', 0.5, false]), 0.5)).toBe(0.5);
  });

  it('enum matches members by identity, so any stable reference works', () => {
    // The wire carries an index into the shared list, so decode hands back
    // the listed member itself: objects and functions included.
    const strategies = [{ retries: 0 }, { retries: 5 }];
    const Strategy = p.enum(strategies);
    expect(trip(Strategy, strategies[1])).toBe(strategies[1]);
    expect(() => Strategy.encode({ retries: 5 })).toThrow('not found in list');

    const Rounding = p.enum([Math.floor, Math.ceil, Math.round]);
    expect(trip(Rounding, Math.ceil)).toBe(Math.ceil);
  });

  it('enum rejects NaN and duplicate members at construction', () => {
    // NaN never equals itself under the === that indexOf uses, so a NaN
    // member could never be encoded; a duplicate is unreachable behind its
    // first occurrence and inflates the radix every value pays for.
    expect(() => p.enum([1, NaN])).toThrow(TypeError);
    expect(() => p.enum(['a', 'a'])).toThrow(TypeError);
    expect(() => p.enum([0, -0])).toThrow(TypeError);
    const shared = { retries: 0 };
    expect(() => p.enum([shared, shared])).toThrow(TypeError);
  });
});
