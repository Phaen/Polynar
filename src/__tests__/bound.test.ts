/**
 * The block bound's exact fallback. The bound runs as doubles once a block
 * holds a weighted symbol; these messages put its decisions within one unit
 * of a power of two, where only the exact recomputation can settle them, and
 * check that both sides still land on the canonical digits.
 *
 * A half-weight symbol out of four states leaves the bound at 3 with density
 * 2; n of them in a row leave it at 2^(n+1) - 1 with density 2^n, so a bit
 * after them has the candidate 2^(n+2) + 1 and a radix-(2^j - 1) slot the
 * candidate 2^(n+j) - 1: one above and one below a power of two.
 */

import { Encoder, Decoder, CorruptInputError } from '../index';

const BITS: [number, number] = [0, 1];

const half = (r: number): readonly [number, number, number] => (r < 2 ? [0, 0, 2] : [1, 2, 2]);

function encode(halves: number, bits: number, tail?: (enc: Encoder) => void): Uint8Array {
  const enc = new Encoder();
  for (let i = 0; i < halves; i++) {
    enc.composeWeighted(0, 2, 4, 0, 4);
  }
  for (let i = 0; i < bits; i++) {
    enc.compose(i & 1, 2);
  }
  tail?.(enc);
  return enc.toUint8Array(BITS);
}

function decode(
  bytes: Uint8Array,
  halves: number,
  bits: number,
  tail?: (dec: Decoder) => void
): void {
  const dec = new Decoder(bytes, BITS);
  for (let i = 0; i < halves; i++) {
    expect(dec.parseWeighted(4, half, 4)).toBe(0);
  }
  for (let i = 0; i < bits; i++) {
    expect(dec.parse(2)).toBe(i & 1);
  }
  tail?.(dec);
  dec.finalize();
}

describe('Block bound exact fallback', () => {
  it('sizes a final block whose digit bound sits one above a power of two', () => {
    // The digit bound after 100 bits is 2^101 + 1, which needs 102 digits.
    const bytes = encode(1, 100);
    expect(bytes.length).toBe(102);
    decode(bytes, 1, 100);
    expect(() => decode(new Uint8Array([...bytes, 0]), 1, 100)).toThrow(CorruptInputError);
    expect(() => decode(bytes.subarray(0, 101), 1, 100)).toThrow(CorruptInputError);
  });

  it('closes a block whose candidate exceeds the cap by one', () => {
    // After 2046 bits the next bit's candidate is 2^2048 + 1, just past the
    // 2048-bit cap, so the 2047th bit opens a second block.
    const bytes = encode(1, 2047);
    expect(bytes.length).toBe(2048 + 1);
    decode(bytes, 1, 2047);
    const oneLess = encode(1, 2046);
    expect(oneLess.length).toBe(2048);
    decode(oneLess, 1, 2046);
  });

  it('keeps a block whose candidate falls one short of the cap, then stays exact', () => {
    // 1995 halves and a radix-(2^53 - 1) slot reach exactly 2^2048 - 1.
    const wide = 2 ** 53 - 1;
    const full = encode(1995, 0, (enc) => enc.compose(wide - 1, wide));
    expect(full.length).toBe(2048);
    decode(full, 1995, 0, (dec) => expect(dec.parse(wide)).toBe(wide - 1));
    const over = encode(1995, 0, (enc) => {
      enc.compose(wide - 1, wide);
      enc.compose(1, 2);
    });
    expect(over.length).toBe(2048 + 1);
    decode(over, 1995, 0, (dec) => {
      expect(dec.parse(wide)).toBe(wide - 1);
      expect(dec.parse(2)).toBe(1);
    });
  });

  it('reads a final block whose digit bound sits one below a power of two', () => {
    // 60 halves and a radix-31 slot bound the block at 2^65 - 1: 65 digits,
    // with the slot's candidate one short of their state space.
    const bytes = encode(60, 0, (enc) => enc.compose(7, 31));
    expect(bytes.length).toBe(65);
    decode(bytes, 60, 0, (dec) => expect(dec.parse(31)).toBe(7));
    expect(() => decode(bytes.subarray(0, 64), 60, 0, (dec) => dec.parse(31))).toThrow(
      CorruptInputError
    );
  });

  it('writes a last symbol as its index when only its bucket form straddles a power of two', () => {
    // The last symbol's bucket candidate is 2^63 + 1 and its index candidate
    // 2^62 + 1: the index form saves a digit.
    const tailWrite = (enc: Encoder): void => enc.composeWeighted(0, 2, 4, 0, 2);
    const tailRead = (dec: Decoder): void => {
      expect(dec.parseWeighted(4, half, 2, (i) => [i, i * 2, 2])).toBe(0);
    };
    const bytes = encode(1, 60, tailWrite);
    expect(bytes.length).toBe(63);
    decode(bytes, 1, 60, tailRead);
    expect(() => decode(new Uint8Array([...bytes, 0]), 1, 60, tailRead)).toThrow(CorruptInputError);
  });

  it('reads an index whose candidate sits one below the digits it fits', () => {
    // After 60 halves a last symbol with 15 members out of 31 states has the
    // index candidate 2^64 - 1 against 64 digits of space.
    const bucket = (r: number): readonly [number, number, number] => [r, r, 1];
    const bytes = encode(60, 0, (enc) => enc.composeWeighted(3, 1, 31, 3, 15));
    expect(bytes.length).toBe(64);
    decode(bytes, 60, 0, (dec) => expect(dec.parseWeighted(31, bucket, 15, bucket)).toBe(3));
  });

  it('carries a uniform run past 2^256 into its first weighted symbol', () => {
    // 256 bits leave the bound at 2^256 when the half arrives; its candidate
    // is then exactly 2^258, the digit bound of the final block.
    const bytes = encode(0, 256, (enc) => enc.composeWeighted(0, 2, 4, 0, 4));
    expect(bytes.length).toBe(258);
    decode(bytes, 0, 256, (dec) => expect(dec.parseWeighted(4, half, 4)).toBe(0));
    expect(() =>
      decode(bytes.subarray(0, 257), 0, 256, (dec) => dec.parseWeighted(4, half, 4))
    ).toThrow(CorruptInputError);
  });
});
