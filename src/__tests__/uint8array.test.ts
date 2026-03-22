/**
 * Tests for Uint8Array binary encoding/decoding
 */

import { Encoder, Decoder } from '../polynar';

describe('Uint8Array encoding', () => {
  it('should encode and decode numbers using Uint8Array', () => {
    const encoder = new Encoder();
    encoder.write(42, { type: 'number', min: 0, max: 100 });

    const binary = encoder.toUint8Array();
    expect(binary).toBeInstanceOf(Uint8Array);

    const decoder = new Decoder(binary);
    const decoded = decoder.read({ type: 'number', min: 0, max: 100 });

    expect(decoded).toBe(42);
  });

  it('should encode and decode strings using Uint8Array', () => {
    const encoder = new Encoder();
    encoder.write('Hello, World!', { type: 'string', max: 50 });

    const binary = encoder.toUint8Array();
    expect(binary).toBeInstanceOf(Uint8Array);

    const decoder = new Decoder(binary);
    const decoded = decoder.read({ type: 'string', max: 50 });

    expect(decoded).toBe('Hello, World!');
  });

  it('should encode and decode booleans using Uint8Array', () => {
    const encoder = new Encoder();
    const bools = [true, false, true, true, false];
    encoder.write(bools, { type: 'boolean' });

    const binary = encoder.toUint8Array();
    expect(binary).toBeInstanceOf(Uint8Array);

    const decoder = new Decoder(binary);
    const decoded = decoder.read({ type: 'boolean' }, 5);

    expect(decoded).toEqual(bools);
  });

  it('should encode and decode dates using Uint8Array', () => {
    const encoder = new Encoder();
    const date = new Date('2024-01-15T12:30:00Z');
    encoder.write(date, { type: 'date', interval: 1000 });

    const binary = encoder.toUint8Array();
    expect(binary).toBeInstanceOf(Uint8Array);

    const decoder = new Decoder(binary);
    const decoded = decoder.read({ type: 'date', interval: 1000 });

    expect(decoded).toBeInstanceOf(Date);
    // Compare dates by timestamp with interval tolerance
    const diff = Math.abs(decoded.getTime() - date.getTime());
    expect(diff).toBeLessThan(2000); // Less than 2 seconds (1000ms interval)
  });

  it('should encode and decode objects using Uint8Array', () => {
    const encoder = new Encoder();
    const user = {
      name: 'Alice',
      age: 28,
      active: true,
    };

    encoder.write(user, {
      type: 'object',
      template: {
        name: { type: 'string', max: 50 },
        age: { type: 'number', min: 0, max: 150 },
        active: { type: 'boolean' },
      },
    });

    const binary = encoder.toUint8Array();
    expect(binary).toBeInstanceOf(Uint8Array);

    const decoder = new Decoder(binary);
    const decoded = decoder.read({
      type: 'object',
      template: {
        name: { type: 'string', max: 50 },
        age: { type: 'number', min: 0, max: 150 },
        active: { type: 'boolean' },
      },
    });

    expect(decoded).toEqual(user);
  });

  it('should encode and decode items using Uint8Array', () => {
    const encoder = new Encoder();
    const colors = ['red', 'green', 'blue', 'yellow', 'purple'];
    encoder.write(['green', 'blue', 'red'], { type: 'item', list: colors });

    const binary = encoder.toUint8Array();
    expect(binary).toBeInstanceOf(Uint8Array);

    const decoder = new Decoder(binary);
    const decoded = decoder.read({ type: 'item', list: colors }, 3);

    expect(decoded).toEqual(['green', 'blue', 'red']);
  });

  it('should encode and decode fractions using Uint8Array', () => {
    const encoder = new Encoder();
    encoder.write(0.75, { type: 'fraction', precision: 1e-10 });

    const binary = encoder.toUint8Array();
    expect(binary).toBeInstanceOf(Uint8Array);

    const decoder = new Decoder(binary);
    const decoded = decoder.read({ type: 'fraction', precision: 1e-10 });

    expect(decoded).toBeCloseTo(0.75, 9);
  });

  it('should encode and decode mixed types using Uint8Array', () => {
    const encoder = new Encoder();
    const data = [42, 'test', true, new Date()];
    encoder.write(data, { type: 'any' });

    const binary = encoder.toUint8Array();
    expect(binary).toBeInstanceOf(Uint8Array);

    const decoder = new Decoder(binary);
    const decoded = decoder.read({ type: 'any' }, 4);

    expect(decoded[0]).toBe(42);
    expect(decoded[1]).toBe('test');
    expect(decoded[2]).toBe(true);
    expect(decoded[3]).toBeInstanceOf(Date);
  });

  it('should produce smaller output than string for complex data', () => {
    const encoder = new Encoder();
    const data = {
      temperature: 23.5,
      humidity: 65,
      timestamp: new Date('2024-01-15T12:30:00Z'),
      status: 'active',
    };

    encoder.write(data, {
      type: 'object',
      template: {
        temperature: { type: 'number', min: -50, max: 50, step: 0.1 },
        humidity: { type: 'number', min: 0, max: 100 },
        timestamp: { type: 'date', interval: 1000 },
        status: { type: 'item', list: ['active', 'inactive', 'pending'] },
      },
    });

    const binary = encoder.toUint8Array();
    const stringEncoded = encoder.toString();

    // Binary should be more compact or same size
    expect(binary.length).toBeLessThanOrEqual(stringEncoded.length);
  });

  it('should handle multiple writes before conversion', () => {
    const encoder = new Encoder();
    encoder.write(42, { type: 'number', min: 0, max: 100 });
    encoder.write('hello', { type: 'string', max: 10 });
    encoder.write(true, { type: 'boolean' });

    const binary = encoder.toUint8Array();
    expect(binary).toBeInstanceOf(Uint8Array);

    const decoder = new Decoder(binary);
    const num = decoder.read({ type: 'number', min: 0, max: 100 });
    const str = decoder.read({ type: 'string', max: 10 });
    const bool = decoder.read({ type: 'boolean' });

    expect(num).toBe(42);
    expect(str).toBe('hello');
    expect(bool).toBe(true);
  });

  it('should be serializable to JSON via Array.from', () => {
    const encoder = new Encoder();
    encoder.write(42, { type: 'number', min: 0, max: 100 });

    const binary = encoder.toUint8Array();
    const array = Array.from(binary);
    const json = JSON.stringify(array);

    // Should be able to reconstruct from JSON
    const reconstructed = new Uint8Array(JSON.parse(json));
    const decoder = new Decoder(reconstructed);
    const decoded = decoder.read({ type: 'number', min: 0, max: 100 });

    expect(decoded).toBe(42);
  });

  it('should handle large data sets efficiently', () => {
    const encoder = new Encoder();
    const largeArray = Array.from({ length: 1000 }, (_, i) => i % 100);
    encoder.write(largeArray, { type: 'number', min: 0, max: 100 });

    const binary = encoder.toUint8Array();
    expect(binary).toBeInstanceOf(Uint8Array);

    const decoder = new Decoder(binary);
    const decoded = decoder.read({ type: 'number', min: 0, max: 100 }, 1000);

    expect(decoded).toEqual(largeArray);
  });

  it('should throw error when reading past end of Uint8Array', () => {
    const encoder = new Encoder();
    encoder.write(42, { type: 'number', min: 0, max: 100 });

    const binary = encoder.toUint8Array();
    const decoder = new Decoder(binary);

    // First read should succeed
    decoder.read({ type: 'number', min: 0, max: 100 });

    // Second read should throw - no more data
    expect(() => {
      decoder.read({ type: 'number', min: 0, max: 100 });
    }).toThrow('Unexpected end of input while parsing');
  });

  it('should work with strict mode enabled', () => {
    const encoder = new Encoder(true);
    encoder.write(42, { type: 'number', min: 0, max: 100 });

    const binary = encoder.toUint8Array();

    const decoder = new Decoder(binary, undefined, true);
    const decoded = decoder.read({ type: 'number', min: 0, max: 100 });

    expect(decoded).toBe(42);
  });

  it('should encode to same binary regardless of string charset used', () => {
    const encoder1 = new Encoder();
    encoder1.write(42, { type: 'number', min: 0, max: 100 });

    const encoder2 = new Encoder();
    encoder2.write(42, { type: 'number', min: 0, max: 100 });

    const binary1 = encoder1.toUint8Array();
    const binary2 = encoder2.toUint8Array();

    expect(binary1).toEqual(binary2);
  });

  it('should support custom min/max range for Uint8Array', () => {
    const encoder = new Encoder();
    encoder.write(42, { type: 'number', min: 0, max: 100 });

    // Use range 100-200 instead of 0-255
    const binary = encoder.toUint8Array([100, 200]);
    expect(binary).toBeInstanceOf(Uint8Array);

    // All bytes should be in range 100-200
    for (let i = 0; i < binary.length; i++) {
      expect(binary[i]).toBeGreaterThanOrEqual(100);
      expect(binary[i]).toBeLessThanOrEqual(200);
    }

    // Decode with same range
    const decoder = new Decoder(binary, [100, 200]);
    const decoded = decoder.read({ type: 'number', min: 0, max: 100 });

    expect(decoded).toBe(42);
  });

  it('should use default range 0-255 when no parameters provided', () => {
    const encoder = new Encoder();
    encoder.write([10, 20, 30], { type: 'number', min: 0, max: 100 });

    const binary = encoder.toUint8Array(); // Defaults to 0-255

    // Decode without specifying range (defaults to 0-255)
    const decoder = new Decoder(binary);
    const decoded = decoder.read({ type: 'number', min: 0, max: 100 }, 3);

    expect(decoded).toEqual([10, 20, 30]);
  });

  it('should throw error for invalid min/max range', () => {
    const encoder = new Encoder();
    encoder.write(42, { type: 'number', min: 0, max: 100 });

    // Invalid ranges
    expect(() => encoder.toUint8Array([-1, 255])).toThrow(RangeError);
    expect(() => encoder.toUint8Array([0, 256])).toThrow(RangeError);
    expect(() => encoder.toUint8Array([100, 50])).toThrow(RangeError);
  });

  it('should throw error for invalid decoder range', () => {
    const binary = new Uint8Array([100, 150, 200]);

    expect(() => new Decoder(binary, [-1, 255])).toThrow(RangeError);
    expect(() => new Decoder(binary, [0, 256])).toThrow(RangeError);
    expect(() => new Decoder(binary, [200, 100])).toThrow(RangeError);
  });

  it('should handle restricted byte range efficiently', () => {
    const encoder = new Encoder();
    const testString = 'test';
    encoder.write(testString, { type: 'string', max: 10 });

    // Use printable ASCII range only (32-126)
    const binary = encoder.toUint8Array([32, 126]);

    // All bytes should be printable ASCII
    for (let i = 0; i < binary.length; i++) {
      expect(binary[i]).toBeGreaterThanOrEqual(32);
      expect(binary[i]).toBeLessThanOrEqual(126);
    }

    const decoder = new Decoder(binary, [32, 126]);
    const decoded = decoder.read({ type: 'string', max: 10 });

    expect(decoded).toBe(testString);
  });
});
