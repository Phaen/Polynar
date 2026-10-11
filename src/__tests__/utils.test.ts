/**
 * The packer's helpers in packer/utils.ts, called directly at the edges of
 * their parameter types.
 */

import {
  Alphabet,
  bitLength,
  checksumOf,
  digitChunk,
  log2Exact,
  outputAlphabet,
  radixOf,
  stringAlphabet,
  validateBlockBits,
  validateChecksum,
} from '../packer/utils';
import type { Radix } from '../packer/types';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const radix = (n: number) => n as Radix;

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

describe('digitChunk', () => {
  it('spans the most digits that stay within 2^53', () => {
    expect(digitChunk(radix(2))).toEqual({
      size: 2,
      digits: 53,
      num: 2 ** 53,
      big: 2n ** 53n,
      bits: 53,
    });
    expect(digitChunk(radix(10))).toEqual({
      size: 10,
      digits: 15,
      num: 1e15,
      big: 10n ** 15n,
      bits: 0,
    });
    expect(digitChunk(radix(256))).toMatchObject({ digits: 6, num: 2 ** 48, bits: 48 });
    expect(digitChunk(radix(2 ** 52))).toMatchObject({ digits: 1, num: 2 ** 52, bits: 52 });
    expect(digitChunk(radix(MAX_SAFE))).toMatchObject({ digits: 1, num: MAX_SAFE, bits: 0 });
  });

  it('rejects base 1, whose digits hold nothing', () => {
    expect(() => digitChunk(radix(1))).toThrow(new RangeError('Digit base 1 is below 2'));
  });
});

describe('log2Exact', () => {
  it('names the exponent of a power of two', () => {
    for (let e = 0; e < 53; e++) {
      expect(log2Exact(radix(2 ** e))).toBe(e);
    }
  });

  it('answers -1 for any other radix, on both sides of 2^31', () => {
    for (const n of [3, 6, 1001, 2 ** 31 - 1, 2 ** 31 + 1, 3 * 2 ** 40, 2 ** 52 + 1, MAX_SAFE]) {
      expect(log2Exact(radix(n))).toBe(-1);
    }
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

describe('validateBlockBits', () => {
  it('defaults to 2048 and passes the span [128, 65536]', () => {
    expect(validateBlockBits()).toBe(2048);
    expect(validateBlockBits(undefined)).toBe(2048);
    for (const bits of [128, 129, 4096, 65536]) {
      expect(validateBlockBits(bits)).toBe(bits);
    }
  });

  it('rejects a size that is no integer with a TypeError', () => {
    for (const bits of [128.5, NaN, Infinity, -Infinity]) {
      expect(() => validateBlockBits(bits)).toThrow(
        new TypeError(`Block size must be an integer number of bits, got ${bits}`)
      );
    }
  });

  it('rejects an integer outside the span with a RangeError', () => {
    for (const bits of [0, -128, 127, 65537]) {
      expect(() => validateBlockBits(bits)).toThrow(
        new RangeError(`Block size ${bits} bits is outside [128, 65536]`)
      );
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
  const sum = (bits: number, value: bigint | number, rest: number[], length = rest.length + 7) =>
    checksumOf(bits, value, length, rest.length, (i) => rest[i]);

  it('is deterministic', () => {
    expect(sum(32, 123456789n, digits)).toBe(sum(32, 123456789n, digits));
  });

  it('differs when the value, a rest digit or the length changes', () => {
    const base = sum(32, 1000, digits);
    expect(sum(32, 1001, digits)).not.toBe(base);
    expect(sum(32, 1000, [3, 1, 4, 1, 6])).not.toBe(base);
    expect(sum(32, 1000, digits, digits.length + 8)).not.toBe(base);
  });

  it('separates values that differ only in the high bits of a high limb', () => {
    expect(sum(8, 1n << 100n, [])).not.toBe(sum(8, 1n << 101n, []));
  });

  it('stays below 2^bits', () => {
    for (const bits of [1, 8, 32]) {
      for (let v = 0; v < 50; v++) {
        const h = sum(bits, v * 7919, digits);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(2 ** bits);
      }
    }
  });

  it('hashes a Number and the same BigInt alike', () => {
    expect(sum(32, 123456, digits)).toBe(sum(32, 123456n, digits));
  });
});
