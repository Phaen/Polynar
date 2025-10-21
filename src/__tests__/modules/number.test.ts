/**
 * Tests for number encoding module
 */

import { Encoder, Decoder } from '../../polynar';

describe('Number Module', () => {
  describe('Basic number encoding', () => {
    it('should encode and decode a number with range', () => {
      const encoder = new Encoder();
      encoder.write(42, { type: 'number', min: 0, max: 100 });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'number', min: 0, max: 100 });

      expect(decoded).toBe(42);
    });

    it('should encode and decode multiple numbers', () => {
      const encoder = new Encoder();
      encoder.write([10, 20, 30], { type: 'number', min: 0, max: 100 });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'number', min: 0, max: 100 }, 3);

      expect(decoded).toEqual([10, 20, 30]);
    });

    it('should encode with step size', () => {
      const encoder = new Encoder();
      encoder.write(2.5, { type: 'number', min: 0, max: 10, step: 0.5 });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'number', min: 0, max: 10, step: 0.5 });

      expect(decoded).toBe(2.5);
    });
  });

  describe('Unbounded numbers', () => {
    it('should encode unbounded positive numbers', () => {
      const encoder = new Encoder();
      encoder.write([100, 1000, 10000], {
        type: 'number',
        min: 0,
        max: false,
      });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read(
        {
          type: 'number',
          min: 0,
          max: false,
        },
        3
      );

      expect(decoded).toEqual([100, 1000, 10000]);
    });

    it('should encode unbounded negative numbers', () => {
      const encoder = new Encoder();
      encoder.write([-100, -1000], {
        type: 'number',
        min: false,
        max: 0,
      });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read(
        {
          type: 'number',
          min: false,
          max: 0,
        },
        2
      );

      expect(decoded).toEqual([-100, -1000]);
    });

    it('should encode fully unbounded numbers', () => {
      const encoder = new Encoder();
      encoder.write([100, -50, 0], {
        type: 'number',
        min: false,
        max: false,
      });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read(
        {
          type: 'number',
          min: false,
          max: false,
        },
        3
      );

      expect(decoded).toEqual([100, -50, 0]);
    });
  });

  describe('Strict mode validation', () => {
    it('should handle range validation in strict mode', () => {
      const encoder = new Encoder(true);
      expect(() => {
        encoder.write(150, { type: 'number', min: 0, max: 100 });
      }).toThrow();
    });

    it('should clamp values in non-strict mode', () => {
      const encoder = new Encoder(false);
      encoder.write(150, { type: 'number', min: 0, max: 100 });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'number', min: 0, max: 100 });

      expect(decoded).toBe(100);
    });
  });
});
