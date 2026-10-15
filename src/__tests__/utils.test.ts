/**
 * The packer's helpers in packer/utils.ts, called directly at the edges of
 * their parameter types.
 */

import {
  Alphabet,
  BIG_CHUNK_BITS,
  bigRadix,
  bitLength,
  checksumOf,
  COST_UNITS,
  costUnits,
  log2Units,
  outputAlphabet,
  radixOf,
  stringAlphabet,
  validateChecksum,
} from '../packer/utils';
import { ScaledRatio } from '../packer';
import { mulberry32 } from './support';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

describe('radixOf', () => {
  it('passes every integer in [1, 2^53)', () => {
    for (const value of [1, 2, 1001, MAX_SAFE]) {
      expect(radixOf(value, 'Radix')).toBe(value);
    }
  });

  it('rejects a value that is no integer with a TypeError naming it', () => {
    expect(() => radixOf(1.5, 'Radix')).toThrow(new TypeError('Radix must be an integer, got 1.5'));
    expect(() => radixOf(NaN, 'Total')).toThrow(new TypeError('Total must be an integer, got NaN'));
    expect(() => radixOf(Infinity, 'Radix')).toThrow(TypeError);
    expect(() => radixOf(-Infinity, 'Radix')).toThrow(TypeError);
  });

  it('rejects an integer outside [1, 2^53) with a RangeError', () => {
    expect(() => radixOf(0, 'Radix')).toThrow(
      new RangeError('Radix 0 is not a positive safe integer')
    );
    expect(() => radixOf(-3, 'Total')).toThrow(
      new RangeError('Total -3 is not a positive safe integer')
    );
    expect(() => radixOf(2 ** 53, 'Radix')).toThrow(RangeError);
  });
});

describe('bitLength', () => {
  it('counts the bits of the magnitude', () => {
    expect(bitLength(0n)).toBe(0);
    expect(bitLength(1n)).toBe(1);
    expect(bitLength(255n)).toBe(8);
    expect(bitLength(256n)).toBe(9);
    expect(bitLength(2n ** 1000n)).toBe(1001);
    expect(bitLength(2n ** 1000n - 1n)).toBe(1000);
  });

  it('gives a negative the length of its magnitude', () => {
    expect(bitLength(-1n)).toBe(1);
    expect(bitLength(-256n)).toBe(9);
    expect(bitLength(-(2n ** 64n))).toBe(65);
  });
});

describe('bigRadix', () => {
  const MAX = BigInt(Number.MAX_SAFE_INTEGER);

  it('keeps a safe radix whole', () => {
    expect(bigRadix(1n)).toEqual({ chunks: 0, top: 1 });
    expect(bigRadix(MAX)).toEqual({ chunks: 0, top: Number.MAX_SAFE_INTEGER });
  });

  it('splits off the fewest chunks that leave a safe top of at least 2^32', () => {
    expect(bigRadix(MAX + 1n)).toEqual({ chunks: 1, top: 2 ** 32 });
    expect(bigRadix(MAX + 2n)).toEqual({ chunks: 1, top: 2 ** 32 + 1 });
    // 2^74 − 1 tops at ceil(2^53 − 2^-21) = 2^53 with one chunk, one past
    // the safe integers, so it takes two.
    expect(bigRadix(2n ** 74n - 1n)).toEqual({ chunks: 2, top: 2 ** 32 });
  });

  it('lays every radix out within the bounds', () => {
    for (let bits = 54; bits < 400; bits += 7) {
      for (const radix of [
        2n ** BigInt(bits) - 1n,
        2n ** BigInt(bits),
        2n ** BigInt(bits) + 12345n,
      ]) {
        const { chunks, top } = bigRadix(radix);
        const shift = BigInt(BIG_CHUNK_BITS * chunks);
        expect(top).toBeGreaterThanOrEqual(2 ** 32);
        expect(top).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
        expect(BigInt(top)).toBe((radix + (1n << shift) - 1n) >> shift);
        // One chunk fewer would leave an unsafe top.
        const fewer = BigInt(BIG_CHUNK_BITS * (chunks - 1));
        expect((radix + (1n << fewer) - 1n) >> fewer > MAX).toBe(true);
      }
    }
  });
});

