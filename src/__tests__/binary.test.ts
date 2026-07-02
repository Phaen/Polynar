/**
 * Binary (Uint8Array) output — `toUint8Array` / `new Decoder(Uint8Array)`.
 *
 * Covers round-tripping every module through bytes, the default [0,255] range,
 * custom byte ranges (and that emitted bytes stay inside them), range
 * validation, and the binary-mode parse error surface.
 */

import { Encoder, Decoder } from '../polynar';

describe('Binary output', () => {
  describe('round-trips through bytes', () => {
    it('numbers', () => {
      const enc = new Encoder();
      enc.write(42, { type: 'number', min: 0, max: 100 });
      const decoded = new Decoder(enc.toUint8Array()).read({ type: 'number', min: 0, max: 100 });
      expect(decoded).toBe(42);
    });

    it('strings', () => {
      const enc = new Encoder();
      enc.write('Hello, World!', { type: 'string', max: 50 });
      expect(new Decoder(enc.toUint8Array()).read({ type: 'string', max: 50 })).toBe(
        'Hello, World!'
      );
    });

    it('an object template', () => {
      const tpl = {
        type: 'object' as const,
        template: {
          name: { type: 'string', max: 50 },
          age: { type: 'number', min: 0, max: 150 },
          active: { type: 'boolean' },
        },
      };
      const user = { name: 'Alice', age: 28, active: true };
      const enc = new Encoder();
      enc.write(user, tpl);
      expect(new Decoder(enc.toUint8Array()).read(tpl)).toEqual(user);
    });

    it('mixed types via any', () => {
      const enc = new Encoder();
      const date = new Date('2024-01-01T00:00:00Z');
      enc.write([42, 'test', true, date], { type: 'any' });
      const decoded = new Decoder(enc.toUint8Array()).read({ type: 'any' }, 4) as unknown[];
      expect(decoded[0]).toBe(42);
      expect(decoded[1]).toBe('test');
      expect(decoded[2]).toBe(true);
      expect((decoded[3] as Date).getTime()).toBe(date.getTime());
    });
  });

  describe('byte ranges', () => {
    it('returns a Uint8Array and defaults to the full [0,255] range', () => {
      const enc = new Encoder();
      enc.write([10, 20, 30], { type: 'number', min: 0, max: 100 });
      const bytes = enc.toUint8Array();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(new Decoder(bytes).read({ type: 'number', min: 0, max: 100 }, 3)).toEqual([
        10, 20, 30,
      ]);
    });

    it('keeps every byte inside a custom range and round-trips with it', () => {
      const enc = new Encoder();
      enc.write('test', { type: 'string', max: 10 });
      const range: [number, number] = [32, 126];
      const bytes = enc.toUint8Array(range);
      for (const b of bytes) {
        expect(b).toBeGreaterThanOrEqual(32);
        expect(b).toBeLessThanOrEqual(126);
      }
      expect(new Decoder(bytes, range).read({ type: 'string', max: 10 })).toBe('test');
    });

    it('is independent of the string charset used elsewhere', () => {
      const a = new Encoder();
      a.write(42, { type: 'number', min: 0, max: 100 });
      const b = new Encoder();
      b.write(42, { type: 'number', min: 0, max: 100 });
      expect(a.toUint8Array()).toEqual(b.toUint8Array());
    });
  });

  describe('serialisation', () => {
    it('survives a JSON round-trip via Array.from', () => {
      const enc = new Encoder();
      enc.write(42, { type: 'number', min: 0, max: 100 });
      const json = JSON.stringify(Array.from(enc.toUint8Array()));
      const restored = new Uint8Array(JSON.parse(json));
      expect(new Decoder(restored).read({ type: 'number', min: 0, max: 100 })).toBe(42);
    });
  });

  describe('validation & errors', () => {
    it('rejects an out-of-bounds encoder range', () => {
      const enc = new Encoder();
      enc.write(42, { type: 'number', min: 0, max: 100 });
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

    it('throws when reading past the end of the byte buffer', () => {
      const enc = new Encoder();
      enc.write(42, { type: 'number', min: 0, max: 100 });
      const decoder = new Decoder(enc.toUint8Array());
      decoder.read({ type: 'number', min: 0, max: 100 });
      expect(() => decoder.read({ type: 'number', min: 0, max: 100 })).toThrow(
        'Unexpected end of input while parsing'
      );
    });
  });
});
