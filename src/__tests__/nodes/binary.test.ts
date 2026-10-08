/**
 * Schema binary node (`p.binary()`, `p.binary()`) — typed arrays as raw bits.
 */

import { p, CorruptInputError } from '../../index';
import { trip } from '../support';

describe('Schema binary', () => {
  it('bytes round-trip to a fresh Uint8Array', () => {
    const value = new Uint8Array([0, 1, 127, 128, 255]);
    const decoded = trip(p.binary(), value);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded).toEqual(value);
    expect(decoded).not.toBe(value);
    expect(trip(p.binary(), new Uint8Array())).toEqual(new Uint8Array());
  });

  it('a fixed length costs exactly its bytes', () => {
    const hash = p.binary().length(32);
    const value = Uint8Array.from({ length: 32 }, (_, i) => (i * 37) % 256);
    expect(hash.encode(value)).toHaveLength(32);
    expect(trip(hash, value)).toEqual(value);
    expect(() => hash.encode(new Uint8Array(31))).toThrow(
      new RangeError('Binary length 31 differs from the fixed length 32')
    );
  });

  it('bounds the count like a string', () => {
    const node = p.binary().min(2).max(4);
    expect(trip(node, new Uint8Array([9, 9, 9]))).toEqual(new Uint8Array([9, 9, 9]));
    expect(() => node.encode(new Uint8Array(1))).toThrow('Binary length 1 is below the minimum 2');
    expect(() => node.encode(new Uint8Array(5))).toThrow('Binary length 5 is above the maximum 4');
    expect(() => p.binary().length(4).max(8)).toThrow('cannot be combined');
    expect(() => p.binary().min(3).max(2)).toThrow('range is empty');
  });

  it('accepts a Uint8Array subclass and decodes a plain one', () => {
    class Tagged extends Uint8Array {}
    const decoded = trip(p.binary(), new Tagged([1, 2]));
    expect(Object.getPrototypeOf(decoded)).toBe(Uint8Array.prototype);
    expect(decoded).toEqual(new Uint8Array([1, 2]));
  });

  it('is its own kind in a union, apart from objects', () => {
    const node = p.union([p.binary(), p.object({ a: p.int() }), p.null()]);
    expect(trip(node, new Uint8Array([7]))).toEqual(new Uint8Array([7]));
    expect(trip(node, { a: 1 })).toEqual({ a: 1 });
    expect(() => p.union([p.binary(), p.binary().max(4)])).toThrow("overlap on kind 'Uint8Array'");
  });

  it('a corrupted length runs out of input instead of allocating it', () => {
    // An unbounded length prefix claiming 2^40 bytes, followed by nothing.
    const claim = p
      .int()
      .min(0)
      .encode(2 ** 40);
    expect(() => p.binary().decode(claim)).toThrow(CorruptInputError);
  });

  it('any typed array round-trips bit-exact at its own width', () => {
    const ints = Int16Array.of(-32768, -1, 0, 1, 32767);
    expect(trip(p.binary(Int16Array), ints)).toEqual(ints);
    expect(p.binary(Int16Array).length(5).encode(ints)).toHaveLength(10);

    // Raw bits: NaN payloads and -0 survive, which value-level encoding would not promise.
    const floats = Float64Array.of(-0, Number.NaN, Math.PI, Number.MIN_VALUE);
    const back = trip(p.binary(Float64Array), floats);
    expect(back).toBeInstanceOf(Float64Array);
    expect(Object.is(back[0], -0)).toBe(true);
    expect(new Uint8Array(back.buffer)).toEqual(new Uint8Array(floats.buffer));

    const wide = BigInt64Array.of(-(2n ** 63n), 0n, 2n ** 63n - 1n);
    expect(trip(p.binary(BigInt64Array), wide)).toEqual(wide);
    expect(trip(p.binary(Float32Array), Float32Array.of(1.5, -2))).toEqual(
      Float32Array.of(1.5, -2)
    );
  });

  it('elements go on the wire low byte first', () => {
    const word = p.binary(Uint16Array).length(1).encode(Uint16Array.of(0x0102));
    expect(word).toEqual(p.binary().length(2).encode(Uint8Array.of(0x02, 0x01)));
  });

  it('reads only its own slice of a shared buffer', () => {
    const buffer = Int16Array.of(9, 1, 2, 9).buffer;
    const view = new Int16Array(buffer, 2, 2);
    expect(trip(p.binary(Int16Array), view)).toEqual(Int16Array.of(1, 2));
  });

  it('each typed-array class is its own kind, subclasses included', () => {
    class Samples extends Int16Array {}
    const node = p.union([p.binary(), p.binary(Int16Array)]);
    expect(trip(node, Uint8Array.of(7))).toEqual(Uint8Array.of(7));
    expect(trip(node, Int16Array.of(-7))).toEqual(Int16Array.of(-7));
    expect(trip(node, new Samples([3]))).toEqual(Int16Array.of(3));
    expect(() => p.union([p.binary(Int16Array), p.binary(Samples)])).toThrow(
      "overlap on kind 'Int16Array'"
    );
  });
});
