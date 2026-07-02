/**
 * Core Encoder/Decoder — construction, charsets, low-level primitives, the
 * generic `limit`/`preProc`/`postProc` options, multi-write buffers, and the
 * error surface shared by every module.
 */

import { Encoder, Decoder, CharSets } from '../polynar';
import type { NumberOptions } from '../types';

const NUM: NumberOptions = { type: 'number', min: 0, max: 1000 };

describe('Encoder / Decoder construction', () => {
  it('throws when constructed without input', () => {
    expect(() => new Decoder(null as never)).toThrow('Missing first argument');
  });
});

describe('Character sets', () => {
  it.each(Object.entries(CharSets))('round-trips through the %s charset', (_name, charset) => {
    const encoder = new Encoder();
    encoder.write(123, NUM);
    const decoder = new Decoder(encoder.toString(charset), charset);
    expect(decoder.read(NUM)).toBe(123);
  });

  it('uses Base64 as the default charset on both ends', () => {
    const encoder = new Encoder();
    encoder.write(123, NUM);
    // No charset on either side → both default to Base64.
    expect(new Decoder(encoder.toString()).read(NUM)).toBe(123);
  });

  it('round-trips through a numeric charset ([0, n])', () => {
    const encoder = new Encoder();
    encoder.write(123, NUM);
    expect(new Decoder(encoder.toString(16), 16).read(NUM)).toBe(123);
  });

  it('round-trips through a binary-range charset', () => {
    const encoder = new Encoder();
    encoder.write(123, NUM);
    const range: [number, number] = [65, 90];
    expect(new Decoder(encoder.toString(range), range).read(NUM)).toBe(123);
  });
});

describe('Low-level primitives', () => {
  it('compose/parse round-trips a fixed-radix integer', () => {
    const encoder = new Encoder();
    encoder.compose(3, 10);
    encoder.compose(7, 10);
    const decoder = new Decoder(encoder.toString());
    expect(decoder.parse(10)).toBe(3);
    expect(decoder.parse(10)).toBe(7);
  });

  it('composeTerm/parseTerm round-trips an unbounded integer', () => {
    const encoder = new Encoder();
    encoder.composeTerm(0);
    encoder.composeTerm(12345);
    const decoder = new Decoder(encoder.toString());
    expect(decoder.parseTerm()).toBe(0);
    expect(decoder.parseTerm()).toBe(12345);
  });
});

describe('Multi-write buffers', () => {
  it('reads heterogeneous values back in write order', () => {
    const encoder = new Encoder();
    encoder.write(42, { type: 'number', min: 0, max: 100 });
    encoder.write('hello', { type: 'string', max: 10 });
    encoder.write(true, { type: 'boolean' });

    const decoder = new Decoder(encoder.toString());
    expect(decoder.read({ type: 'number', min: 0, max: 100 })).toBe(42);
    expect(decoder.read({ type: 'string', max: 10 })).toBe('hello');
    expect(decoder.read({ type: 'boolean' })).toBe(true);
  });
});

describe('limit option', () => {
  it('round-trips a length-prefixed array within the limit', () => {
    const opts: NumberOptions = { type: 'number', min: 0, max: 10, limit: 10 };
    const encoder = new Encoder();
    encoder.write([1, 2, 3], opts);
    expect(new Decoder(encoder.toString()).read(opts)).toEqual([1, 2, 3]);
  });

  it('round-trips a single-element array as an array, not a bare value', () => {
    const opts: NumberOptions = { type: 'number', min: 0, max: 10, limit: 10 };
    const encoder = new Encoder();
    encoder.write([7], opts);
    expect(new Decoder(encoder.toString()).read(opts)).toEqual([7]);
  });

  it('throws when the item count exceeds the limit', () => {
    const encoder = new Encoder();
    expect(() =>
      encoder.write([1, 2, 3, 4], { type: 'number', min: 0, max: 10, limit: 2 })
    ).toThrow('Item count exceeds limit');
  });

  it('rejects an invalid limit', () => {
    const encoder = new Encoder();
    expect(() => encoder.write([1], { type: 'number', min: 0, max: 10, limit: -1 })).toThrow(
      TypeError
    );
  });
});

describe('preProc / postProc', () => {
  it('applies preProc on encode', () => {
    const encoder = new Encoder();
    encoder.write([1, 2, 3], { type: 'number', min: 0, max: 10, preProc: (x) => x * 2 });
    const decoded = new Decoder(encoder.toString()).read({ type: 'number', min: 0, max: 10 }, 3);
    expect(decoded).toEqual([2, 4, 6]);
  });

  it('does not mutate the caller array when applying preProc', () => {
    const input = [1, 2, 3];
    new Encoder().write(input, { type: 'number', min: 0, max: 10, preProc: (x) => x * 2 });
    expect(input).toEqual([1, 2, 3]);
  });

  it('applies postProc on decode', () => {
    const encoder = new Encoder();
    encoder.write([2, 4, 6], { type: 'number', min: 0, max: 10 });
    const decoded = new Decoder(encoder.toString()).read(
      { type: 'number', min: 0, max: 10, postProc: (x) => x / 2 },
      3
    );
    expect(decoded).toEqual([1, 2, 3]);
  });
});

describe('read count handling', () => {
  it('returns an empty array for a count of 0', () => {
    const encoder = new Encoder();
    encoder.write(5, NUM);
    expect(new Decoder(encoder.toString()).read(NUM, 0)).toEqual([]);
  });

  it('rejects a non-integer count', () => {
    const encoder = new Encoder();
    encoder.write([1, 2], NUM);
    expect(() => new Decoder(encoder.toString()).read(NUM, 1.5)).toThrow(TypeError);
  });

  it('rejects a negative count', () => {
    const encoder = new Encoder();
    encoder.write(5, NUM);
    expect(() => new Decoder(encoder.toString()).read(NUM, -1)).toThrow(TypeError);
  });
});

describe('error surface', () => {
  it('rejects an unknown encoding type on write', () => {
    expect(() => new Encoder().write(1, { type: 'nope' } as never)).toThrow(
      'Invalid encoding type'
    );
  });

  it('rejects an unknown encoding type on read', () => {
    expect(() => new Decoder('abc').read({ type: 'nope' } as never)).toThrow(
      'Invalid encoding type'
    );
  });

  it('rejects a duplicate-character charset', () => {
    expect(() => new Decoder('test', 'aab')).toThrow('Invalid character set');
  });

  it('rejects a binary range with a gap < 2', () => {
    expect(() => new Decoder('test', [5, 6])).toThrow();
  });

  it('throws when a character is absent from the charset', () => {
    const decoder = new Decoder('!', CharSets.digit);
    expect(() => decoder.read({ type: 'boolean' })).toThrow(/not found in character set/);
  });

  it('throws when a character falls just past a binary-range charset', () => {
    // '[' (code 91) is one beyond the maximum of the [65, 90] range.
    expect(() => new Decoder('Z[', [65, 90]).read({ type: 'string', charset: [65, 90] })).toThrow();
  });

  it('throws when input ends mid-parse', () => {
    const encoder = new Encoder();
    encoder.write(5, NUM);
    const decoder = new Decoder(encoder.toString());
    decoder.read(NUM);
    expect(() => decoder.read(NUM)).toThrow('Unexpected end of input while parsing');
  });
});
