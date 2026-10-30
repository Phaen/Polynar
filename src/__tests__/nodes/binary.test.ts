/**
 * `p.binary()`: typed arrays as raw bits.
 */

import { p, CorruptInputError } from '../../index';
import { Decoder, Encoder } from '../../packer';
import { Bytes } from '../../nodes/binary';
import { mulberry32, trip } from '../support';
import { STRUCT } from '../../predictor/types';

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

describe('p.binary().compress()', () => {
  const raw = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const noise = (length: number, seed: number) => {
    const rnd = mulberry32(seed);
    return Uint8Array.from({ length }, () => Math.floor(rnd() * 256));
  };

  it('round-trips an empty array', () => {
    expect(trip(p.binary().compress(), new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  it('round-trips every byte value', () => {
    const value = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(trip(p.binary().compress(), value)).toEqual(value);
  });

  it('round-trips a repetitive 4 kB buffer', () => {
    const value = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) % 13);
    expect(trip(p.binary().compress(), value)).toEqual(value);
  });

  it('round-trips negative Int16Array elements', () => {
    const value = Int16Array.of(-1, 0, 32767, -32768, -300, 5);
    expect(trip(p.binary(Int16Array).compress(), value)).toEqual(value);
  });

  it('round-trips a NaN payload and negative zero bit-exact', () => {
    const value = new Float64Array(3);
    new DataView(value.buffer).setBigUint64(0, 0x7ff8_0000_dead_beefn);
    value[1] = -0;
    value[2] = 1.5;
    const out = trip(p.binary(Float64Array).compress(), value);
    expect(raw(out)).toEqual(raw(value));
  });

  it('round-trips BigUint64Array elements', () => {
    const value = BigUint64Array.of(0n, 2n ** 64n - 1n, 123456789n);
    expect(trip(p.binary(BigUint64Array).compress(), value)).toEqual(value);
  });

  it('spends less on a buffer the node already wrote', () => {
    const node = p.array(p.binary().compress());
    const x = noise(64, 1);
    const y = noise(64, 2);
    expect(node.encode([x, x]).length).toBeLessThan(node.encode([x, y]).length - 30);
    expect(trip(node, [x, x])).toEqual([x, x]);
  });

  it('encodes a repeated pattern in far fewer bytes than it holds', () => {
    const pattern = noise(16, 3);
    const value = Uint8Array.from({ length: 4096 }, (_, i) => pattern[i % 16]);
    const node = p.binary().compress();
    expect(trip(node, value)).toEqual(value);
    expect(node.encode(value).length).toBeLessThan(200);
  });

  it('round-trips with separate learning', () => {
    const values = [noise(40, 4), noise(40, 4), noise(7, 5)];
    expect(trip(p.array(p.binary().compress({ separate: true })), values)).toEqual(values);
  });

  it('bounds the length in elements', () => {
    const node = p.binary(Int16Array).min(1).max(3).compress();
    for (let n = 1; n <= 3; n++) {
      const value = Int16Array.from({ length: n }, (_, i) => i - 2);
      const out = trip(node, value);
      expect(out).toEqual(value);
      expect(out.length).toBe(n);
    }
    expect(() => node.encode(new Int16Array(0))).toThrow(RangeError);
    expect(() => node.encode(new Int16Array(4))).toThrow(RangeError);
  });

  it('round-trips a fixed length', () => {
    const node = p.binary(Int16Array).length(2).compress();
    const value = Int16Array.of(-7, 300);
    expect(trip(node, value)).toEqual(value);
  });

  it('refuses a second compress', () => {
    expect(() => p.binary().compress().compress()).toThrow(
      new TypeError('p.binary compress is already set')
    );
  });

  it('refuses a prior on the length', () => {
    expect(() => p.binary().max(2).weights([1, 1, 1]).compress()).toThrow(TypeError);
    expect(() =>
      p
        .binary()
        .max(2)
        .compress()
        .cdf((v) => v)
    ).toThrow(TypeError);
  });

  it('refuses an invalid option', () => {
    expect(() => p.binary().compress({ offsets: 2000 })).toThrow(RangeError);
  });

  it('throws or decodes on corrupt input, never hangs', () => {
    const node = p.binary().max(4).compress();
    const rnd = mulberry32(0xc0de);
    for (let i = 0; i < 20; i++) {
      const input = Uint8Array.from({ length: 1 + (i % 6) }, () => Math.floor(rnd() * 256));
      try {
        expect(node.decode(input).length).toBeLessThanOrEqual(4);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});

describe('Bytes', () => {
  it('spells every byte as its own symbol, one unit with no tail', () => {
    const bytes = new Bytes(Uint8Array);
    const enc = new Encoder();
    bytes.tail();
    enc.compose(7, 256);
    expect(bytes.units()).toBe(1);
    expect(bytes.tails()).toBe(1);
    expect(bytes.untail(new Decoder(enc.output()), 7)).toBe(7);
  });
});

describe('p.binary methods', () => {
  it('adapts under a container sugar unless it adapts already', () => {
    const compress = p.binary().compress({ window: 8 });
    expect(compress._adapted({ window: 16 })).toBe(compress);
    const plain = p.binary();
    const adapted = plain._adapted({ window: 16 });
    expect(adapted).not.toBe(plain);
    expect(adapted._compress).toEqual({ window: 16 });
  });

  it.each([
    [Int8Array, STRUCT.TYPED_0],
    [Uint8Array, STRUCT.TYPED_0 + 1],
    [Uint8ClampedArray, STRUCT.TYPED_0 + 2],
    [Int16Array, STRUCT.TYPED_0 + 3],
    [Uint16Array, STRUCT.TYPED_0 + 4],
    [Int32Array, STRUCT.TYPED_0 + 5],
    [Uint32Array, STRUCT.TYPED_0 + 6],
    [Float32Array, STRUCT.TYPED_0 + 7],
    [Float64Array, STRUCT.TYPED_0 + 8],
    [BigInt64Array, STRUCT.TYPED_0 + 9],
    [BigUint64Array, STRUCT.TYPED_0 + 10],
  ])('names the marker of its typed-array class, %p, its only one', (type, marker) => {
    const node = p.binary(type as typeof Int8Array);
    expect(node._marker()).toBe(marker);
    expect(node._markers()).toEqual(new Set([marker]));
  });

  it('names the byte-array marker by default', () => {
    expect(p.binary()._marker()).toBe(24);
    expect(p.binary(Int16Array)._marker()).toBe(26);
  });
});
