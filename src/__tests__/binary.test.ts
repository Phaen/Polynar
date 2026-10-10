/**
 * Binary (Uint8Array) output — `encode`/`decode`, `output` /
 * `new Decoder(Uint8Array)`, the default [0,255] charset, custom byte charsets
 * (and that emitted bytes stay inside them), charset validation, and the
 * binary-mode parse error surface.
 */

import { p, Encoder, Decoder, CharSets } from '../index';

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

  describe('byte charsets', () => {
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
      const bytes = enc.output({ charset: range });
      for (const b of bytes) {
        expect(b).toBeGreaterThanOrEqual(32);
        expect(b).toBeLessThanOrEqual(126);
      }
      expect(node._read(new Decoder(bytes, { charset: range }))).toBe('test');
    });

    it('is deterministic across encoders', () => {
      const node = p.int().min(0).max(100);
      expect(node.encode(42)).toEqual(node.encode(42));
    });

    it('defaults to every byte value', () => {
      const node = p.int().min(0).max(1e6);
      expect(node.encode(123456)).toEqual(node.encode(123456, { charset: [0, 255] }));
    });

    it('writes a string charset as the code of each character', () => {
      const node = p.int().min(0).max(1000);
      const bytes = node.encode(737, { charset: '01' });
      // 737 is 1011100001 in binary, written lowest digit first.
      expect(String.fromCharCode(...bytes)).toBe('1000011101');
      expect(node.decode(bytes, { charset: '01' })).toBe(737);
    });

    it('spells the same symbols as text output in the same charset', () => {
      const node = p.string().max(20);
      const bytes = node.encode('same symbols', { charset: CharSets.hex });
      const text = node.encode('same symbols', { type: 'text', charset: CharSets.hex });
      expect(String.fromCharCode(...bytes)).toBe(text);
      expect(node.decode(bytes, { charset: CharSets.hex })).toBe('same symbols');
    });

    it('takes the block size alongside a string charset', () => {
      const node = p.array(p.int().min(0).max(1000)).max(100);
      const value = Array.from({ length: 60 }, (_, i) => (i * 37) % 1001);
      const options = { charset: CharSets.alphanumeric, blockBits: 128 };
      const bytes = node.encode(value, options);
      expect(bytes).not.toEqual(node.encode(value, { charset: CharSets.alphanumeric }));
      expect(node.decode(bytes, options)).toEqual(value);
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
      expect(() => enc.output({ charset: [-1, 255] })).toThrow(RangeError);
      expect(() => enc.output({ charset: [0, 256] })).toThrow(RangeError);
      expect(() => enc.output({ charset: [100, 50] })).toThrow(RangeError);
      expect(() => enc.output({ charset: [0.5, 10] })).toThrow(RangeError);
    });

    it('rejects an out-of-bounds decoder range', () => {
      const bytes = new Uint8Array([100, 150, 200]);
      expect(() => new Decoder(bytes, { charset: [-1, 255] })).toThrow(RangeError);
      expect(() => new Decoder(bytes, { charset: [0, 256] })).toThrow(RangeError);
      expect(() => new Decoder(bytes, { charset: [200, 100] })).toThrow(RangeError);
      expect(() => new Decoder(bytes, { charset: [0.5, 10] })).toThrow(RangeError);
    });

    it('rejects a charset symbol that is not a byte', () => {
      expect(() => p.bool().encode(true, { charset: 'aĀ' })).toThrow(
        new RangeError("Character 'Ā' (code 256) is not a byte, so binary output cannot use it")
      );
      expect(() => p.bool().decode(Uint8Array.of(97), { charset: 'a一' })).toThrow(RangeError);
      expect(() => p.bool().encode(true, { charset: [200, 300] })).toThrow(
        new RangeError('Code 300 is not a byte, so binary output cannot use the range [200, 300]')
      );
    });

    it('throws when reading past the end of the byte buffer', () => {
      const node = p.int().min(0).max(100);
      const decoder = new Decoder(node.encode(42));
      expect(node._read(decoder)).toBe(42);
      expect(() => node._read(decoder)).toThrow('Unexpected end of input while parsing');
    });

    it('throws when a byte is not in the charset', () => {
      expect(() => new Decoder(new Uint8Array([10, 200]), { charset: [0, 100] })).toThrow(
        'Byte at 1 is not in the charset'
      );
    });
  });
});
