/**
 * `p.int()`: integers, bounded or not.
 */

import { p, Encoder, CorruptInputError } from '../../index';
import { STATIC_MAGNITUDE, classOf } from '../../nodes/magnitude';
import { mulberry32, trip } from '../support';

describe('Schema int', () => {
  it.each([
    [p.int(), 5.5],
    [p.int().min(0).max(100), -3.7],
    [p.int(), NaN],
  ])('rejects %p, which is not an integer, instead of truncating', (node, value) => {
    expect(() => node.encode(value)).toThrow(
      new TypeError(`p.int expected an integer, got ${value}`)
    );
  });

  it.each([
    ['min', () => p.int().min(0.5), 0.5],
    ['max', () => p.int().max(9.2), 9.2],
    ['min', () => p.int().min(-Infinity), -Infinity],
    ['max', () => p.int().max(NaN), NaN],
  ])('rejects a %s bound that is not an integer', (bound, thunk, n) => {
    expect(thunk).toThrow(new TypeError(`p.int ${bound} must be an integer, got ${n}`));
  });

  it.each([
    ['unbounded', p.int()],
    ['min-only', p.int().min(-5)],
    ['max-only', p.int().max(5)],
    ['max of -0', p.int().max(-0)],
    ['bounded', p.int().min(-5).max(5)],
    ['weighted', p.int().min(-1).max(1).weights([1, 2, 3])],
  ])('encodes -0 as plain zero, %s', (_name, node) => {
    expect(node.encode(-0)).toEqual(node.encode(0));
    expect(Object.is(node.decode(node.encode(-0)), 0)).toBe(true);
  });

  it('names the bound a value breaks', () => {
    const node = p.int().min(3).max(9);
    expect(trip(node, 3)).toBe(3);
    expect(trip(node, 9)).toBe(9);
    expect(() => node.encode(2)).toThrow(new RangeError('Value 2 is below the minimum 3'));
    expect(() => node.encode(10)).toThrow(new RangeError('Value 10 is above the maximum 9'));
  });

  it('maps a digit only with both bounds and no prior', () => {
    expect(p.int().min(-5).max(5)._fromDigit?.(10)).toBe(5);
    expect(p.int()._fromDigit).toBeUndefined();
    expect(p.int().min(0)._fromDigit).toBeUndefined();
    expect(p.int().min(0).max(1).weights([1, 2])._fromDigit).toBeUndefined();
  });

  it('maps a value to its digit only with both bounds and no prior, throwing as a write does', () => {
    const node = p.int().min(-5).max(5);
    expect(node._toDigit?.(-5)).toBe(0);
    expect(node._toDigit?.(5)).toBe(10);
    expect(() => node._toDigit?.(1.5)).toThrow(new TypeError('p.int expected an integer, got 1.5'));
    expect(() => node._toDigit?.(6)).toThrow(new RangeError('Value 6 is above the maximum 5'));
    expect(() => node._toDigit?.(-6)).toThrow(new RangeError('Value -6 is below the minimum -5'));
    expect(p.int()._toDigit).toBeUndefined();
    expect(p.int().min(0)._toDigit).toBeUndefined();
    expect(p.int().min(0).max(1).weights([1, 2])._toDigit).toBeUndefined();
  });
});

