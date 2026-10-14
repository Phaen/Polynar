/**
 * `p.enum()`: one member of a fixed list.
 */

import { p } from '../../index';
import { Decoder } from '../../packer';
import { buildWeights, readTable } from '../../nodes/weights';
import { mulberry32, trip } from '../support';

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

describe('p.enum adaptive', () => {
  const plain = p.enum(['a', 'b', 'c', 'd']);
  const weights = [17, 1, 1, 1];
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () =>
      rnd() < 0.85 ? 'a' : (['b', 'c', 'd'] as const)[Math.floor(rnd() * 3)]
    );
  };

  it('round-trips a run of values, inside an array too', () => {
    const values = run(300, 1);
    for (const node of [plain.adaptive(), plain.weights(weights).adaptive({ window: 8 })]) {
      expect(node._radix).toBeUndefined();
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(node, values[0])).toEqual(values[0]);
    }
  });

  it.each([
    ['static', ['a', 'c'], 0],
    ['adaptive', ['a', 'a', 'c'], 2],
  ])('ends a message on its wide last member under the %s coding', (_name, values, coding) => {
    const member = p.enum(['a', 'b', 'c']).weights([1, 1, 30]).adaptive();
    const node = p.array(member).length(values.length);
    const bytes = node.encode(values as never);
    const dec = new Decoder(bytes);
    readTable(dec, buildWeights([1, 1, 30], 3, 'w'));
    // Three rungs: the selector weighs static as all of them together.
    expect(readTable(dec, buildWeights([3, 1, 1, 1], 4, 'w'))).toBe(coding);
    expect(node.decode(bytes)).toEqual(values);
    expect(trip(p.array(member), values as never)).toEqual(values);
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).adaptive({ window: 64 })).encode(values)).toEqual(
      p.array(plain.adaptive({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('learns a skew, at most a byte over the static prior of it', () => {
    const values = run(2000, 3);
    const size = (node: typeof plain) => p.array(node).encode(values).length;
    expect(size(plain.adaptive())).toBeLessThan(size(plain));
    expect(size(plain.weights(weights).adaptive())).toBeLessThanOrEqual(
      size(plain.weights(weights)) + 1
    );
  });

  it('written once, spends the bytes of its static form', () => {
    for (const value of run(20, 4)) {
      expect(plain.adaptive().encode(value)).toEqual(plain.encode(value));
      expect(plain.weights(weights).adaptive().encode(value)).toEqual(
        plain.weights(weights).encode(value)
      );
    }
  });

  it('refuses bad options', () => {
    expect(() => plain.adaptive({ window: 0 })).toThrow(
      new RangeError('p.enum adaptive window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.enum adaptive window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(3).fill(1)]).adaptive()).toThrow(
      new RangeError(
        'p.enum adaptive prior 8 and window 1024 overflow with weights totalling 35184372088835'
      )
    );
    expect(() => plain.adaptive().weights([1])).toThrow(
      new TypeError('p.enum weights must list one weight per value: expected 4, got 1')
    );
  });
});
