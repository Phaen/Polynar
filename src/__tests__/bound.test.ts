/**
 * BlockBound, through the Encoder/Decoder that drive it: where a block ends,
 * how many digits a final block takes, and what a decoder rejects at those
 * boundaries. The exact regime as a reference for the faster ones is a
 * property in fuzz.test.ts.
 */

import { Encoder, Decoder, CorruptInputError, p } from '../index';
import { BlockBound, compareFloat, floatOf, powersOf, setExactOnly } from '../packer/bound';
import type { Base, Radix } from '../packer/types';

const R = (n: number) => n as Radix;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** A base-2 bound of 128-bit blocks, reset to `digits` digits, in the exact regime when `exact`. */
function bound2(digits = 128, exact = false): BlockBound {
  setExactOnly(exact);
  try {
    const bound = new BlockBound(2 as Base, 128);
    bound.reset(digits);
    return bound;
  } finally {
    setExactOnly(false);
  }
}

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

  it('settles a final tight bound one part in 2^50 above half the digit space', () => {
    // A two-in-(2^50 + 1) symbol leaves the digit bound at 2^50 + 1. A last
    // symbol of two states with one member keeps it as the tight bound while
    // its bucket candidate, 2^50 + 2^49 + 1/2, sets 51 digits. The tight
    // bound against half of them is too close for the float margins, so
    // finalize replays the block exactly, with the last symbol's one member
    // as its index candidate.
    const total = 2 ** 50 + 1;
    const head = (r: number): readonly [number, number, number] =>
      r < 2 ? [0, 0, 2] : [1, 2, total - 2];
    const tail = (r: number): readonly [number, number, number] => [r, r, 1];
    const enc = new Encoder();
    enc.composeWeighted(0, 2, total);
    enc.composeWeighted(0, 1, 2, { index: 0, count: 1 });
    const bytes = enc.output({ charset: BITS });
    expect(bytes.length).toBe(51);
    const read = (input: Uint8Array): void => {
      const dec = new Decoder(input, { charset: BITS });
      expect(dec.parseWeighted(total, head)).toBe(0);
      expect(dec.parseWeighted(2, tail, { count: 1, at: tail })).toBe(0);
      dec.finalize();
    };
    read(bytes);
    expect(() => read(Uint8Array.of(...bytes, 0))).toThrow(CorruptInputError);
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

describe('floatOf', () => {
  it('splits a positive BigInt into a mantissa below 2^256 and a multiple of 256', () => {
    expect(floatOf(1n)).toEqual([1, 0]);
    expect(floatOf(2n ** 255n)).toEqual([2 ** 255, 0]);
    expect(floatOf(2n ** 256n)).toEqual([1, 256]);
    expect(floatOf(3n * 2n ** 300n)).toEqual([3 * 2 ** 44, 256]);
  });

  it('truncates the bits past the top 53', () => {
    expect(floatOf(2n ** 60n + 1n)).toEqual([2 ** 60, 0]);
    expect(floatOf(2n ** 54n - 1n)).toEqual([2 ** 54 - 2, 0]);
  });

  it('rejects zero and negatives', () => {
    expect(() => floatOf(0n)).toThrow(new RangeError('Value 0 is not positive'));
    expect(() => floatOf(-5n)).toThrow(new RangeError('Value -5 is not positive'));
  });
});

describe('compareFloat', () => {
  it('decides by the margins within four scale steps', () => {
    expect(compareFloat(3, 0, 2, 0, 0)).toBe(1);
    expect(compareFloat(2, 0, 3, 0, 0)).toBe(-1);
    expect(compareFloat(1, 256, 2 ** 200, 0, 0)).toBe(1);
    expect(compareFloat(2 ** 200, 0, 1, 256, 0)).toBe(-1);
    expect(compareFloat(1, 768, 2 ** 255, 0, 0)).toBe(1);
  });

  it('answers 0 when the margins overlap', () => {
    expect(compareFloat(2, 0, 2, 0, 0)).toBe(0);
    expect(compareFloat(2 * (1 + 2 ** -50), 0, 2, 0, 4)).toBe(0);
    // Margins past one cover any pair.
    expect(compareFloat(3, 0, 2, 0, 2 ** 60)).toBe(0);
  });

  it('decides on the exponents alone four or more steps apart', () => {
    expect(compareFloat(2 ** -53, 1024, 2 ** 255, 0, 0)).toBe(1);
    expect(compareFloat(1, 10 * 256, 1, 0, 1000)).toBe(1);
    expect(compareFloat(2 ** 400, 0, 1, 1024, 0)).toBe(-1);
    expect(compareFloat(1, -10 * 256, 1, 0, 1000)).toBe(-1);
  });
});

describe('powersOf', () => {
  it('sizes a block to the most digits within 2^blockBits', () => {
    const two = powersOf(2, 128);
    expect([two.blockDigits, two.cap]).toEqual([128, 2n ** 128n]);
    expect(powersOf(3, 128).blockDigits).toBe(80);
    expect(powersOf(65536, 128).blockDigits).toBe(8);
    expect(powersOf(64).blockDigits).toBe(341);
  });

  it('keeps the powers exact and as constant floats', () => {
    const powers = powersOf(10, 128);
    powers.ensure(40);
    expect(powers.big[40]).toBe(10n ** 40n);
    expect(powers.m[40] * 2 ** powers.e[40]).toBeCloseTo(1e40, -26);
  });

  it('hands back the cached table, and a new one once evicted', () => {
    const first = powersOf(7, 256);
    expect(powersOf(7, 256)).toBe(first);
    expect(powersOf(7, 384)).not.toBe(first);
    for (let base = 100; base < 116; base++) {
      powersOf(base, 256);
    }
    expect(powersOf(7, 256)).not.toBe(first);
  });

  it('rejects a base that is no charset size', () => {
    for (const base of [0, 1, -2, 65537, MAX_SAFE]) {
      expect(() => powersOf(base)).toThrow(
        new RangeError(`Digit base ${base} is outside [2, 65536]`)
      );
    }
    for (const base of [2.5, NaN, Infinity]) {
      expect(() => powersOf(base)).toThrow(
        new TypeError(`Digit base must be an integer, got ${base}`)
      );
    }
  });

  it('rejects an invalid block size', () => {
    expect(() => powersOf(2, 127)).toThrow(RangeError);
    expect(() => powersOf(2, 65537)).toThrow(RangeError);
    expect(() => powersOf(2, 200.5)).toThrow(TypeError);
  });
});

describe('Powers.ensure', () => {
  it('extends the tables through the requested power, a fraction counting as its floor', () => {
    const powers = powersOf(5, 128);
    const length = powers.big.length;
    powers.ensure(length + 0.5);
    expect(powers.big.length).toBe(length + 1);
    expect(powers.big[length]).toBe(5n ** BigInt(length));
    expect(powers.m.length).toBe(powers.big.length);
  });

  it('leaves the tables alone for a power they hold, a negative or NaN', () => {
    const powers = powersOf(5, 128);
    const length = powers.big.length;
    for (const d of [0, length - 1, -1, -Infinity, NaN]) {
      powers.ensure(d);
    }
    expect(powers.big.length).toBe(length);
  });

  it('rejects Infinity, which no table reaches', () => {
    expect(() => powersOf(5, 128).ensure(Infinity)).toThrow(RangeError);
  });
});

describe('BlockBound', () => {
  it('starts a block of any digit count up to a full block', () => {
    const bound = bound2();
    bound.reset(0);
    expect(bound.exceedsCapacity(R(1))).toBe(false);
    expect(bound.exceedsCapacity(R(2))).toBe(true);
    bound.reset(1);
    expect(bound.exceedsCapacity(R(2))).toBe(false);
    expect(bound.exceedsCapacity(R(3))).toBe(true);
    bound.reset();
    expect(bound.exceedsCapacity(R(MAX_SAFE))).toBe(false);
  });

  it('rejects a digit count outside [0, blockDigits]', () => {
    const bound = bound2();
    expect(() => bound.reset(-1)).toThrow(new RangeError('Digit count -1 is outside [0, 128]'));
    expect(() => bound.reset(129)).toThrow(new RangeError('Digit count 129 is outside [0, 128]'));
    expect(() => bound.reset(1.5)).toThrow(
      new TypeError('Digit count must be an integer, got 1.5')
    );
    expect(() => bound.reset(NaN)).toThrow(TypeError);
  });

  it('judges the cap at the edges of the radix domain', () => {
    const bound = bound2();
    expect(bound.exceedsCap(R(1))).toBe(false);
    expect(bound.exceedsCap(R(2))).toBe(false);
    expect(bound.exceedsCap(R(MAX_SAFE))).toBe(false);
    bound.update(R(2 ** 52), R(1), R(2 ** 52));
    bound.update(R(2 ** 52), R(1), R(2 ** 52));
    expect(bound.exceedsCap(R(2 ** 24))).toBe(false);
    expect(bound.exceedsCap(R(2 ** 24 + 1))).toBe(true);
  });

  it('stays exact when updated without a cap check first', () => {
    // 1048577 · 1099510579201 = 2^60 + 1, which a double rounds to 2^60.
    for (const exact of [false, true]) {
      const bound = bound2(128, exact);
      bound.update(R(1048577), R(1), R(1048577));
      bound.update(R(1099510579201), R(1), R(1099510579201));
      expect(bound.digitsForS()).toBe(61);
    }
  });

  it('counts a member count above the total as the total, in every regime', () => {
    const answers = [false, true].map((exact) => {
      const bound = bound2(3, exact);
      bound.update(R(2), R(1), R(1000));
      const clamped = bound.tightFitsAnotherDigit();
      const reference = bound2(3, exact);
      reference.update(R(2), R(1), R(2));
      expect(clamped).toBe(reference.tightFitsAnotherDigit());
      return clamped;
    });
    expect(answers).toEqual([true, true]);

    const weighted = [false, true].map((exact) => {
      const bound = bound2(4, exact);
      bound.update(R(4), R(2), R(9));
      return bound.tightFitsAnotherDigit();
    });
    expect(weighted).toEqual([true, true]);
  });

  it('rejects a weight above its total', () => {
    expect(() => bound2().update(R(4), R(5), R(4))).toThrow(
      new RangeError('Frequency 5 exceeds total 4')
    );
  });

  it('checks the index form itself, a count past the total meaning the total', () => {
    const bound = bound2(1);
    expect(bound.indexExceedsCapacity(R(4), R(1))).toBe(false);
    expect(bound.indexExceedsCapacity(R(4), R(2))).toBe(false);
    expect(bound.indexExceedsCapacity(R(4), R(3))).toBe(true);
    expect(bound.indexExceedsCapacity(R(4), R(8))).toBe(true);
    expect(bound.indexExceedsCapacity(R(2), R(MAX_SAFE))).toBe(false);
    expect(bound2().indexExceedsCapacity(R(MAX_SAFE), R(MAX_SAFE))).toBe(false);
  });

  it('decides the index form with a count past the total as the bucket form', () => {
    for (const exact of [false, true]) {
      const bound = bound2(128, exact);
      bound.update(R(5), R(1), R(5));
      expect(bound.indexDecision(R(6), R(100))).toEqual(bound.indexDecision(R(6), R(6)));
      expect(bound.indexDecision(R(6), R(6)).indexed).toBe(false);
    }
  });

  it('folds nothing for a max below one, untouched', () => {
    for (const max of [0, 0.5, -1, -Infinity, NaN]) {
      const bound = bound2();
      expect(bound.fold(R(2), max)).toBe(0);
      expect(bound.digitsForS()).toBe(0);
      expect(bound.tightFitsAnotherDigit()).toBe(true);
    }
  });

  it('folds the floor of a fractional max, in each path', () => {
    const uniform = bound2();
    expect(uniform.fold(R(2), 2.5)).toBe(2);
    expect(uniform.digitsForS()).toBe(2);

    // Past 2^53 the uniform fold takes the rest as one power of the radix.
    const product = bound2();
    product.update(R(2 ** 40), R(1), R(2 ** 40));
    expect(product.fold(R(2 ** 20), 1.5)).toBe(1);
    expect(product.fold(R(2 ** 20), 2.5)).toBe(2);
    expect(product.digitsForS()).toBe(100);

    const weighted = bound2();
    weighted.update(R(4), R(2), R(4));
    expect(weighted.fold(R(2), 3.9)).toBe(3);
  });

  it('folds an unlimited run up to the digits', () => {
    const bits = bound2();
    expect(bits.fold(R(2), Infinity)).toBe(128);
    expect(bits.exceedsCap(R(2))).toBe(true);

    const large = bound2();
    expect(large.fold(R(2 ** 30), Infinity)).toBe(4);
    expect(large.digitsForS()).toBe(120);

    const largest = bound2();
    expect(largest.fold(R(MAX_SAFE), Infinity)).toBe(2);
  });

  it('rejects folding radix 1, which never fills the digits', () => {
    expect(() => bound2().fold(R(1), 5)).toThrow(new RangeError('Radix 1 carries nothing to fold'));
  });

  it('answers a fresh block: no digits, room for one', () => {
    const bound = bound2(2);
    expect(bound.digitsForS()).toBe(0);
    expect(bound.tightFitsAnotherDigit()).toBe(true);
    bound.reset(0);
    expect(bound.tightFitsAnotherDigit()).toBe(false);
  });
});

describe('setExactOnly', () => {
  it('starts every block in the exact regime, with the same answers', () => {
    const run = (exact: boolean) => {
      const bound = bound2(128, exact);
      bound.update(R(5), R(3), R(5));
      bound.update(R(1001), R(1), R(1001));
      return [bound.digitsForS(), bound.tightFitsAnotherDigit(), bound.exceedsCap(R(2 ** 52))];
    };
    expect(run(true)).toEqual(run(false));
  });
});
