/**
 * BlockBound, through the Encoder/Decoder that drive it: where a block ends,
 * how many digits a final block takes, and what a decoder rejects at those
 * boundaries. The exact regime as a reference for the faster ones is a
 * property in fuzz.test.ts.
 */

import { Encoder, Decoder, CorruptInputError, p } from '../index';
import { powersOf } from '../packer/bound';

/** Push `values` as base-1001 slots, the compact stand-in for real payloads. */
const composeAll = (encoder: Encoder, values: number[]): void => {
  for (const value of values) {
    encoder.compose(value, 1001);
  }
};

const parseAll = (decoder: Decoder, count: number): number[] =>
  Array.from({ length: count }, () => decoder.parse(1001));

const LONG = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 1001);

const BITS: [number, number] = [0, 1];

const half = (r: number): readonly [number, number, number] => (r < 2 ? [0, 0, 2] : [1, 2, 2]);

/** `halves` half-weight symbols out of four states, then `bits` alternating bits, then `tail`. */
function encodeHalves(halves: number, bits: number, tail?: (enc: Encoder) => void): Uint8Array {
  const enc = new Encoder();
  for (let i = 0; i < halves; i++) {
    enc.composeWeighted(0, 2, 4);
  }
  for (let i = 0; i < bits; i++) {
    enc.compose(i & 1, 2);
  }
  tail?.(enc);
  return enc.output({ charset: BITS });
}

function decodeHalves(
  bytes: Uint8Array,
  halves: number,
  bits: number,
  tail?: (dec: Decoder) => void
): void {
  const dec = new Decoder(bytes, { charset: BITS });
  for (let i = 0; i < halves; i++) {
    expect(dec.parseWeighted(4, half)).toBe(0);
  }
  for (let i = 0; i < bits; i++) {
    expect(dec.parse(2)).toBe(i & 1);
  }
  tail?.(dec);
  dec.finalize();
}

