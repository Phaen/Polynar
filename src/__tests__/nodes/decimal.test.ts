/**
 * `p.decimal()`: values on a fixed decimal step.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import { trip } from '../support';

describe('Schema decimal', () => {
  it.each([0, 0.07, 0.29, 3.14, 99.99, 100])(
    'round-trips %p in cents bit-exact, float traps included',
    (value) => {
      // 0.29 / 0.01 = 28.999... under raw float division; the scaled-integer
      // path returns the value itself, not a close neighbour.
      expect(trip(p.decimal(0.01).min(0).max(100), value)).toBe(value);
    }
  );

  it('spends only what the step and bounds allow', () => {
    // 0..100 in cents is 10001 states: 2 bytes, where p.float's per-value
    // fraction search, blind to the bounds, spends 4 on 3.14.
    expect(p.decimal(0.01).min(0).max(100).encode(3.14)).toHaveLength(2);
  });

  it('rejects off-grid values instead of snapping', () => {
    expect(() => p.decimal(0.01).encode(0.005)).toThrow('not a multiple of step');
    expect(() => p.decimal(0.01).encode(0.123)).toThrow('not a multiple of step');
    expect(() => p.decimal(0.1).encode(0.35)).toThrow('not a multiple of step');
  });

  it('names the bound a value breaks', () => {
    expect(() => p.decimal(0.01).min(0).max(100).encode(100.01)).toThrow(
      new RangeError('Value 100.01 is above the maximum 100')
    );
    const node = p.decimal(0.5).min(0.5).max(2);
    expect(trip(node, 0.5)).toBe(0.5);
    expect(trip(node, 2)).toBe(2);
    expect(() => node.encode(0)).toThrow(new RangeError('Value 0 is below the minimum 0.5'));
    expect(() => node.encode(2.5)).toThrow(new RangeError('Value 2.5 is above the maximum 2'));
  });

  it('puts bounds on the step like values', () => {
    expect(() => p.decimal(0.5).min(0.3)).toThrow(
      new RangeError('p.decimal min 0.3 is not a multiple of step 0.5')
    );
    expect(() => p.decimal(0.5).max(2.2)).toThrow(
      new RangeError('p.decimal max 2.2 is not a multiple of step 0.5')
    );
    // A bound finer than the step is off it too.
    expect(() => p.decimal(1).min(1e-7)).toThrow(
      new RangeError('p.decimal min 1e-7 is not a multiple of step 1')
    );
    expect(() => p.decimal(0.1).max(1 / 3)).toThrow(RangeError);
    expect(() => p.decimal(0.1).min(NaN)).toThrow(
      new TypeError('p.decimal min must be a finite number, got NaN')
    );
    expect(() => p.decimal(0.1).max(Infinity)).toThrow(
      new TypeError('p.decimal max must be a finite number, got Infinity')
    );
    expect(trip(p.decimal(0.1).min(-0.3).max(0.3), -0.3)).toBe(-0.3);
  });

  it('rejects invalid steps at construction', () => {
    expect(() => p.decimal(0)).toThrow(
      new TypeError('p.decimal step must be a positive finite number, got 0')
    );
    expect(() => p.decimal(-0.1)).toThrow(TypeError);
    expect(() => p.decimal(Infinity)).toThrow(TypeError);
    // 1/3 has no finite decimal form, so no value could ever sit on its grid.
    expect(() => p.decimal(1 / 3)).toThrow(TypeError);
  });

  it('refuses bounds and values outside exact arithmetic', () => {
    expect(() => p.decimal(0.01).max(1e20)).toThrow(
      'p.decimal max 100000000000000000000 is outside the exact range ±90071992547409.9'
    );
    expect(() => p.decimal(0.01).min(-1e20)).toThrow('p.decimal min -100000000000000000000');
    expect(() => p.decimal(1).encode(1e20)).toThrow(
      'Value 100000000000000000000 is outside the exact range ±9007199254740991'
    );
    expect(() => p.decimal(1).encode(NaN)).toThrow('p.decimal expected a finite number');
  });

  it('rejects a step multiple that cannot reconstruct exactly', () => {
    // The multiple is a valid term, but scaled by the step it rounds past
    // 2^53, so dividing it back out would decode a neighbouring value.
    const enc = new Encoder();
    enc.compose(0, 2);
    enc.composeTerm(2 ** 60);
    expect(() => p.decimal(0.01).decode(enc.output())).toThrow(CorruptInputError);
  });
});
