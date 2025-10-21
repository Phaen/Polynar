/**
 * Tests for item list encoding module
 */

import { Encoder, Decoder } from '../../polynar';

describe('Item Module', () => {
  it('should encode and decode from a list', () => {
    const colors = ['red', 'green', 'blue'];
    const encoder = new Encoder();
    encoder.write('green', { type: 'item', list: colors });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'item', list: colors });

    expect(decoded).toBe('green');
  });

  it('should handle item not in list (non-strict)', () => {
    const list = ['a', 'b', 'c'];
    const encoder = new Encoder(false);
    encoder.write('d', { type: 'item', list });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'item', list });

    expect(decoded).toBe('a'); // Falls back to first item
  });

  it('should throw on item not in list (strict)', () => {
    const list = ['a', 'b', 'c'];
    const encoder = new Encoder(true);

    expect(() => {
      encoder.write('d', { type: 'item', list });
    }).toThrow();
  });

  it('should handle sorted lists', () => {
    const list1 = ['c', 'a', 'b'];
    const list2 = ['a', 'b', 'c'];

    const encoder1 = new Encoder();
    encoder1.write('a', { type: 'item', list: list1, sort: true });
    const encoded1 = encoder1.toString();

    const encoder2 = new Encoder();
    encoder2.write('a', { type: 'item', list: list2, sort: true });
    const encoded2 = encoder2.toString();

    expect(encoded1).toBe(encoded2);
  });
});
