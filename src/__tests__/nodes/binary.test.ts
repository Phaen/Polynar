/**
 * `p.binary()`: typed arrays as raw bits.
 */

import { p, CorruptInputError } from '../../index';
import type { PBinary } from '../../nodes/binary';
import { mulberry32, trip } from '../support';

const rand = mulberry32(0xb1a5);

describe('Schema binary', () => {
  it('decodes to a fresh array', () => {
    const value = new Uint8Array([0, 1, 127, 128, 255]);
    const decoded = trip(p.binary(), value);
    expect(decoded).toEqual(value);
    expect(decoded).not.toBe(value);
  });

  it('spends exactly its bytes at a fixed length', () => {
    const hash = p.binary().length(32);
    const value = Uint8Array.from({ length: 32 }, (_, i) => (i * 37) % 256);
    expect(hash.encode(value)).toHaveLength(32);
    expect(trip(hash, value)).toEqual(value);
  });

  it('names the bound a length breaks', () => {
    const node = p.binary().min(2).max(4);
    expect(() => node.encode(new Uint8Array(1))).toThrow(
      new RangeError('Binary length 1 is below the minimum 2')
    );
    expect(() => node.encode(new Uint8Array(5))).toThrow('Binary length 5 is above the maximum 4');
  });

  it('takes a prior on the length, under a max', () => {
    const node = p.binary().max(8).weights([1, 1, 1, 1, 100, 1, 1, 1, 1]);
    const four = new Uint8Array([1, 2, 3, 4]);
    expect(trip(node, four)).toEqual(four);
    const list = (n: typeof node) => p.array(n).length(8).encode(Array(8).fill(four)).length;
    expect(list(node)).toBeLessThan(list(p.binary().max(8)));
    expect(() => p.binary().weights([1])).toThrow(
      new TypeError('p.binary weights requires a max length')
    );
    expect(() => p.binary().cdf((n) => n)).toThrow('p.binary cdf requires a max length');
  });

  it('accepts a Uint8Array subclass and decodes a plain one', () => {
    class Tagged extends Uint8Array {}
    const decoded = trip(p.binary(), new Tagged([1, 2]));
    expect(Object.getPrototypeOf(decoded)).toBe(Uint8Array.prototype);
    expect(decoded).toEqual(new Uint8Array([1, 2]));
  });

  it('round-trips typed arrays at their own width', () => {
    const floats = Float32Array.of(1.5, -2);
    expect(trip(p.binary(Float32Array), floats)).toEqual(floats);
    const wide = BigInt64Array.of(-(2n ** 63n), 0n, 2n ** 63n - 1n);
    expect(trip(p.binary(BigInt64Array), wide)).toEqual(wide);
  });

  it('reads only its own slice of a shared buffer', () => {
    const buffer = Int16Array.of(9, 1, 2, 9).buffer;
    const view = new Int16Array(buffer, 2, 2);
    expect(trip(p.binary(Int16Array), view)).toEqual(Int16Array.of(1, 2));
  });

  it('is its own kind in a union, one per typed-array class, subclasses included', () => {
    const node = p.union([p.binary(), p.object({ a: p.int() }), p.null()]);
    expect(trip(node, new Uint8Array([7]))).toEqual(new Uint8Array([7]));
    expect(trip(node, { a: 1 })).toEqual({ a: 1 });
    expect(() => p.union([p.binary(), p.binary().max(4)])).toThrow('overlap on kind "Uint8Array"');

    class Samples extends Int16Array {}
    const widths = p.union([p.binary(), p.binary(Int16Array)]);
    expect(trip(widths, Uint8Array.of(7))).toEqual(Uint8Array.of(7));
    expect(trip(widths, Int16Array.of(-7))).toEqual(Int16Array.of(-7));
    expect(trip(widths, new Samples([3]))).toEqual(Int16Array.of(3));
    expect(() => p.union([p.binary(Int16Array), p.binary(Samples)])).toThrow(
      'overlap on kind "Int16Array"'
    );
  });

  it('round-trips long runs at every element width', () => {
    const bytes = Uint8Array.from({ length: 65536 }, () => Math.floor(rand() * 256));
    const shorts = new Int16Array(bytes.buffer.slice(0, 2000));
    expect(trip(p.binary(Int16Array), shorts)).toEqual(shorts);
    const doubles = new Float64Array(bytes.buffer.slice(0, 8000));
    expect(trip(p.binary(Float64Array), doubles)).toEqual(doubles);
    const longs = new BigInt64Array(bytes.buffer.slice(0, 8000));
    expect(trip(p.binary(BigInt64Array), longs)).toEqual(longs);
    expect(trip(p.binary(), bytes)).toEqual(bytes);
  });

  it('learns the bytes of every adaptive binary together, whatever the element type', () => {
    const bytes = Uint8Array.from({ length: 96 }, () => Math.floor(rand() * 256));
    const value = { a: bytes, b: new Uint16Array(bytes.buffer.slice(0)) };
    const node = (separate: boolean) =>
      p.object({
        a: p.binary().adaptive({ separate }),
        b: p.binary(Uint16Array).adaptive({ separate }),
      });
    expect(trip(node(false), value)).toEqual(value);
    expect(node(false).encode(value).length).toBeLessThan(node(true).encode(value).length - 64);
  });

  it('rejects a length whose byte size no buffer holds', () => {
    // From 2^50 elements on the byte count leaves the safe integers, and at
    // 2^1021 it is Infinity.
    for (const length of [2 ** 1021, 2 ** 50]) {
      const claim = p.int().min(0).encode(length);
      expect(() => p.binary(Float64Array).decode(claim)).toThrow(
        new CorruptInputError(`Binary length ${length} is above the largest possible buffer`)
      );
    }
  });

  it('writes the same bytes on a machine that stores the high byte first', async () => {
    // The library is loaded a second time with Uint16Array reporting the
    // high byte first, so that copy takes the big-endian path. An element of
    // 0x1234 sits in such a machine's memory as the bytes 12 34.
    const real = Uint16Array;
    let bigEndian!: typeof import('../../index');
    await jest.isolateModulesAsync(async () => {
      globalThis.Uint16Array = class extends real {
        static of(...items: number[]): Uint16Array<ArrayBuffer> {
          return new real(items.map((n) => ((n & 0xff) << 8) | (n >> 8)));
        }
      } as typeof Uint16Array;
      try {
        bigEndian = await import('../../index');
      } finally {
        globalThis.Uint16Array = real;
      }
    });
    const node = bigEndian.p.binary(Uint16Array);
    const inMemory = new Uint16Array(Uint8Array.of(0x12, 0x34, 0xab, 0xcd).buffer);
    const bytes = node.encode(inMemory);
    expect(bytes).toEqual(p.binary(Uint16Array).encode(Uint16Array.of(0x1234, 0xabcd)));
    expect(new Uint8Array(node.decode(bytes).buffer)).toEqual(
      Uint8Array.of(0x12, 0x34, 0xab, 0xcd)
    );
  });
});

