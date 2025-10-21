/**
 * Tests for core Encoder and Decoder classes
 */

import { Encoder, Decoder, CharSets } from '../polynar';

describe('Encoder', () => {
  it('should create encoder instance', () => {
    const encoder = new Encoder();
    expect(encoder).toBeInstanceOf(Encoder);
    expect(encoder.strict).toBe(false);
  });

  it('should support strict mode', () => {
    const encoder = new Encoder(true);
    expect(encoder.strict).toBe(true);
  });

  it('should encode with different charsets', () => {
    const encoder = new Encoder();
    encoder.write(42, { type: 'number', min: 0, max: 100 });

    const base64 = encoder.toString(CharSets.Base64);
    const urlSafe = encoder.toString(CharSets.urlSafe);

    expect(base64).toBeTruthy();
    expect(urlSafe).toBeTruthy();
  });

  it('should throw on invalid encoding type', () => {
    const encoder = new Encoder();
    expect(() => {
      encoder.write(42, { type: 'invalid' } as any);
    }).toThrow('Invalid encoding type');
  });

  it('should handle limit option', () => {
    const encoder = new Encoder();
    encoder.write([1, 2, 3], { type: 'number', min: 0, max: 10, limit: 10 });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'number', min: 0, max: 10, limit: 10 });

    expect(decoded).toEqual([1, 2, 3]);
  });

  it('should throw when exceeding limit', () => {
    const encoder = new Encoder();
    expect(() => {
      encoder.write([1, 2, 3, 4], { type: 'number', min: 0, max: 10, limit: 2 });
    }).toThrow('Item count exceeds limit');
  });
});

describe('Decoder', () => {
  it('should create decoder instance', () => {
    const decoder = new Decoder('test');
    expect(decoder).toBeInstanceOf(Decoder);
    expect(decoder.strict).toBe(false);
  });

  it('should support strict mode', () => {
    const decoder = new Decoder('test', null as any, true);
    expect(decoder.strict).toBe(true);
  });

  it('should decode with same charset as encoded', () => {
    const encoder = new Encoder();
    encoder.write(42, { type: 'number', min: 0, max: 100 });

    const base64 = encoder.toString(CharSets.Base64);
    const urlSafe = encoder.toString(CharSets.urlSafe);

    const dec1 = new Decoder(base64, CharSets.Base64);
    const dec2 = new Decoder(urlSafe, CharSets.urlSafe);

    expect(dec1.read({ type: 'number', min: 0, max: 100 })).toBe(42);
    expect(dec2.read({ type: 'number', min: 0, max: 100 })).toBe(42);
  });

  it('should throw on invalid charset', () => {
    expect(() => {
      new Decoder('test', 'aab'); // Duplicate character
    }).toThrow('Invalid character set');
  });

  it('should throw on invalid binary range', () => {
    expect(() => {
      new Decoder('test', [5, 6]); // Gap < 2
    }).toThrow();
  });

  it('should throw on missing input', () => {
    expect(() => {
      new Decoder(null as any);
    }).toThrow('Missing first argument');
  });
});

describe('Pre/Post Processing', () => {
  it('should apply preprocessing function', () => {
    const encoder = new Encoder();
    encoder.write([1, 2, 3], {
      type: 'number',
      min: 0,
      max: 10,
      preProc: (x) => x * 2,
    });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'number', min: 0, max: 10 }, 3);

    expect(decoded).toEqual([2, 4, 6]);
  });

  it('should apply postprocessing function', () => {
    const encoder = new Encoder();
    encoder.write([2, 4, 6], { type: 'number', min: 0, max: 10 });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read(
      {
        type: 'number',
        min: 0,
        max: 10,
        postProc: (x) => x / 2,
      },
      3
    );

    expect(decoded).toEqual([1, 2, 3]);
  });
});
