/**
 * Core Encoder/Decoder — construction, charsets, low-level primitives, the
 * generic `limit`/`preProc`/`postProc` options, multi-write buffers, and the
 * error surface shared by every module.
 */

import { Encoder, Decoder, CharSets } from '../polynar';
import { blockCapacity } from '../utils';
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

  it('accepts a reversed range charset without mutating the caller array', () => {
    const encoder = new Encoder();
    encoder.write(123, NUM);
    const reversed: [number, number] = [90, 65];
    expect(new Decoder(encoder.toString(reversed), reversed).read(NUM)).toBe(123);
    expect(reversed).toEqual([90, 65]);
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

  it('composeTerm/parseTerm round-trips terms above 2^53 bit-exact', () => {
    // The digits travel through BigInt on both ends; float division here
    // rounds and would silently land on a neighbouring integer.
    const encoder = new Encoder();
    encoder.composeTerm(18014398509481988);
    encoder.composeTerm(1e300);
    const decoder = new Decoder(encoder.toString());
    expect(decoder.parseTerm()).toBe(18014398509481988);
    expect(decoder.parseTerm()).toBe(1e300);
  });

  it('rejects a compose integer outside its radix', () => {
    const encoder = new Encoder();
    expect(() => encoder.compose(10, 10)).toThrow(RangeError);
    expect(() => encoder.compose(-1, 10)).toThrow(RangeError);
    expect(() => encoder.compose(1.5, 10)).toThrow(RangeError);
  });

  it('rejects an invalid compose radix', () => {
    const encoder = new Encoder();
    expect(() => encoder.compose(0, 0)).toThrow(TypeError);
    expect(() => encoder.compose(0, 2.5)).toThrow(TypeError);
  });

  it('rejects a negative or fractional composeTerm term', () => {
    const encoder = new Encoder();
    expect(() => encoder.composeTerm(-1)).toThrow(TypeError);
    expect(() => encoder.composeTerm(1.5)).toThrow(TypeError);
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

  it('treats limit 0 as a cap of zero, not as no limit', () => {
    const opts: NumberOptions = { type: 'number', min: 0, max: 10, limit: 0 };
    const encoder = new Encoder();
    encoder.write([], opts);
    expect(new Decoder(encoder.toString()).read(opts)).toEqual([]);
    expect(() => new Encoder().write([1], opts)).toThrow('Item count exceeds limit');
  });

  it('rejects sparse-array holes instead of desyncing the length prefix', () => {
    // A hole reads as undefined, which is not a number; skipping it (as for-in
    // iteration would) would encode fewer values than the prefix declares.
    const sparse = [1, , 3];
    expect(() =>
      new Encoder().write(sparse, { type: 'number', min: 0, max: 10, limit: 5 })
    ).toThrow(TypeError);
  });

  it('encodes sparse holes as undefined under the any type, keeping the count', () => {
    const sparse = [1, , 3];
    const encoder = new Encoder();
    encoder.write(sparse, { type: 'any', limit: 5 });
    expect(new Decoder(encoder.toString()).read({ type: 'any', limit: 5 })).toEqual([
      1,
      undefined,
      3,
    ]);
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

describe('output density', () => {
  it('packs to the information-theoretic minimum length', () => {
    // Four base-1001 slots span 1001^4 ≈ 1.004e12 states. That needs 5 bytes
    // (256^5 ≈ 1.100e12) and 7 Base64 chars (64^7 ≈ 4.398e12; 6 are too few).
    const encoder = new Encoder();
    encoder.write([1000, 0, 999, 1], { ...NUM, max: 1000 });
    expect(encoder.toUint8Array().length).toBe(5);
    expect(encoder.toString().length).toBe(7);

    const decoder = new Decoder(encoder.toUint8Array());
    expect(decoder.read(NUM, 4)).toEqual([1000, 0, 999, 1]);
  });

  it('packs 40 booleans into exactly 40 bits', () => {
    // No byte boundary rounds a partially-filled slot up on its own; only the
    // whole message rounds, once, to 5 bytes.
    const encoder = new Encoder();
    encoder.write(
      Array.from({ length: 40 }, (_, i) => i % 3 === 0),
      { type: 'boolean' }
    );
    expect(encoder.toUint8Array().length).toBe(5);
  });

  it('produces empty output for an empty encoder', () => {
    const encoder = new Encoder();
    expect(encoder.toString()).toBe('');
    expect(encoder.toUint8Array().length).toBe(0);
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

  it('rejects a duplicate-character charset even across a newline', () => {
    expect(() => new Decoder('test', 'ab\ncd\na')).toThrow('Invalid character set');
  });

  it('rejects a charset of fewer than two characters', () => {
    // Base 1 has no digit variation: the encoder's digit loop would push until
    // the array overflows and the decoder would misparse every read.
    expect(() => new Encoder().toString('a')).toThrow('Invalid character set');
    expect(() => new Decoder('aaa', 'a')).toThrow('Invalid character set');
  });

  it('rejects a binary range with a gap < 2', () => {
    expect(() => new Decoder('test', [5, 6])).toThrow();
  });

  it('rejects a range charset outside the UTF-16 code-unit space', () => {
    // String.fromCharCode truncates modulo 2^16, so such digits would decode
    // back as different in-range values without any error.
    const encoder = new Encoder();
    encoder.write(123, NUM);
    expect(() => encoder.toString([0, 100000])).toThrow('Invalid binary range');
    expect(() => encoder.toString([-5, 100])).toThrow('Invalid binary range');
    expect(() => encoder.toString([0.5, 100.5])).toThrow('Invalid binary range');
    expect(() => new Decoder('x', 70000)).toThrow('Invalid binary range');
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

  it('throws when reading from empty input', () => {
    expect(() => new Decoder('').read(NUM)).toThrow('Unexpected end of input while parsing');
  });
});

describe('block packing', () => {
  // Large messages pack in ~2048-bit blocks so the big-number arithmetic
  // stays linear in message size. Blocks are invisible to reads; they only
  // cost at most one unfilled digit each at a boundary.

  it('round-trips a message spanning many blocks', () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 1001);
    const encoder = new Encoder();
    encoder.write(values, NUM);
    const decoder = new Decoder(encoder.toString());
    expect(decoder.read(NUM, 3000)).toEqual(values);
    expect(() => decoder.finalize()).not.toThrow();
  });

  it('round-trips a multi-block byte payload', () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i * 31) % 1001);
    const encoder = new Encoder();
    encoder.write(values, NUM);
    const decoder = new Decoder(encoder.toUint8Array());
    expect(decoder.read(NUM, 3000)).toEqual(values);
    expect(() => decoder.finalize()).not.toThrow();
  });

  it('packs power-of-two radices across blocks with zero waste', () => {
    // 4000 booleans hold exactly 4000 bits; base-2 slots divide the 2048-bit
    // block cap evenly, so no boundary digit goes unfilled: 500 bytes even.
    const encoder = new Encoder();
    encoder.write(
      Array.from({ length: 4000 }, (_, i) => i % 3 === 0),
      { type: 'boolean' }
    );
    expect(encoder.toUint8Array().length).toBe(500);
  });

  it('throws on a digit tampered past a block boundary', () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 1001);
    const encoder = new Encoder();
    encoder.write(values, NUM);
    const str = encoder.toString();
    // Bump the first block's highest digit to the charset maximum: the block
    // value then exceeds its radix product, and the boundary check rejects the
    // remainder the encoder guarantees is never there.
    const top = blockCapacity(64).digits - 1;
    const decoder = new Decoder(str.slice(0, top) + '/' + str.slice(top + 1));
    expect(() => decoder.read(NUM, 3000)).toThrow('Oversaturated input');
  });

  it('throws when a multi-block message is truncated', () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 1001);
    const encoder = new Encoder();
    encoder.write(values, NUM);
    const decoder = new Decoder(encoder.toString().slice(0, -5));
    // A cut-off tail is indistinguishable from tampered high digits, so either
    // diagnosis may surface — reading must fail one way or the other.
    expect(() => decoder.read(NUM, 3000)).toThrow();
  });

  it('finalize throws on padding appended to a multi-block message', () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 1001);
    const encoder = new Encoder();
    encoder.write(values, NUM);
    const decoder = new Decoder(encoder.toString() + 'AA');
    decoder.read(NUM, 3000);
    expect(() => decoder.finalize()).toThrow('Input is longer than its contents');
  });
});