describe('Alphabet', () => {
  it('reads a string charset through a table, a map past code 4096, and a range by offset', () => {
    const table = new Alphabet('ab');
    const map = new Alphabet('a倀');
    const range = new Alphabet([0x4e00, 0x4e09]);
    expect([table.size, table.top, table.digitOf(98)]).toEqual([2, 98, 1]);
    expect([map.size, map.top, map.digitOf(0x5000)]).toEqual([2, 0x5000, 1]);
    expect([range.size, range.top, range.digitOf(0x4e09)]).toEqual([10, 0x4e09, 9]);
    expect(range.charset).toEqual([0x4e00, 0x4e09]);
  });

  it('copies a range rather than keeping the caller array', () => {
    const charset: [number, number] = [48, 57];
    const alphabet = new Alphabet(charset);
    charset[1] = 60;
    expect(alphabet.charset).toEqual([48, 57]);
  });

  it('holds one symbol only when its minimum size is one', () => {
    expect(new Alphabet('x', 1).size).toBe(1);
    expect(new Alphabet([7, 7], 1).size).toBe(1);
    expect(() => new Alphabet('x')).toThrow(
      new TypeError('Invalid character set: needs at least 2 characters, got 1')
    );
    expect(() => new Alphabet('', 1)).toThrow(
      new TypeError('Invalid character set: needs at least 1 character, got 0')
    );
    expect(() => new Alphabet([7, 7])).toThrow(
      new RangeError('Invalid character range: [7, 7] holds only one code')
    );
    expect(() => new Alphabet([8, 7], 1)).toThrow(
      new RangeError('Invalid character range: [8, 7] is empty')
    );
  });

  it('rejects repeated characters and halves of surrogate pairs', () => {
    expect(() => new Alphabet('aba')).toThrow(
      new TypeError('Invalid character set: "a" appears more than once')
    );
    expect(() => new Alphabet('a\ud800')).toThrow(
      new RangeError('Invalid character set: code 55296 at 1 is half of a surrogate pair')
    );
    expect(() => new Alphabet([0xd000, 0xd800])).toThrow(RangeError);
    expect(() => new Alphabet([0xdfff, 0xe000])).toThrow(RangeError);
  });

  it('rejects range endpoints that are not code units', () => {
    for (const range of [
      [-1, 5],
      [0, 65536],
      [0.5, 5],
      [0, 5.5],
      [NaN, 5],
      [0, Infinity],
    ] as [number, number][]) {
      expect(() => new Alphabet(range)).toThrow(
        new RangeError(
          `Invalid character range: [${range[0]}, ${range[1]}] must be integer codes within 0–65535`
        )
      );
    }
    expect(new Alphabet([0, 0xd7ff]).size).toBe(0xd800);
    expect(new Alphabet([0xe000, 65535]).top).toBe(65535);
  });

  it.each([
    ['table', new Alphabet('ab')],
    ['map', new Alphabet('a倀')],
    ['range', new Alphabet([97, 98])],
  ])('gives -1 for any number that is no code of the %s charset', (_kind, alphabet) => {
    expect(alphabet.digitOf(97)).toBe(0);
    for (const code of [-1, 0, 96, 99, 0x4fff, 0x5001, 65536, 97.5, NaN, Infinity, -Infinity]) {
      expect(alphabet.digitOf(code)).toBe(-1);
    }
  });

  it.each([
    ['string', new Alphabet('xyz'), [120, 122], ['x', 'z']],
    ['range', new Alphabet([250, 252]), [250, 252], ['ú', 'ü']],
  ] as const)(
    'spells the first and last digit of a %s charset',
    (_kind, alphabet, codes, chars) => {
      expect(alphabet.bytesOf([0, 2])).toEqual(Uint8Array.from(codes));
      expect([alphabet.charAt(0), alphabet.charAt(2)]).toEqual(chars);
    }
  );

  it('spells no digits as no bytes', () => {
    expect(new Alphabet('xyz').bytesOf([])).toEqual(new Uint8Array(0));
  });

  it('rejects bytes from a charset with codes past a byte', () => {
    expect(() => new Alphabet('aĀ').bytesOf([0])).toThrow(new RangeError('Code 256 is not a byte'));
    expect(() => new Alphabet([0x4e00, 0x4e02]).bytesOf([])).toThrow(RangeError);
    expect(new Alphabet([0x4e00, 0x4e02]).charAt(2)).toBe('丂');
  });

  it('rejects a digit outside [0, size) or no integer at all', () => {
    for (const alphabet of [new Alphabet('xyz'), new Alphabet([250, 252])]) {
      for (const spell of [
        (d: number) => alphabet.bytesOf([0, d]),
        (d: number) => alphabet.charAt(d),
      ]) {
        expect(() => spell(3)).toThrow(new RangeError('Digit 3 is outside [0, 3)'));
        expect(() => spell(-1)).toThrow(new RangeError('Digit -1 is outside [0, 3)'));
        expect(() => spell(2 ** 32)).toThrow(RangeError);
        expect(() => spell(1.5)).toThrow(new TypeError('Digit must be an integer, got 1.5'));
        expect(() => spell(NaN)).toThrow(new TypeError('Digit must be an integer, got NaN'));
        expect(() => spell(Infinity)).toThrow(TypeError);
      }
    }
  });
});

