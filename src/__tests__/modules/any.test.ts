/**
 * Tests for any type encoding module
 */

import { Encoder, Decoder } from '../../polynar';

describe('Any Module', () => {
  it('should encode and decode undefined', () => {
    const encoder = new Encoder();
    encoder.write(undefined, { type: 'any' });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'any' });

    expect(decoded).toBeUndefined();
  });

  it('should encode and decode mixed types', () => {
    const encoder = new Encoder();
    const data = [42, 'hello', true, undefined, new Date('2024-01-01')];
    encoder.write(data, { type: 'any' });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'any' }, 5) as any[];

    expect(decoded[0]).toBe(42);
    expect(decoded[1]).toBe('hello');
    expect(decoded[2]).toBe(true);
    expect(decoded[3]).toBeUndefined();
    expect(decoded[4]).toBeInstanceOf(Date);
  });

  it('should encode and decode objects via any', () => {
    const encoder = new Encoder();
    const obj = { a: 1, b: 2 };
    encoder.write(obj, { type: 'any' });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'any' });

    expect(decoded).toEqual(obj);
  });
});
