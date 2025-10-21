/**
 * Tests for fraction encoding module
 */

import { Encoder, Decoder } from '../../polynar';

describe('Fraction Module', () => {
  it('should encode and decode fractions', () => {
    const encoder = new Encoder();
    encoder.write([0.5, 1.5, 2.75], { type: 'fraction' });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'fraction' }, 3) as number[];

    expect(decoded[0]).toBeCloseTo(0.5, 10);
    expect(decoded[1]).toBeCloseTo(1.5, 10);
    expect(decoded[2]).toBeCloseTo(2.75, 10);
  });

  it('should handle negative fractions', () => {
    const encoder = new Encoder();
    encoder.write([-0.5, -1.25], { type: 'fraction' });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'fraction' }, 2) as number[];

    expect(decoded[0]).toBeCloseTo(-0.5, 10);
    expect(decoded[1]).toBeCloseTo(-1.25, 10);
  });

  it('should handle custom precision', () => {
    const encoder = new Encoder();
    encoder.write(Math.PI, { type: 'fraction', precision: 1e-10 });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'fraction', precision: 1e-10 });

    expect(decoded).toBeCloseTo(Math.PI, 9);
  });

  it('should handle non-strict mode with invalid input', () => {
    const encoder = new Encoder(false);
    encoder.write(['not a number' as any], { type: 'fraction' });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded, null as any, false);
    const decoded = decoder.read({ type: 'fraction' });

    expect(decoded).toBe(0);
  });

  it('should throw in strict mode with invalid input', () => {
    const encoder = new Encoder(true);
    expect(() => {
      encoder.write(['not a number' as any], { type: 'fraction' });
    }).toThrow();
  });
});