describe('stringAlphabet', () => {
  it('builds a charset once and hands back the same alphabet', () => {
    const alphabet = stringAlphabet('0123456789');
    expect(alphabet.size).toBe(10);
    expect(stringAlphabet('0123456789')).toBe(alphabet);
  });

  it('starts over once it holds 256 charsets', () => {
    const first = stringAlphabet('Āā');
    for (let i = 0; i < 256; i++) {
      stringAlphabet(String.fromCharCode(0x200 + i, 0x400 + i));
    }
    expect(stringAlphabet('Āā')).not.toBe(first);
  });

  it('rejects a charset of fewer than two characters', () => {
    expect(() => stringAlphabet('a')).toThrow(TypeError);
    expect(() => stringAlphabet('')).toThrow(TypeError);
  });
});

describe('outputAlphabet', () => {
  it('defaults to bytes for binary and Base64 for text', () => {
    const bytes = outputAlphabet('binary');
    expect([bytes.size, ...bytes.bytesOf([255])]).toEqual([256, 255]);
    expect(outputAlphabet('text').size).toBe(64);
  });

  it('takes any valid charset for text', () => {
    expect(outputAlphabet('text', '倀倁').size).toBe(2);
    expect(outputAlphabet('text', [0x4e00, 0x9fff]).size).toBe(0x5200);
  });

  it('takes byte codes only for binary', () => {
    expect(outputAlphabet('binary', [0, 255]).size).toBe(256);
    expect(outputAlphabet('binary', 'ab').size).toBe(2);
    expect(() => outputAlphabet('binary', 'aĀ')).toThrow(
      new RangeError('Character "Ā" (code 256) is not a byte, so binary output cannot use it')
    );
    expect(() => outputAlphabet('binary', [0, 256])).toThrow(
      new RangeError('Code 256 is not a byte, so binary output cannot use the range [0, 256]')
    );
  });

  it('needs two symbols in any form', () => {
    expect(() => outputAlphabet('text', 'a')).toThrow(TypeError);
    expect(() => outputAlphabet('binary', [5, 5])).toThrow(RangeError);
  });
});

describe('validateChecksum', () => {
  it('is 0 when omitted', () => {
    expect(validateChecksum(undefined)).toBe(0);
  });

  it('passes every integer in [1, 32]', () => {
    expect(validateChecksum(1)).toBe(1);
    expect(validateChecksum(32)).toBe(32);
  });

  it('rejects a width outside [1, 32] with a RangeError', () => {
    expect(() => validateChecksum(0)).toThrow(
      new RangeError('Checksum width 0 bits is outside [1, 32]')
    );
    expect(() => validateChecksum(33)).toThrow(
      new RangeError('Checksum width 33 bits is outside [1, 32]')
    );
  });

  it('rejects a width that is no integer with a TypeError', () => {
    expect(() => validateChecksum(1.5)).toThrow(
      new TypeError('Checksum width must be an integer number of bits, got 1.5')
    );
    expect(() => validateChecksum(NaN)).toThrow(TypeError);
  });
});

