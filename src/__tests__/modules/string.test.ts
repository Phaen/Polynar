/**
 * Tests for string encoding module
 */

import { Encoder, Decoder, CharSets } from '../../polynar';

describe('String Module', () => {
  describe('Basic string encoding', () => {
    it('should encode and decode a string', () => {
      const encoder = new Encoder();
      encoder.write('hello', { type: 'string', max: 20 });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'string', max: 20 });

      expect(decoded).toBe('hello');
    });

    it('should encode with custom charset', () => {
      const encoder = new Encoder();
      encoder.write('ABC', { type: 'string', max: 10, charset: CharSets.hialpha });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'string', max: 10, charset: CharSets.hialpha });

      expect(decoded).toBe('ABC');
    });
  });

  describe('Variable length strings', () => {
    it('should encode variable-length strings', () => {
      const encoder = new Encoder();
      encoder.write(['a', 'hello', 'world!'], {
        type: 'string',
        max: false,
      });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'string', max: false }, 3);

      expect(decoded).toEqual(['a', 'hello', 'world!']);
    });

    it('should handle empty strings', () => {
      const encoder = new Encoder();
      encoder.write('', { type: 'string', max: 10 });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'string', max: 10 });

      expect(decoded).toBe('');
    });
  });

  describe('Strict mode validation', () => {
    it('should truncate strings in non-strict mode', () => {
      const encoder = new Encoder(false);
      encoder.write('toolong', { type: 'string', max: 3 });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'string', max: 3 });

      expect(decoded).toBe('too');
    });

    it('should throw on too-long strings in strict mode', () => {
      const encoder = new Encoder(true);
      expect(() => {
        encoder.write('toolong', { type: 'string', max: 3 });
      }).toThrow();
    });
  });
});
