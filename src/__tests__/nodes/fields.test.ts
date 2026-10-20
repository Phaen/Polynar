/**
 * The learned scale of a distance from an origin, over hand-built
 * encoders and decoders.
 */

import { Encoder, Decoder } from '../../index';
import { FieldScale } from '../../nodes/fields';

describe('FieldScale', () => {
  it('round-trips values on both sides of the origin', () => {
    const values = [50, 0, 49, 51, 7, 100, 3, 50, 1000000];
    const enc = new Encoder();
    const writer = new FieldScale();
    for (const value of values) {
      writer.write(enc, value, 50, 0, 1000000);
      writer.learn(enc, value, 50);
    }
    const dec = new Decoder(enc.output());
    const reader = new FieldScale();
    for (const value of values) {
      const read = reader.read(dec, 50, 0, 1000000);
      reader.learn(dec, read, 50);
      expect(read).toBe(value);
    }
  });

  it('round-trips an interval that reaches only one side of the origin', () => {
    const values = [5, 9, 5, 6];
    const enc = new Encoder();
    const writer = new FieldScale();
    for (const value of values) {
      writer.write(enc, value, 5, 5, 9);
    }
    const dec = new Decoder(enc.output());
    const reader = new FieldScale();
    expect(values.map(() => reader.read(dec, 5, 5, 9))).toEqual(values);
  });

  it('keeps coding after the learned total passes its window', () => {
    const enc = new Encoder();
    const scale = new FieldScale();
    for (let at = 0; at < 200; at++) {
      scale.write(enc, at % 7, 3, 0, 100);
      scale.learn(enc, at % 7, 3);
    }
    const dec = new Decoder(enc.output());
    const reader = new FieldScale();
    for (let at = 0; at < 200; at++) {
      const read = reader.read(dec, 3, 0, 100);
      reader.learn(dec, read, 3);
      expect(read).toBe(at % 7);
    }
  });
});