describe('checksumOf', () => {
  const digits = [3, 1, 4, 1, 5];
  const sum = (bits: number, value: bigint, rest: number[]) =>
    checksumOf(bits, value, rest.length, (i) => rest[i]);

  it('is deterministic', () => {
    expect(sum(32, 123456789n, digits)).toBe(sum(32, 123456789n, digits));
  });

  it('differs when the value, a rest digit or the digit count changes', () => {
    const base = sum(32, 1000n, digits);
    expect(sum(32, 1001n, digits)).not.toBe(base);
    expect(sum(32, 1000n, [3, 1, 4, 1, 6])).not.toBe(base);
    expect(sum(32, 1000n, [...digits, 0])).not.toBe(base);
  });

  it('separates values that differ only in the high bits of a high limb', () => {
    expect(sum(8, 1n << 100n, [])).not.toBe(sum(8, 1n << 101n, []));
  });

  it('stays below 2^bits', () => {
    for (const bits of [1, 8, 32]) {
      for (let v = 0; v < 50; v++) {
        const h = sum(bits, BigInt(v * 7919), digits);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(2 ** bits);
      }
    }
  });
});

describe('ScaledRatio', () => {
  it('starts at one and compares by exponent, then mantissa', () => {
    const one = new ScaledRatio();
    const other = new ScaledRatio();
    expect(one.exceeds(other)).toBe(false);
    other.multiply(3, 2);
    expect(other.exceeds(one)).toBe(true);
    expect(one.exceeds(other)).toBe(false);
    other.multiply(1, 3);
    expect(one.exceeds(other)).toBe(true);
  });

  it('keeps ratios far outside the double range apart', () => {
    const big = new ScaledRatio();
    const bigger = new ScaledRatio();
    for (let i = 0; i < 200; i++) {
      big.multiply(2 ** 52, 1);
      bigger.multiply(2 ** 52, 1);
    }
    expect(big.exceeds(bigger)).toBe(false);
    bigger.multiply(2, 1);
    expect(bigger.exceeds(big)).toBe(true);
    const tiny = new ScaledRatio();
    for (let i = 0; i < 200; i++) {
      tiny.multiply(1, 2 ** 52);
    }
    expect(new ScaledRatio().exceeds(tiny)).toBe(true);
    expect(tiny.exceeds(new ScaledRatio())).toBe(false);
  });

  /** A ratio of `num / den` taken `times` times. */
  const ratio = (num: number, den: number, times = 1): ScaledRatio => {
    const r = new ScaledRatio();
    for (let i = 0; i < times; i++) {
      r.multiply(num, den);
    }
    return r;
  };
  const same = (a: ScaledRatio, b: ScaledRatio): boolean => !a.exceeds(b) && !b.exceeds(a);

  it('multiplies and divides ratios into new ones, leaving both alone', () => {
    const one = new ScaledRatio();
    const a = ratio(3, 4);
    const b = ratio(5, 2);
    expect(same(a.times(one), a)).toBe(true);
    expect(same(one.times(a), a)).toBe(true);
    expect(same(a.over(one), a)).toBe(true);
    expect(same(a.over(a), one)).toBe(true);
    expect(same(a.times(b), ratio(15, 8))).toBe(true);
    expect(same(a.over(b), ratio(3, 10))).toBe(true);
    expect(same(b.over(a), ratio(10, 3))).toBe(true);
    expect(same(a, ratio(3, 4))).toBe(true);
    expect(same(b, ratio(5, 2))).toBe(true);
  });

  it('resets, multiplies and divides in place as times and over do', () => {
    const random = mulberry32(5);
    const into = ratio(7, 3);
    expect(into.reset()).toBe(into);
    expect(same(into, new ScaledRatio())).toBe(true);
    for (let i = 0; i < 200; i++) {
      const a = ratio(
        1 + Math.floor(random() * 2 ** 40),
        1 + Math.floor(random() * 2 ** 40),
        i % 30
      );
      const b = ratio(
        1 + Math.floor(random() * 2 ** 40),
        1 + Math.floor(random() * 2 ** 40),
        i % 7
      );
      expect(into.product(a, b)).toBe(into);
      expect(same(into, a.times(b))).toBe(true);
      expect(into.quotient(a, b)).toBe(into);
      expect(same(into, a.over(b))).toBe(true);
    }
  });

  it('multiplies and divides past the double range', () => {
    // Mantissas just under 2^512 multiply to just under 2^1024, still finite.
    const near = ratio(2 ** 52 - 1, 2 ** 52, 1)
      .times(ratio(2 ** 52, 1, 9))
      .times(ratio(2 ** 43, 1));
    const square = near.times(near);
    expect(square.exceeds(near)).toBe(true);
    expect(same(square.over(near), near)).toBe(true);
    const big = ratio(2 ** 52, 1, 30);
    const tiny = ratio(1, 2 ** 52, 30);
    expect(same(big.times(tiny), new ScaledRatio())).toBe(true);
    expect(same(big.times(big), ratio(2 ** 52, 1, 60))).toBe(true);
    expect(same(tiny.times(tiny), ratio(1, 2 ** 52, 60))).toBe(true);
    expect(same(new ScaledRatio().over(big), tiny)).toBe(true);
    expect(same(tiny.over(big), ratio(1, 2 ** 52, 60))).toBe(true);
    expect(same(big.over(tiny), ratio(2 ** 52, 1, 60))).toBe(true);
  });

  it('gives back a ratio multiplied then divided by another when the product is exact', () => {
    // Mantissas of at most 26 significant bits multiply exactly, and the
    // powers of two carry them past the double range either way.
    const random = mulberry32(17);
    for (let i = 0; i < 200; i++) {
      const x = 1 + Math.floor(random() * 2 ** 26);
      const y = 1 + Math.floor(random() * 2 ** 26);
      const a = ratio(x, 1).times(ratio(2 ** 52, 1, i % 40));
      const b = ratio(y, 1).times(ratio(1, 2 ** 52, i % 25));
      expect(same(a.times(b).over(b), a)).toBe(true);
      expect(same(b.times(a).over(a), b)).toBe(true);
    }
  });
});

