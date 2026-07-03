/**
 * Binary (Uint8Array) output — `encode`/`decode`, `toUint8Array` /
 * `new Decoder(Uint8Array)`, the default [0,255] range, custom byte ranges
 * (and that emitted bytes stay inside them), range validation, and the
 * binary-mode parse error surface.
 */

import { p, Encoder, Decoder } from '../index';

describe('Binary output', () => {
  describe('round-trips through bytes', () => {
    it('numbers', () => {
      const node = p.int().min(0).max(100);
      expect(node.decode(node.encode(42))).toBe(42);
    });

    it('strings', () => {
      const node = p.string().max(50);
      expect(node.decode(node.encode('Hello, World!'))).toBe('Hello, World!');
    });

    it('an object', () => {
      const User = p.object({
        name: p.string().max(50),
        age: p.int().min(0).max(150),
        active: p.bool(),
      });
      const user = { name: 'Alice', age: 28, active: true };
      expect(User.decode(User.encode(user))).toEqual(user);
    });

    it('mixed types via any', () => {
      const node = p.array(p.any());
      const date = new Date('2024-01-01T00:00:00Z');
      const decoded = node.decode(node.encode([42, 'test', true, date])) as unknown[];
      expect(decoded[0]).toBe(42);
      expect(decoded[1]).toBe('test');
      expect(decoded[2]).toBe(true);
      expect((decoded[3] as Date).getTime()).toBe(date.getTime());
    });
  });

  describe('byte ranges', () => {
    it('encode returns a Uint8Array over the full [0,255] range', () => {
      const node = p.array(p.int().min(0).max(100));
      const bytes = node.encode([10, 20, 30]);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(node.decode(bytes)).toEqual([10, 20, 30]);
    });

    it('keeps every byte inside a custom range and round-trips with it', () => {
      // Custom byte ranges are a primitive-layer concern: drive the node's
      // `_write`/`_read` against an Encoder/Decoder holding the range.
      const node = p.string().max(10);
      const enc = new Encoder();
      node._write(enc, 'test');
      const range: [number, number] = [32, 126];
      const bytes = enc.toUint8Array(range);
      for (const b of bytes) {
        expect(b).toBeGreaterThanOrEqual(32);
        expect(b).toBeLessThanOrEqual(126);
      }
      expect(node._read(new Decoder(bytes, range))).toBe('test');
    });

    it('is deterministic across encoders', () => {
      const node = p.int().min(0).max(100);
      expect(node.encode(42)).toEqual(node.encode(42));
    });
  });

  describe('serialisation', () => {
    it('survives a JSON round-trip via Array.from', () => {
      const node = p.int().min(0).max(100);
      const json = JSON.stringify(Array.from(node.encode(42)));
      const restored = new Uint8Array(JSON.parse(json));
      expect(node.decode(restored)).toBe(42);
    });
  });

  describe('validation & errors', () => {
    it('rejects an out-of-bounds encoder range', () => {
      const enc = new Encoder();
      enc.compose(42, 101);
      expect(() => enc.toUint8Array([-1, 255])).toThrow(RangeError);
      expect(() => enc.toUint8Array([0, 256])).toThrow(RangeError);
      expect(() => enc.toUint8Array([100, 50])).toThrow(RangeError);
    });

    it('rejects an out-of-bounds decoder range', () => {
      const bytes = new Uint8Array([100, 150, 200]);
      expect(() => new Decoder(bytes, [-1, 255])).toThrow(RangeError);
      expect(() => new Decoder(bytes, [0, 256])).toThrow(RangeError);
      expect(() => new Decoder(bytes, [200, 100])).toThrow(RangeError);
    });

    it('rejects a binary charset that is not a [min, max] range', () => {
      const bytes = p.int().min(0).max(100).encode(42);
      expect(() => new Encoder().toUint8Array(16 as never)).toThrow(TypeError);
      expect(() => new Decoder(bytes, 16 as never)).toThrow(TypeError);
      expect(() => new Decoder(bytes, 'abc')).toThrow(TypeError);
    });

    it('throws when reading past the end of the byte buffer', () => {
      const node = p.int().min(0).max(100);
      const decoder = new Decoder(node.encode(42));
      expect(node._read(decoder)).toBe(42);
      expect(() => node._read(decoder)).toThrow('Unexpected end of input while parsing');
    });

    it('throws when a byte falls outside the binary range', () => {
      const decoder = new Decoder(new Uint8Array([10, 200]), [0, 100]);
      expect(() => decoder.parse(1001)).toThrow('does not fit binary range');
    });
  });
});