describe('corruption detection', () => {
  it('throws mid-read when a tampered digit oversaturates the input', () => {
    // Two radix-50 values nearly fill two Base64 chars (2500 of 4096 states),
    // so after the second read less than one doubling of state space is left
    // and any leftover value is provably a digit bumped past saturation.
    const opts: NumberOptions = { type: 'number', min: 0, max: 49 };
    const encoder = new Encoder();
    encoder.write([10, 20], opts);
    const str = encoder.toString();
    expect(str).toHaveLength(2);
    const decoder = new Decoder(str.slice(0, -1) + '/');
    decoder.read(opts);
    expect(() => decoder.read(opts)).toThrow('Oversaturated input');
  });

  it('finalize accepts a fully-read canonical input', () => {
    const encoder = new Encoder();
    encoder.write(5, NUM);
    const decoder = new Decoder(encoder.toString());
    decoder.read(NUM);
    expect(() => decoder.finalize()).not.toThrow();
  });

  it('finalize accepts an empty input with no reads', () => {
    expect(() => new Decoder('').finalize()).not.toThrow();
  });

  it('finalize throws on a tampered digit the reads alone cannot see', () => {
    // A boolean spans 2 of the 64 states its single Base64 char holds; bumping
    // the char leaves a remainder invisible to the read (which still returns a
    // valid boolean) but caught by the leftover-value check.
    const encoder = new Encoder();
    encoder.write(true, { type: 'boolean' });
    expect(encoder.toString()).toBe('B');
    const decoder = new Decoder('D');
    expect(decoder.read({ type: 'boolean' })).toBe(true);
    expect(() => decoder.finalize()).toThrow('Unread or corrupted data at end of input');
  });

  it('finalize throws on trailing padding appended to the input', () => {
    const encoder = new Encoder();
    encoder.write(true, { type: 'boolean' });
    const decoder = new Decoder(encoder.toString() + 'A');
    decoder.read({ type: 'boolean' });
    expect(() => decoder.finalize()).toThrow('Input is longer than its contents');
  });

  it('finalize throws when values remain unread', () => {
    const encoder = new Encoder();
    encoder.write([1, 2], NUM);
    const decoder = new Decoder(encoder.toString());
    decoder.read(NUM);
    expect(() => decoder.finalize()).toThrow('Unread or corrupted data at end of input');
  });
});
