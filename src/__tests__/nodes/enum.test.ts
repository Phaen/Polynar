/**
 * `p.enum()`: one member of a fixed list.
 */

import { p } from '../../index';
import { trip } from '../support';

describe('Schema enum', () => {
  it('rejects an empty list at construction', () => {
    expect(() => p.enum([])).toThrow(TypeError);
  });

  it('rejects a value not in its list, showing the list when it is short', () => {
    // Lists built at runtime type their members as plain values.
    const letters: string[] = ['a', 'b'];
    expect(() => p.enum(letters).encode('c')).toThrow(
      new RangeError('Value "c" is not one of "a", "b"')
    );
    const many: string[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    expect(() => p.enum(many).encode('z')).toThrow('Value "z" is not one of the 9 listed values');
    const numbers: (number | string)[] = [1, 5];
    expect(() => p.enum(numbers).encode('5')).toThrow(
      new RangeError('Value "5" is not one of 1, 5')
    );
    const bigints: bigint[] = [1n, 2n];
    expect(() => p.enum(bigints).encode(3n)).toThrow('Value 3n is not one of 1n, 2n');
  });

  it('matches members by identity, so any stable reference works', () => {
    // The wire carries an index into the shared list, so decode hands back
    // the listed member itself: objects and functions included.
    const strategies = [{ retries: 0 }, { retries: 5 }];
    const Strategy = p.enum(strategies);
    expect(trip(Strategy, strategies[1])).toBe(strategies[1]);
    expect(() => Strategy.encode({ retries: 5 })).toThrow('is not one of the 2 listed values');

    const Rounding = p.enum([Math.floor, Math.ceil, Math.round]);
    expect(trip(Rounding, Math.ceil)).toBe(Math.ceil);
  });

  it('rejects NaN and duplicate members at construction', () => {
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
