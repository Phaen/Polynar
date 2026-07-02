/**
 * String module — full feature & bounds coverage.
 *
 * Features: variable-length (max:false) vs bounded length, the built-in
 * character sets, numeric/binary-range charsets, length/type validation, charset
 * compliance, and validator rejections.
 */

import { Encoder, Decoder, CharSets } from '../../polynar';
import type { StringOptions } from '../../types';

const roundTrip = (value: string | string[], options: StringOptions) => {
  const encoder = new Encoder();
  encoder.write(value, options);
  const decoder = new Decoder(encoder.toString());
  return decoder.read(options, Array.isArray(value) ? value.length : 1);
};

describe('String module', () => {
  describe('variable length (max:false)', () => {
    it('round-trips strings of differing lengths', () => {
      const opts: StringOptions = { type: 'string', max: false };
      expect(roundTrip(['', 'a', 'hello', 'world!'], opts)).toEqual(['', 'a', 'hello', 'world!']);
    });

    it('defaults to variable length when max is omitted', () => {
      expect(roundTrip('hello', { type: 'string' } as StringOptions)).toBe('hello');
    });

    it('round-trips long strings', () => {
      const long = 'x'.repeat(500);
      expect(roundTrip(long, { type: 'string', max: false })).toBe(long);
    });
  });

  describe('bounded length', () => {
    it('round-trips strings up to the max', () => {
      const opts: StringOptions = { type: 'string', max: 20 };
      expect(roundTrip('hello', opts)).toBe('hello');
      expect(roundTrip('', opts)).toBe('');
      expect(roundTrip('12345678901234567890', opts)).toBe('12345678901234567890');
    });
  });

  describe('character sets', () => {
    it.each(Object.entries(CharSets))('round-trips through the %s charset', (_name, charset) => {
      const sample = charset.slice(0, 8);
      expect(roundTrip(sample, { type: 'string', max: false, charset })).toBe(sample);
    });

    it('round-trips full-unicode text via a binary-range charset', () => {
      const opts: StringOptions = { type: 'string', max: false, charset: [0, 65535] };
      const value = 'café — 漢字 👋';
      expect(roundTrip(value, opts)).toBe(value);
    });

    it('round-trips via a numeric charset (interpreted as [0, n])', () => {
      const opts: StringOptions = { type: 'string', max: false, charset: 127 };
      expect(roundTrip('hello', opts)).toBe('hello');
    });

    it('throws when a character is not in the (string) charset', () => {
      const encoder = new Encoder();
      expect(() => encoder.write('xyz', { type: 'string', charset: CharSets.digit })).toThrow();
    });

    it('throws when a character is outside a binary-range charset', () => {
      const encoder = new Encoder();
      expect(() => encoder.write('ABC', { type: 'string', charset: [0, 10] })).toThrow();
    });
  });

  describe('length & type validation', () => {
    it('throws on strings over the max', () => {
      const encoder = new Encoder();
      expect(() => encoder.write('toolong', { type: 'string', max: 3 })).toThrow(RangeError);
    });

    it('throws on non-strings', () => {
      const encoder = new Encoder();
      expect(() => encoder.write(123 as unknown as string, { type: 'string' })).toThrow(TypeError);
    });
  });

  describe('validator rejections', () => {
    const enc = new Encoder();
    it('rejects a negative max', () => {
      expect(() => enc.write('a', { type: 'string', max: -1 })).toThrow(TypeError);
    });

    it('rejects a fractional max', () => {
      expect(() => enc.write('a', { type: 'string', max: 2.5 })).toThrow(TypeError);
    });
  });
});