describe('p.int adaptive', () => {
  const plain = p.int().min(0).max(15);
  const weights = Array.from({ length: 16 }, (_, i) => (i === 3 ? 61 : 1));
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => (rnd() < 0.8 ? 3 : Math.floor(rnd() * 16)));
  };

  it('round-trips a run of values, inside an array too', () => {
    const values = run(300, 1);
    for (const node of [plain.adaptive(), plain.weights(weights).adaptive({ window: 16 })]) {
      expect(node._radix).toBeUndefined();
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(node, values[0])).toEqual(values[0]);
    }
  });

  it('takes its weights before or after', () => {
    const values = run(200, 2);
    expect(p.array(plain.weights(weights).adaptive({ window: 64 })).encode(values)).toEqual(
      p.array(plain.adaptive({ window: 64 }).weights(weights)).encode(values)
    );
  });

  it('learns a skew, its mode symbols at most a twentieth over the static prior of it', () => {
    const values = run(2000, 3);
    const size = (node: typeof plain) => p.array(node).encode(values).length;
    expect(size(plain.adaptive())).toBeLessThan(size(plain));
    expect(size(plain.weights(weights).adaptive())).toBeLessThanOrEqual(
      Math.ceil(size(plain.weights(weights)) * 1.05)
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
      new RangeError('p.int adaptive window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.int adaptive window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(15).fill(1)]).adaptive()).toThrow(
      new RangeError(
        'p.int adaptive prior 32 and window 1024 overflow with weights totalling 35184372088847'
      )
    );
    const cdf = new TypeError('p.int adaptive takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).adaptive()).toThrow(cdf);
    expect(() => plain.adaptive().cdf((v) => v)).toThrow(cdf);
  });
});

describe('p.int delta', () => {
  const ids = Array.from({ length: 100 }, (_, i) => i + 1);

  it('spells each id after the first as its difference, over the classes the bounds reach', () => {
    const node = p.array(p.int().min(1).max(100).delta()).length(100);
    const model = new Encoder();
    model.compose(0, 100);
    let bits = Math.log2(100);
    for (let i = 1; i < ids.length; i++) {
      STATIC_MAGNITUDE.write(model, ids[i], ids[i - 1], 1, 100);
      bits += Math.log2(1 + classOf(100 - ids[i - 1]) + classOf(ids[i - 1] - 1));
    }
    const bytes = node.encode(ids);
    expect(bytes).toEqual(model.output());
    expect(bytes.length).toBeLessThanOrEqual(Math.ceil(bits / 8) + 1);
    expect(node.decode(bytes)).toEqual(ids);
  });

  it('costs an unbounded id about log2(107) bits after the first', () => {
    const bytes = p.array(p.int().delta()).length(100).encode(ids);
    const first = p.int().encode(1).length;
    expect(bytes.length).toBeLessThanOrEqual(first + Math.ceil((99 * Math.log2(107)) / 8) + 1);
  });

  it('round-trips random sequences, bounded or not, adaptive or not', () => {
    const random = mulberry32(9);
    for (const node of [
      p.int().delta(),
      p.int().min(-10).delta(),
      p.int().max(10).delta(),
      p.int().min(-10).max(1000).delta(),
      p.int().min(-10).max(1000).delta().adaptive(),
      p.int().delta().adaptive({ window: 64 }),
      p.int().adaptive(),
    ]) {
      let at = 0;
      const values = Array.from({ length: 300 }, () => {
        at = Math.min(10, at + Math.floor(random() * 21) - 12);
        return Math.max(-10, at);
      });
      expect(trip(p.array(node), values)).toEqual(values);
    }
  });

  it('writes a value alone as its plain spelling', () => {
    for (const value of [-5, 0, 7, 99]) {
      expect(p.int().min(-5).max(99).delta().encode(value)).toEqual(
        p.int().min(-5).max(99).encode(value)
      );
      expect(p.int().delta().encode(value)).toEqual(p.int().encode(value));
    }
  });

  it('is set once, survives every rebuild, and takes no weights or cdf', () => {
    expect(() => p.int().delta().delta()).toThrow(new TypeError('p.int delta is already set'));
    const values = [3, 4, 6, 5];
    const declared = p.array(p.int().min(0).max(9).delta());
    for (const node of [
      p.int().delta().min(0).max(9),
      p.int().max(9).delta().min(0),
      p.int().min(0).delta().max(9),
    ]) {
      expect(p.array(node).encode(values)).toEqual(declared.encode(values));
    }
    expect(p.int().delta().adaptive().min(0)._radix).toBeUndefined();
    const weights = new TypeError('p.int delta takes no weights');
    expect(() => p.int().min(0).max(1).weights([1, 1]).delta()).toThrow(weights);
    expect(() => p.int().min(0).max(1).delta().weights([1, 1])).toThrow(weights);
    expect(() =>
      p
        .int()
        .min(0)
        .max(1)
        .delta()
        .cdf((v) => v)
    ).toThrow(new TypeError('p.int delta takes no cdf'));
  });

  it('refuses a value out of exact reach of its origin', () => {
    expect(() =>
      p
        .int()
        .delta()
        .encode(2 ** 60)
    ).toThrow(new RangeError(`Value ${2 ** 60} is too far from 0 to encode exactly`));
  });

  it('reads a cut message as corrupt', () => {
    const bytes = p.array(p.int().delta()).length(3).encode([5, 600000, 1]);
    expect(() =>
      p
        .array(p.int().delta())
        .length(3)
        .decode(bytes.subarray(0, bytes.length - 2))
    ).toThrow(CorruptInputError);
  });

  it('drops digit mapping', () => {
    expect(p.int().min(0).max(9).delta()._radix).toBeUndefined();
    expect(p.int().min(0).max(9).delta()._fromDigit).toBeUndefined();
    expect(p.int().min(0).max(9).recall()._toDigit).toBeUndefined();
  });
});