describe('p.binary adaptive', () => {
  const plain = p.binary().max(7);
  const weights = Array.from({ length: 8 }, (_, i) => (i === 3 ? 29 : 1));
  const run = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length }, () => new Uint8Array(rnd() < 0.8 ? 3 : Math.floor(rnd() * 8)));
  };

  it('round-trips a run of values, inside an array too', () => {
    const values = run(300, 1);
    for (const node of [plain.adaptive(), plain.weights(weights).adaptive({ window: 8 })]) {
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

  it('learns a skew, at most a byte over the static prior of it', () => {
    const values = run(2000, 3);
    const size = (node: typeof plain) => p.array(node).encode(values).length;
    expect(size(plain.adaptive())).toBeLessThan(size(plain));
    expect(size(plain.weights(weights).adaptive())).toBeLessThanOrEqual(
      size(plain.weights(weights)) + 1
    );
  });

  it('written once, spends the bytes of its static form through its first byte, at most one more after', () => {
    for (const value of run(20, 4)) {
      for (const [learning, fixed] of [
        [plain.adaptive(), plain],
        [plain.weights(weights).adaptive(), plain.weights(weights)],
      ]) {
        const bytes = learning.encode(value);
        if (value.length <= 1) {
          expect(bytes).toEqual(fixed.encode(value));
        }
        expect(bytes.length).toBeLessThanOrEqual(fixed.encode(value).length + 1);
      }
    }
  });

  it('learns the bytes: a long run of mostly one value shrinks, a short one costs at most a byte over its static length', () => {
    const value = new Uint8Array(500).map((_, i) => (i % 17 === 0 ? i & 255 : 7));
    expect(trip(p.binary().adaptive(), value)).toEqual(value);
    expect(p.binary().adaptive().encode(value).length).toBeLessThan(
      p.binary().encode(value).length / 5
    );
    const short = new Uint8Array(3);
    expect(plain.adaptive().encode(short).length).toBeLessThanOrEqual(
      plain.encode(short).length + 1
    );
  });

  it('learns the bytes of every element width', () => {
    const value = Int32Array.from({ length: 200 }, (_, i) => (i % 9 === 0 ? -i : 0x01020304));
    const node = p.binary(Int32Array).adaptive({ window: 64 });
    expect(trip(node, value)).toEqual(value);
    expect(node.encode(value).length).toBeLessThan(p.binary(Int32Array).encode(value).length / 2);
  });

  it('takes no max, the bytes then learning alone', () => {
    const values = run(50, 5);
    expect(trip(p.array(p.binary().adaptive()), values)).toEqual(values);
  });

  it('refuses bad options', () => {
    expect(() => plain.adaptive({ window: 0 })).toThrow(
      new RangeError('p.binary learning window must be a positive integer, got 0')
    );
    expect(() => plain.adaptive({ window: 1.5 })).toThrow(
      new TypeError('p.binary learning window must be a positive integer, got 1.5')
    );
    expect(() => plain.weights([2 ** 45, ...Array<number>(7).fill(1)]).adaptive()).toThrow(
      new RangeError(
        'p.binary adaptive prior 16 and window 1024 overflow with weights totalling 35184372088839'
      )
    );
    const cdf = new TypeError('p.binary learn takes weights, not a cdf');
    expect(() => plain.cdf((v) => v).adaptive()).toThrow(cdf);
    expect(() => plain.adaptive().cdf((v) => v)).toThrow(cdf);
  });
});

describe('p.binary adaptive repeats', () => {
  it('copies a repeated byte pattern', () => {
    const pattern = Uint8Array.from([0x13, 0xf7, 0x00, 0x8a, 0x42, 0x99, 0x5c, 0xe1]);
    const value = new Uint8Array(400).map((_, i) => pattern[i % pattern.length]);
    const node = p.binary().adaptive();
    expect(trip(node, value)).toEqual(value);
    expect(node.encode(value).length).toBeLessThan(40);
  });

  it('copies repeats across Int16Array elements', () => {
    const random = mulberry32(9);
    const stretch = Int16Array.from({ length: 12 }, () => Math.floor(random() * 65536) - 32768);
    const value = Int16Array.from({ length: 120 }, (_, i) =>
      i % 30 < 12 ? stretch[i % 30] : Math.floor(random() * 65536) - 32768
    );
    const node = p.binary(Int16Array).adaptive();
    expect(trip(node, value)).toEqual(value);
    expect(node.encode(value).length).toBeLessThan(p.binary(Int16Array).encode(value).length - 40);
  });
});

describe('p.binary methods', () => {
  const header = Uint8Array.from({ length: 24 }, (_, i) => (i * 29) % 256);
  /** Packets sharing a header, each with a short body of its own. */
  const packets = Array.from({ length: 40 }, (_, i) =>
    Uint8Array.from([...header, i, (i * 7) % 256, 3])
  );
  const size = (node: PBinary<Uint8Array>) => p.array(node).encode(packets).length;

  it('spells each array after the bytes it shares with the one before', () => {
    for (const node of [
      p.binary().delta(),
      p.binary().repeats(),
      p.binary().adaptive(),
      p.binary().adaptive().delta(),
      p.binary().delta().repeats().recall(),
    ]) {
      expect(trip(p.array(node), packets)).toEqual(packets);
    }
    expect(size(p.binary().delta())).toBeLessThan(size(p.binary()) / 4);
    expect(size(p.binary().repeats())).toBeLessThan(size(p.binary()) / 2);
  });

  it('shares bytes, not elements, under a wider type', () => {
    const values = [Int16Array.of(1, 2, 3), Int16Array.of(1, 2, 0x103), Int16Array.of(1)];
    const node = p.array(p.binary(Int16Array).delta());
    expect(trip(node, values)).toEqual(values);
  });

  it('recalls an array it already wrote as a copy of the one first decoded', () => {
    const a = Uint8Array.of(1, 2, 3);
    const values = [a, Uint8Array.of(4), a];
    for (const node of [p.binary().recall(), p.binary().adaptive().recall()]) {
      const out = trip(p.array(node), values);
      expect(out).toEqual(values);
      expect(out[2]).not.toBe(out[0]);
      expect(out[2]).toBeInstanceOf(Uint8Array);
    }
    const wide = trip(p.array(p.binary(Float64Array).recall()), [
      Float64Array.of(0.5),
      Float64Array.of(0.5),
    ]);
    expect(wide[1]).toBeInstanceOf(Float64Array);
    expect(wide[1]).not.toBe(wide[0]);
  });

  it('keeps its methods through every later option, each declared once', () => {
    const late = p.binary().delta().min(1).max(40);
    const early = p.binary().min(1).max(40).delta();
    expect(p.array(late).encode(packets)).toEqual(p.array(early).encode(packets));
    for (const method of ['delta', 'recall', 'repeats'] as const) {
      expect(() => p.binary()[method]()[method]()).toThrow(
        new TypeError(`p.binary ${method} is already set`)
      );
    }
  });
});