describe('log2Units / costUnits', () => {
  const exact = (n: number): number => Math.round(Math.log2(n) * COST_UNITS);

  it('is log2 rounded to whole units below 4096', () => {
    for (let n = 1; n < 4096; n++) {
      expect(log2Units(n)).toBe(exact(n));
    }
  });

  it('reads the top 12 bits and counts the bits below them from 4096 to 2^32', () => {
    expect(log2Units(4096)).toBe(12 * COST_UNITS);
    expect(log2Units(4097)).toBe(log2Units(4096));
    expect(log2Units(6144)).toBe(log2Units(3072) + COST_UNITS);
    expect(log2Units(2 ** 31)).toBe(31 * COST_UNITS);
    expect(log2Units(2 ** 32 - 1)).toBe(log2Units(4095) + 20 * COST_UNITS);
  });

  it('stays within log2(1 + 2^-11) bits of the exact value', () => {
    const random = mulberry32(23);
    const slack = Math.log2(1 + 2 ** -11) * COST_UNITS + 1;
    for (let i = 0; i < 2000; i++) {
      // Spread over every magnitude, not only the largest.
      const n = Math.max(4096, Math.floor(2 ** (12 + random() * 20)));
      expect(Math.abs(log2Units(n) - Math.log2(n) * COST_UNITS)).toBeLessThanOrEqual(slack);
    }
  });

  it('is log2 rounded to whole units from 2^32', () => {
    expect(log2Units(2 ** 32)).toBe(32 * COST_UNITS);
    expect(log2Units(2 ** 40)).toBe(40 * COST_UNITS);
    expect(log2Units(MAX_SAFE)).toBe(exact(MAX_SAFE));
  });

  it('never decreases across the boundaries', () => {
    expect(log2Units(4096)).toBeGreaterThanOrEqual(log2Units(4095));
    expect(log2Units(2 ** 32)).toBeGreaterThanOrEqual(log2Units(2 ** 32 - 1));
  });

  it('costs a symbol owning all the states nothing and one of two a bit', () => {
    for (const n of [1, 7, 4096, 2 ** 32 + 5]) {
      expect(costUnits(n, n)).toBe(0);
    }
    expect(costUnits(1, 2)).toBe(COST_UNITS);
  });
});