describe('p.int adaptive methods', () => {
  it('learns ids as differences on any range', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
    for (const node of [p.int(), p.int().min(1), p.int().min(1).max(65535), p.int().max(2000)]) {
      const learned = p.array(node.adaptive()).encode(ids).length;
      expect(learned).toBeLessThan(p.array(node.delta()).encode(ids).length);
      expect(learned).toBeLessThan(40);
      expect(trip(p.array(node.adaptive()), ids)).toEqual(ids);
    }
  });

  it('spells a narrow range as before up to the mode, which a value alone never spends', () => {
    const node = p.int().min(0).max(15);
    for (const value of [0, 9, 15]) {
      expect(node.adaptive().encode(value)).toEqual(node.encode(value));
    }
  });

  it('spells unbounded values on the learned magnitude scale', () => {
    const values = [0, -3, 2 ** 40, -(2 ** 52), 17];
    expect(trip(p.array(p.int().adaptive()), values)).toEqual(values);
    expect(
      trip(
        p.array(
          p
            .int()
            .min(-(2 ** 60))
            .max(-(2 ** 60) + 2 ** 30)
            .adaptive()
        ),
        [-(2 ** 60)]
      )
    ).toEqual([-(2 ** 60)]);
    expect(() =>
      p
        .int()
        .adaptive()
        .encode(2 ** 53)
    ).toThrow(new RangeError(`Value ${2 ** 53} is too far from 0 to encode exactly`));
  });
});

describe('p.int recall', () => {
  it('spells a repeat by its place among the values seen', () => {
    const node = p.array(p.int().min(0).max(999).recall()).length(4);
    const model = new Encoder();
    model.compose(500, 1000);
    model.compose(0, 2);
    model.compose(7, 1000);
    model.compose(1, 3);
    model.compose(2, 3);
    const bytes = node.encode([500, 7, 500, 7]);
    expect(bytes).toEqual(model.output());
    expect(node.decode(bytes)).toEqual([500, 7, 500, 7]);
  });

  it('round-trips with delta and adaptive, a value alone costing its plain spelling', () => {
    const random = mulberry32(12);
    const values = Array.from(
      { length: 400 },
      () => [5, 900, 12345, -40][Math.floor(random() * 4)]
    );
    for (const node of [
      p.int().recall(),
      p.int().recall().delta(),
      p.int().recall().adaptive(),
      p.int().min(-50).max(20000).adaptive().recall().delta(),
    ]) {
      expect(trip(p.array(node), values)).toEqual(values);
      expect(trip(node, 12345)).toBe(12345);
    }
    expect(p.int().recall().encode(12345)).toEqual(p.int().encode(12345));
    expect(p.array(p.int().recall()).encode(values).length).toBeLessThan(
      p.array(p.int()).encode(values).length
    );
    expect(() => p.int().recall().recall()).toThrow(new TypeError('p.int recall is already set'));
  });
});
