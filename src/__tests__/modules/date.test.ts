/**
 * Tests for date encoding module
 */

import { Encoder, Decoder } from '../../polynar';

describe('Date Module', () => {
  it('should encode and decode a date', () => {
    const date = new Date('2024-01-15T12:00:00Z');
    const encoder = new Encoder();
    encoder.write(date, { type: 'date', interval: 1000 });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'date', interval: 1000 }) as Date;

    expect(decoded).toBeInstanceOf(Date);
    expect(Math.abs(decoded.getTime() - date.getTime())).toBeLessThan(2000);
  });

  describe('Time intervals', () => {
    it('should encode with second interval', () => {
      const date = new Date('2024-01-15T12:30:45Z');
      const encoder = new Encoder();
      encoder.write(date, { type: 'date', interval: 'second' });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'date', interval: 'second' }) as Date;

      expect(Math.abs(decoded.getTime() - date.getTime())).toBeLessThan(1000);
    });

    it('should encode with minute interval', () => {
      const date = new Date('2024-01-15T12:30:00Z');
      const encoder = new Encoder();
      encoder.write(date, { type: 'date', interval: 'minute' });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'date', interval: 'minute' }) as Date;

      expect(Math.abs(decoded.getTime() - date.getTime())).toBeLessThan(60000);
    });

    it('should encode with day interval', () => {
      const date = new Date('2024-01-15T00:00:00Z');
      const encoder = new Encoder();
      encoder.write(date, { type: 'date', interval: 'day' });
      const encoded = encoder.toString();

      const decoder = new Decoder(encoded);
      const decoded = decoder.read({ type: 'date', interval: 'day' }) as Date;

      const dayMs = 24 * 60 * 60 * 1000;
      expect(Math.abs(decoded.getTime() - date.getTime())).toBeLessThan(dayMs);
    });
  });

  it('should handle date strings', () => {
    const encoder = new Encoder(false);
    encoder.write('2024-01-15' as any, { type: 'date', interval: 1000 });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'date', interval: 1000 });

    expect(decoded).toBeInstanceOf(Date);
  });
});
