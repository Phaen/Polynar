/**
 * `p.binary()`: typed arrays as raw bits.
 */

import { p, CorruptInputError } from '../../index';
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

  it('runs out of input on a corrupted length instead of allocating it', () => {
    // An unbounded length prefix claiming 2^40 bytes, followed by nothing.
    const claim = p
      .int()
      .min(0)
      .encode(2 ** 40);
    expect(() => p.binary().decode(claim)).toThrow(CorruptInputError);
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
