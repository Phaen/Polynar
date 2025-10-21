/**
 * Tests for boolean encoding module
 */

import { Encoder, Decoder } from '../../polynar';

describe('Boolean Module', () => {
  it('should encode and decode a boolean', () => {
    const encoder = new Encoder();
    encoder.write(true, { type: 'boolean' });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'boolean' });

    expect(decoded).toBe(true);
  });

  it('should encode and decode multiple booleans', () => {
    const encoder = new Encoder();
    encoder.write([true, false, true], { type: 'boolean' });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'boolean' }, 3);

    expect(decoded).toEqual([true, false, true]);
  });
});