describe('Block packing', () => {
  // Large messages pack in blocks of at most 2048 bits by default, so the
  // big-number arithmetic stays linear in message size. Blocks are invisible
  // to reads; they cost at most one unfilled digit each at a boundary.

  it('packs power-of-two radices across blocks with zero waste', () => {
    // 4000 booleans hold exactly 4000 bits; base-2 slots divide the 2048-bit
    // block cap evenly, so no boundary digit goes unfilled: 500 bytes even.
    const encoder = new Encoder();
    for (let i = 0; i < 4000; i++) {
      encoder.compose(i % 3 === 0 ? 1 : 0, 2);
    }
    expect(encoder.output().length).toBe(500);
  });

  it('throws on a digit corrupted past a block boundary', () => {
    const encoder = new Encoder();
    composeAll(encoder, LONG);
    const str = encoder.output({ type: 'text' });
    // The first block's highest digit is bumped to the charset maximum: the
    // block value then exceeds its radix product, and the boundary check
    // rejects the remainder the encoder never leaves there.
    const top = powersOf(64).blockDigits - 1;
    const decoder = new Decoder(str.slice(0, top) + '/' + str.slice(top + 1));
    expect(() => parseAll(decoder, LONG.length)).toThrow('Oversaturated input');
  });

  it('throws when a multi-block message is truncated', () => {
    const encoder = new Encoder();
    composeAll(encoder, LONG);
    const decoder = new Decoder(encoder.output({ type: 'text' }).slice(0, -5));
    // A cut-off tail is indistinguishable from corrupted high digits, so
    // either diagnosis may surface.
    expect(() => parseAll(decoder, LONG.length)).toThrow();
  });

  it('finalize throws on padding appended to a multi-block message', () => {
    const encoder = new Encoder();
    composeAll(encoder, LONG);
    const decoder = new Decoder(encoder.output({ type: 'text' }) + 'AA');
    parseAll(decoder, LONG.length);
    expect(() => decoder.finalize()).toThrow('Input is longer than its contents');
  });

  it('throws when a multi-block message is cut exactly at a block boundary', () => {
    const encoder = new Encoder();
    composeAll(encoder, LONG);
    const decoder = new Decoder(
      encoder.output({ type: 'text' }).slice(0, powersOf(64).blockDigits)
    );
    expect(() => parseAll(decoder, LONG.length)).toThrow('Unexpected end of input while parsing');
  });

  it('throws when a full block is cut to the digits its own values need', () => {
    // 2047 bits leave the 2048-bit block one digit of slack, so a trit opens
    // the next block; cut to 2047 digits, the bits still read and the trit
    // finds no next block.
    const encoder = new Encoder();
    for (let i = 0; i < 2047; i++) {
      encoder.compose(i & 1, 2);
    }
    encoder.compose(2, 3);
    const bytes = encoder.output({ charset: BITS });
    expect(bytes.length).toBe(2048 + 2);
    const decoder = new Decoder(bytes.subarray(0, 2047), { charset: BITS });
    for (let i = 0; i < 2047; i++) {
      decoder.parse(2);
    }
    expect(() => decoder.parse(3)).toThrow('Unexpected end of input while parsing');
  });

  // The block bound runs as doubles once a block holds a weighted symbol.
  // The messages below put its decisions within one unit of a power of two,
  // where only the exact recomputation can settle them. A half-weight symbol
  // out of four states leaves the bound at 3 with density 2; n of them in a
  // row leave it at 2^(n+1) - 1 with density 2^n, so a bit after them has the
  // candidate 2^(n+2) + 1 and a radix-(2^j - 1) slot the candidate
  // 2^(n+j) - 1: one above and one below a power of two.

  it('sizes a final block whose digit bound sits one above a power of two', () => {
    // The digit bound after 100 bits is 2^101 + 1, which needs 102 digits.
    const bytes = encodeHalves(1, 100);
    expect(bytes.length).toBe(102);
    decodeHalves(bytes, 1, 100);
    expect(() => decodeHalves(Uint8Array.of(...bytes, 0), 1, 100)).toThrow(CorruptInputError);
    expect(() => decodeHalves(bytes.subarray(0, 101), 1, 100)).toThrow(CorruptInputError);
  });

  it('closes a block whose candidate exceeds the cap by one', () => {
    // After 2046 bits the next bit's candidate is 2^2048 + 1, just past the
    // 2048-bit cap, so the 2047th bit opens a second block.
    const bytes = encodeHalves(1, 2047);
    expect(bytes.length).toBe(2048 + 1);
    decodeHalves(bytes, 1, 2047);
    const oneLess = encodeHalves(1, 2046);
    expect(oneLess.length).toBe(2048);
    decodeHalves(oneLess, 1, 2046);
  });

  it('keeps a block whose candidate falls one short of the cap, then stays exact', () => {
    // 1995 halves and a radix-(2^53 - 1) slot reach exactly 2^2048 - 1.
    const wide = 2 ** 53 - 1;
    const full = encodeHalves(1995, 0, (enc) => enc.compose(wide - 1, wide));
    expect(full.length).toBe(2048);
    decodeHalves(full, 1995, 0, (dec) => expect(dec.parse(wide)).toBe(wide - 1));
    const over = encodeHalves(1995, 0, (enc) => {
      enc.compose(wide - 1, wide);
      enc.compose(1, 2);
    });
    expect(over.length).toBe(2048 + 1);
    decodeHalves(over, 1995, 0, (dec) => {
      expect(dec.parse(wide)).toBe(wide - 1);
      expect(dec.parse(2)).toBe(1);
    });
  });

  it('reads a final block whose digit bound sits one below a power of two', () => {
    // 60 halves and a radix-31 slot bound the block at 2^65 - 1: 65 digits,
    // with the slot's candidate one short of their state space.
    const bytes = encodeHalves(60, 0, (enc) => enc.compose(7, 31));
    expect(bytes.length).toBe(65);
    decodeHalves(bytes, 60, 0, (dec) => expect(dec.parse(31)).toBe(7));
    expect(() => decodeHalves(bytes.subarray(0, 64), 60, 0, (dec) => dec.parse(31))).toThrow(
      CorruptInputError
    );
  });

  it('writes a last symbol as its index when only its bucket form straddles a power of two', () => {
    // The last symbol's bucket candidate is 2^63 + 1 and its index candidate
    // 2^62 + 1: the index form saves a digit.
    const tailWrite = (enc: Encoder): void => enc.composeWeighted(0, 2, 4, { index: 0, count: 2 });
    const tailRead = (dec: Decoder): void => {
      expect(dec.parseWeighted(4, half, { count: 2, at: (i) => [i, i * 2, 2] })).toBe(0);
    };
    const bytes = encodeHalves(1, 60, tailWrite);
    expect(bytes.length).toBe(63);
    decodeHalves(bytes, 1, 60, tailRead);
    expect(() => decodeHalves(Uint8Array.of(...bytes, 0), 1, 60, tailRead)).toThrow(
      CorruptInputError
    );
  });

  it('reads an index whose candidate sits one below the digits it fits', () => {
    // After 60 halves a last symbol with 15 members out of 31 states has the
    // index candidate 2^64 - 1 against 64 digits of space.
    const bucket = (r: number): readonly [number, number, number] => [r, r, 1];
    const bytes = encodeHalves(60, 0, (enc) =>
      enc.composeWeighted(3, 1, 31, { index: 3, count: 15 })
    );
    expect(bytes.length).toBe(64);
    decodeHalves(bytes, 60, 0, (dec) =>
      expect(dec.parseWeighted(31, bucket, { count: 15, at: bucket })).toBe(3)
    );
  });

  it('carries a uniform run past 2^256 into its first weighted symbol', () => {
    // 256 bits leave the bound at 2^256 when the half arrives; its candidate
    // is then exactly 2^258, the digit bound of the final block.
    const bytes = encodeHalves(0, 256, (enc) => enc.composeWeighted(0, 2, 4));
    expect(bytes.length).toBe(258);
    decodeHalves(bytes, 0, 256, (dec) => expect(dec.parseWeighted(4, half)).toBe(0));
    expect(() =>
      decodeHalves(bytes.subarray(0, 257), 0, 256, (dec) => dec.parseWeighted(4, half))
    ).toThrow(CorruptInputError);
  });

  it('keeps full precision for bounds a few bits past a scale step', () => {
    // The block's bound sits a few bits past a 256-bit scale step, where the
    // float regime's precision is thinnest.
    const Msg = p.object({ flag: p.bool().weights([1, 3]), data: p.binary().length(32) });
    const value = { flag: false, data: new Uint8Array(32) };
    const text = Msg.encode(value, { type: 'text', charset: '012' });
    expect(Msg.decode(text, { charset: '012' })).toEqual(value);
  });
});
