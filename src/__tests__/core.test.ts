/**
 * Packer primitives — Encoder/Decoder construction, charsets, compose/parse,
 * block packing, output density, and the corruption-detection surface. Typed
 * behaviour lives in nodes.test.ts; this file exercises the layer custom
 * nodes build on.
 */

import { Encoder, Decoder, CharSets, CorruptInputError, p, PNode } from '../index';
import * as root from '../index';
import { powersOf } from '../packer/bound';

/** Push `values` as base-1001 slots — the compact stand-in for real payloads. */
const composeAll = (encoder: Encoder, values: number[]): void => {
  for (const value of values) {
    encoder.compose(value, 1001);
  }
};

const parseAll = (decoder: Decoder, count: number): number[] =>
  Array.from({ length: count }, () => decoder.parse(1001));

describe('Character sets', () => {
  it.each(Object.entries(CharSets))('round-trips through the %s charset', (_name, charset) => {
    const encoder = new Encoder();
    encoder.compose(123, 1001);
    const decoder = new Decoder(encoder.output({ type: 'text', charset }), { charset });
    expect(decoder.parse(1001)).toBe(123);
  });

  it('uses Base64 as the default charset on both ends', () => {
    const encoder = new Encoder();
    encoder.compose(123, 1001);
    // No charset on either side → both default to Base64.
    expect(new Decoder(encoder.output({ type: 'text' })).parse(1001)).toBe(123);
  });

  it('round-trips through a binary-range charset', () => {
    const encoder = new Encoder();
    encoder.compose(123, 1001);
    const range: [number, number] = [65, 90];
    expect(
      new Decoder(encoder.output({ type: 'text', charset: range }), { charset: range }).parse(1001)
    ).toBe(123);
  });

  it('rejects a reversed range charset, like a reversed byte range', () => {
    const encoder = new Encoder();
    encoder.compose(123, 1001);
    expect(() => encoder.output({ type: 'text', charset: [90, 65] })).toThrow(
      new RangeError('Invalid character range: [90, 65] is empty')
    );
    expect(() => new Decoder('A', { charset: [90, 65] })).toThrow(RangeError);
  });
});

describe('Low-level primitives', () => {
  it('compose/parse round-trips a fixed-radix integer', () => {
    const encoder = new Encoder();
    encoder.compose(3, 10);
    encoder.compose(7, 10);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    expect(decoder.parse(10)).toBe(3);
    expect(decoder.parse(10)).toBe(7);
  });

  it('composeTerm/parseTerm round-trips an unbounded integer', () => {
    const encoder = new Encoder();
    encoder.composeTerm(0);
    encoder.composeTerm(12345);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    expect(decoder.parseTerm()).toBe(0);
    expect(decoder.parseTerm()).toBe(12345);
  });

  it('composeTerm/parseTerm round-trips terms above 2^53 bit-exact', () => {
    // The digits travel through BigInt on both ends; float division here
    // rounds and would silently land on a neighbouring integer.
    const encoder = new Encoder();
    encoder.composeTerm(18014398509481988);
    encoder.composeTerm(1e300);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    expect(decoder.parseTerm()).toBe(18014398509481988);
    expect(decoder.parseTerm()).toBe(1e300);
  });

  it('composeTerm/parseTerm round-trips across the inline/escaped boundary', () => {
    // Values below 3^21 ride as inline digit runs; from 3^21 up they escape
    // to the length-prefixed form. Both sides of the edge must agree.
    const edge = 3 ** 21;
    const encoder = new Encoder();
    encoder.composeTerm(edge - 1);
    encoder.composeTerm(edge);
    encoder.composeTerm(edge + 1);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    expect(decoder.parseTerm()).toBe(edge - 1);
    expect(decoder.parseTerm()).toBe(edge);
    expect(decoder.parseTerm()).toBe(edge + 1);
  });

  it('large terms cost little more than their information content', () => {
    // 1e300 is ~997 bits of information. The escaped form carries it in
    // ~1016 bits; the pure base-3 run would need ~1260.
    const encoder = new Encoder();
    encoder.composeTerm(1e300);
    expect(encoder.output().length).toBeLessThanOrEqual(128);
  });

  it('folds radices whose product rounds to exactly 2^53 as doubles', () => {
    // 3002399751580331 · 3 = 2^53 + 1, which a double rounds to 2^53.
    const radices = [3002399751580331, 3, 2 ** 52];
    const enc = new Encoder();
    for (const radix of radices) {
      enc.compose(1, radix);
    }
    const bytes = enc.output();
    const dec = new Decoder(bytes);
    expect(radices.map((radix) => dec.parse(radix))).toEqual([1, 1, 1]);
    dec.finalize();
  });

  it('rejects a compose integer outside its radix', () => {
    const encoder = new Encoder();
    expect(() => encoder.compose(10, 10)).toThrow(RangeError);
    expect(() => encoder.compose(-1, 10)).toThrow(RangeError);
    expect(() => encoder.compose(1.5, 10)).toThrow(
      new TypeError('Digit must be an integer, got 1.5')
    );
    expect(() => encoder.compose(10, 10)).toThrow('Digit 10 is outside [0, 10)');
  });

  it('rejects an invalid compose radix', () => {
    const encoder = new Encoder();
    expect(() => encoder.compose(0, 0)).toThrow(
      new RangeError('Radix 0 is not a positive safe integer')
    );
    expect(() => encoder.compose(0, 2.5)).toThrow(
      new TypeError('Radix must be an integer, got 2.5')
    );
  });

  it('rejects a negative or fractional composeTerm term', () => {
    const encoder = new Encoder();
    expect(() => encoder.composeTerm(-1)).toThrow(new RangeError('Term -1 is negative'));
    expect(() => encoder.composeTerm(1.5)).toThrow(
      new TypeError('Term must be an integer, got 1.5')
    );
  });
  it('parseWeighted rejects a locate that misses the residual', () => {
    const encoder = new Encoder();
    encoder.composeWeighted(0, 1, 2);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    expect(() => decoder.parseWeighted(2, () => [0, 0, 0] as const)).toThrow(
      'locate returned a bucket that does not contain the residual: [0, 0) for 0'
    );
  });
});

describe('Shared buffers', () => {
  it('nodes compose onto one encoder and read back in write order', () => {
    // `encode` is one node per message; several nodes can share a buffer by
    // driving the primitives directly, as a custom composite node would.
    const age = p.int().min(0).max(100);
    const name = p.string().max(10);
    const active = p.bool();

    const encoder = new Encoder();
    age._write(encoder, 42);
    name._write(encoder, 'hello');
    active._write(encoder, true);

    const decoder = new Decoder(encoder.output({ type: 'text' }));
    expect(age._read(decoder)).toBe(42);
    expect(name._read(decoder)).toBe('hello');
    expect(active._read(decoder)).toBe(true);
    expect(() => decoder.finalize()).not.toThrow();
  });

  it('a custom PNode subclass composes with the built-in combinators', () => {
    // The extension surface: implement _write/_read against the primitives
    // and the node nests inside p.object / p.array like any built-in.
    class PRgb extends PNode<[number, number, number]> {
      _write(enc: Encoder, value: [number, number, number]): void {
        for (const channel of value) {
          enc.compose(channel, 256);
        }
      }
      _read(dec: Decoder): [number, number, number] {
        return [dec.parse(256), dec.parse(256), dec.parse(256)];
      }
    }

    const Palette = p.object({ name: p.string().max(10), colors: p.array(new PRgb()) });
    const value = {
      name: 'sunset',
      colors: [
        [255, 94, 0],
        [255, 195, 113],
      ] as [number, number, number][],
    };
    expect(Palette.decode(Palette.encode(value))).toEqual(value);
  });
});

describe('Output density', () => {
  it('packs to the information-theoretic minimum length', () => {
    // Four base-1001 slots span 1001^4 ≈ 1.004e12 states. That needs 5 bytes
    // (256^5 ≈ 1.100e12) and 7 Base64 chars (64^7 ≈ 4.398e12; 6 are too few).
    const encoder = new Encoder();
    composeAll(encoder, [1000, 0, 999, 1]);
    expect(encoder.output().length).toBe(5);
    expect(encoder.output({ type: 'text' }).length).toBe(7);

    const decoder = new Decoder(encoder.output());
    expect(parseAll(decoder, 4)).toEqual([1000, 0, 999, 1]);
  });

  it('packs 40 booleans into exactly 40 bits', () => {
    // No byte boundary rounds a partially-filled slot up on its own; only the
    // whole message rounds, once, to 5 bytes.
    const encoder = new Encoder();
    for (let i = 0; i < 40; i++) {
      encoder.compose(i % 3 === 0 ? 1 : 0, 2);
    }
    expect(encoder.output().length).toBe(5);
  });

  it('produces empty output for an empty encoder', () => {
    const encoder = new Encoder();
    expect(encoder.output({ type: 'text' })).toBe('');
    expect(encoder.output().length).toBe(0);
    encoder.compose(123, 1001);
    expect(encoder.output({ type: 'text' })).toBe('7B');
    expect(encoder.output({ type: 'text', charset: CharSets.Base64 })).toBe('7B');
    expect(new Decoder('7B').parse(1001)).toBe(123);
  });

  it('spells text in a range charset', () => {
    const encoder = new Encoder();
    encoder.compose(123, 1001);
    expect(encoder.output({ type: 'text', charset: [0x4e00, 0x9fff] })).toBe('乻');
  });
});

describe('Charset validation', () => {
  it('rejects a duplicate-character charset', () => {
    expect(() => new Decoder('test', { charset: 'aab' })).toThrow(
      new TypeError("Invalid character set: 'a' appears more than once")
    );
  });

  it('rejects a duplicate-character charset even across a newline', () => {
    expect(() => new Decoder('test', { charset: 'ab\ncd\na' })).toThrow('Invalid character set');
  });

  it('rejects a charset of fewer than two characters', () => {
    // Base 1 has no digit variation: the encoder's digit loop would push until
    // the array overflows and the decoder would misparse every read.
    expect(() => new Encoder().output({ type: 'text', charset: 'a' })).toThrow(
      'Invalid character set: needs at least 2 characters, got 1'
    );
    expect(() => new Decoder('aaa', { charset: 'a' })).toThrow('Invalid character set');
  });

  it('accepts a two-symbol range charset, the floor shared with string charsets', () => {
    const encoder = new Encoder();
    encoder.compose(123, 1001);
    const range: [number, number] = [48, 49];
    expect(
      new Decoder(encoder.output({ type: 'text', charset: range }), { charset: range }).parse(1001)
    ).toBe(123);
  });

  it('rejects a single-symbol range charset', () => {
    // Base 1, same as the one-character string charset.
    expect(() => new Decoder('test', { charset: [5, 5] })).toThrow(
      'Invalid character range: [5, 5] holds only one code'
    );
  });

  it('rejects a range charset outside the UTF-16 code-unit space', () => {
    // String.fromCharCode truncates modulo 2^16, so such digits would decode
    // back as different in-range values without any error.
    const encoder = new Encoder();
    encoder.compose(123, 1001);
    expect(() => encoder.output({ type: 'text', charset: [0, 100000] })).toThrow(
      'Invalid character range: [0, 100000] must be integer codes within 0–65535'
    );
    expect(() => encoder.output({ type: 'text', charset: [-5, 100] })).toThrow(
      'Invalid character range'
    );
    expect(() => encoder.output({ type: 'text', charset: [0.5, 100.5] })).toThrow(
      'Invalid character range'
    );
  });

  it('throws when a character is absent from the charset', () => {
    expect(() => new Decoder('!', { charset: CharSets.digit })).toThrow(/is not in the charset/);
  });

  it('reads ASCII digits that sit past index 32767 of a long charset', () => {
    const charset = Array.from({ length: 65536 }, (_, i) => String.fromCharCode(65535 - i)).join(
      ''
    );
    const enc = new Encoder();
    enc.compose(65535, 65536);
    enc.compose(65, 65536);
    const dec = new Decoder(enc.output({ type: 'text', charset }), { charset });
    expect([dec.parse(65536), dec.parse(65536)]).toEqual([65535, 65]);
    dec.finalize();
  });

  it('rejects a character absent from a charset of high code units', () => {
    expect(() => new Decoder('a', { charset: '一丁' })).toThrow(
      'Character at 0 is not in the charset'
    );
  });

  it('keeps validating past the charsets it remembers', () => {
    // Validated charsets are remembered, up to a bound; a long stream of
    // distinct ones keeps being checked and keeps round-tripping.
    for (let i = 0; i < 300; i++) {
      const charset = String.fromCharCode(0x100 + i, 0x1000 + i, 0x2000 + i);
      const encoder = new Encoder();
      encoder.compose(i % 7, 7);
      expect(new Decoder(encoder.output({ type: 'text', charset }), { charset }).parse(7)).toBe(
        i % 7
      );
    }
    expect(() => new Decoder('aa', { charset: 'aa' })).toThrow('Invalid character set');
  });

  it('throws when a character falls just past a range charset', () => {
    // '[' (code 91) is one beyond the maximum of the [65, 90] range.
    expect(() => new Decoder('Z[', { charset: [65, 90] }).parse(1001)).toThrow(
      'Character at 1 is not in the charset'
    );
  });
});

describe('Input exhaustion', () => {
  it('throws when input ends mid-parse', () => {
    const encoder = new Encoder();
    encoder.compose(5, 1001);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    decoder.parse(1001);
    expect(() => decoder.parse(1001)).toThrow('Unexpected end of input while parsing');
  });

  it('throws when reading from empty input', () => {
    expect(() => new Decoder('').parse(1001)).toThrow('Unexpected end of input while parsing');
  });
});

describe('Block packing', () => {
  // Large messages pack in ~2048-bit blocks so the big-number arithmetic
  // stays linear in message size. Blocks are invisible to reads; they only
  // cost at most one unfilled digit each at a boundary.

  it('round-trips a message spanning many blocks', () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 1001);
    const encoder = new Encoder();
    composeAll(encoder, values);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    expect(parseAll(decoder, 3000)).toEqual(values);
    expect(() => decoder.finalize()).not.toThrow();
  });

  it('round-trips a multi-block byte payload', () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i * 31) % 1001);
    const encoder = new Encoder();
    composeAll(encoder, values);
    const decoder = new Decoder(encoder.output());
    expect(parseAll(decoder, 3000)).toEqual(values);
    expect(() => decoder.finalize()).not.toThrow();
  });

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
    const values = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 1001);
    const encoder = new Encoder();
    composeAll(encoder, values);
    const str = encoder.output({ type: 'text' });
    // The first block's highest digit is bumped to the charset maximum: the block
    // value then exceeds its radix product, and the boundary check rejects the
    // remainder the encoder guarantees is never there.
    const top = powersOf(64).blockDigits - 1;
    const decoder = new Decoder(str.slice(0, top) + '/' + str.slice(top + 1));
    expect(() => parseAll(decoder, 3000)).toThrow('Oversaturated input');
  });

  it('throws when a multi-block message is truncated', () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 1001);
    const encoder = new Encoder();
    composeAll(encoder, values);
    const decoder = new Decoder(encoder.output({ type: 'text' }).slice(0, -5));
    // A cut-off tail is indistinguishable from corrupted high digits, so either
    // diagnosis may surface — reading must fail one way or the other.
    expect(() => parseAll(decoder, 3000)).toThrow();
  });

  it('finalize throws on padding appended to a multi-block message', () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 1001);
    const encoder = new Encoder();
    composeAll(encoder, values);
    const decoder = new Decoder(encoder.output({ type: 'text' }) + 'AA');
    parseAll(decoder, 3000);
    expect(() => decoder.finalize()).toThrow('Input is longer than its contents');
  });
  it('throws when a multi-block message is cut exactly at a block boundary', () => {
    const encoder = new Encoder();
    composeAll(
      encoder,
      Array.from({ length: 3000 }, (_, i) => (i * 7919) % 1001)
    );
    const decoder = new Decoder(
      encoder.output({ type: 'text' }).slice(0, powersOf(64).blockDigits)
    );
    expect(() => parseAll(decoder, 3000)).toThrow('Unexpected end of input while parsing');
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
    const bytes = encoder.output({ charset: [0, 1] });
    expect(bytes.length).toBe(2048 + 2);
    const decoder = new Decoder(bytes.subarray(0, 2047), { charset: [0, 1] });
    for (let i = 0; i < 2047; i++) {
      decoder.parse(2);
    }
    expect(() => decoder.parse(3)).toThrow('Unexpected end of input while parsing');
  });
});

describe('Corruption detection', () => {
  it('rejects a corrupted digit that oversaturates the input', () => {
    // Two radix-50 values nearly fill two Base64 chars (2500 of 4096 states).
    // A weighted symbol may legitimately leave value inside the last doubling
    // of state space, so the leftover is only provably corrupt once the
    // message ends: finalize rejects it.
    const encoder = new Encoder();
    encoder.compose(10, 50);
    encoder.compose(20, 50);
    const str = encoder.output({ type: 'text' });
    expect(str).toHaveLength(2);
    const decoder = new Decoder(str.slice(0, -1) + '/');
    decoder.parse(50);
    decoder.parse(50);
    expect(() => decoder.finalize()).toThrow('Unread or corrupted data at end of input');
  });

  it('finalize accepts a fully-read canonical input', () => {
    const encoder = new Encoder();
    encoder.compose(5, 1001);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    decoder.parse(1001);
    expect(() => decoder.finalize()).not.toThrow();
  });

  it('finalize accepts an empty input with no reads', () => {
    expect(() => new Decoder('').finalize()).not.toThrow();
  });

  it('finalize throws on a corrupted digit the reads alone cannot see', () => {
    // A boolean spans 2 of the 64 states its single Base64 char holds; bumping
    // the char leaves a remainder invisible to the read (which still returns a
    // valid boolean) but caught by the leftover-value check.
    const encoder = new Encoder();
    encoder.compose(1, 2);
    expect(encoder.output({ type: 'text' })).toBe('B');
    const decoder = new Decoder('D');
    expect(decoder.parse(2)).toBe(1);
    expect(() => decoder.finalize()).toThrow('Unread or corrupted data at end of input');
  });

  it('finalize throws on trailing padding appended to the input', () => {
    const encoder = new Encoder();
    encoder.compose(1, 2);
    const decoder = new Decoder(encoder.output({ type: 'text' }) + 'A');
    decoder.parse(2);
    expect(() => decoder.finalize()).toThrow('Input is longer than its contents');
  });

  it('finalize throws when values remain unread', () => {
    const encoder = new Encoder();
    encoder.compose(1, 1001);
    encoder.compose(2, 1001);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    decoder.parse(1001);
    expect(() => decoder.finalize()).toThrow('Unread or corrupted data at end of input');
  });

  it('rejects a term run padded with a zero top digit', () => {
    // Digit symbols are d+1, so symbol 1 is a zero digit; on top of a run it
    // adds nothing but length, and the encoder never emits it there.
    const encoder = new Encoder();
    encoder.compose(2, 5); // first slot: digit 1
    encoder.compose(1, 4); // zero digit on top
    encoder.compose(0, 4); // terminator
    expect(() => new Decoder(encoder.output({ type: 'text' })).parseTerm()).toThrow(
      CorruptInputError
    );
  });

  it('rejects a term run longer than any canonical value needs', () => {
    // Inline runs hold at most 21 digits (values below 3^21); a longer run
    // is corruption, and rejecting it early keeps the arithmetic exact.
    const encoder = new Encoder();
    encoder.compose(2, 5);
    for (let i = 0; i < 21; i++) {
      encoder.compose(2, 4);
    }
    encoder.compose(0, 4);
    expect(() => new Decoder(encoder.output({ type: 'text' })).parseTerm()).toThrow(
      'longer than its canonical maximum'
    );
  });

  it('rejects an escaped term that belongs in the inline range', () => {
    // The escape exists for values >= 3^21; a small value behind it is a
    // second spelling of an inline-encodable number, so it must not decode.
    const encoder = new Encoder();
    encoder.compose(4, 5); // escape symbol
    encoder.compose(0, 4); // digit count: the minimum, 12
    for (let i = 0; i < 11; i++) {
      encoder.compose(0, 8);
    }
    encoder.compose(0, 7); // top digit 1 -> value 8^11, below 3^21
    expect(() => new Decoder(encoder.output({ type: 'text' })).parseTerm()).toThrow(
      'within the inline range'
    );
  });
});

describe('Public entrypoint', () => {
  it('exposes a non-empty, fully-defined surface', () => {
    // Every export is accessed so each lazy re-export getter runs; a barrel that
    // points at an undefined/removed symbol fails here.
    const keys = Object.keys(root);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect((root as Record<string, unknown>)[key]).toBeDefined();
    }
  });

  it('re-exports the working implementations', () => {
    expect(root.Encoder).toBe(Encoder);
    expect(root.Decoder).toBe(Decoder);
    expect(root.p).toBe(p);
    expect(root.p.int().min(0).max(1).decode(root.p.int().min(0).max(1).encode(1))).toBe(1);
  });
});

describe('Block size', () => {
  const Reading = p.object({
    level: p
      .int()
      .min(0)
      .max(999)
      .cdf((v) => v * v + v),
    kind: p.enum(['a', 'b', 'c']).weights([8, 1, 1]),
    on: p.bool(),
  });
  const Log = p.array(Reading);
  const log = Array.from({ length: 6000 }, (_, i) => ({
    level: (i * 37) % 1000,
    kind: (['a', 'a', 'b', 'a', 'c'] as const)[i % 5],
    on: i % 3 === 0,
  }));

  it.each([128, 2048, 65536])('round-trips a multi-block message at %i bits', (blockBits) => {
    const bytes = Log.encode(log, { blockBits });
    expect(bytes.length).toBeGreaterThan(powersOf(256, blockBits).blockDigits);
    expect(Log.decode(bytes, { blockBits })).toEqual(log);

    const options = { type: 'text' as const, charset: CharSets.urlSafe, blockBits };
    const text = Log.encode(log, options);
    expect(text.length).toBeGreaterThan(powersOf(66, blockBits).blockDigits);
    expect(Log.decode(text, options)).toEqual(log);
  });

  it('defaults to 2048 bits', () => {
    expect(Log.encode(log)).toEqual(Log.encode(log, { blockBits: 2048 }));
    expect(Log.encode(log, { type: 'text' })).toBe(
      Log.encode(log, { type: 'text', blockBits: 2048 })
    );
  });

  it('takes a byte charset and the block size together', () => {
    const options = { charset: [32, 126] as [number, number], blockBits: 128 };
    const bytes = Log.encode(log.slice(0, 50), options);
    expect(bytes.every((b) => b >= 32 && b <= 126)).toBe(true);
    expect(Log.decode(bytes, options)).toEqual(log.slice(0, 50));
  });

  it('rejects a block size that is not an integer in [128, 65536]', () => {
    const enc = new Encoder();
    enc.compose(1, 2);
    expect(() => enc.output({ blockBits: 100.5 })).toThrow(
      new TypeError('Block size must be an integer number of bits, got 100.5')
    );
    expect(() => enc.output({ type: 'text', blockBits: NaN })).toThrow(TypeError);
    expect(() => enc.output({ type: 'text', blockBits: 127 })).toThrow(
      new RangeError('Block size 127 bits is outside [128, 65536]')
    );
    expect(() => enc.output({ blockBits: 65537 })).toThrow(RangeError);
    expect(() => new Decoder('A', { blockBits: 32 })).toThrow(RangeError);
    expect(() => new Decoder(Uint8Array.of(1), { blockBits: 1e6 })).toThrow(RangeError);
    expect(() => p.bool().encode(true, { blockBits: 0 })).toThrow(RangeError);
    expect(() => p.bool().decode('A', { blockBits: 128.5 })).toThrow(TypeError);
  });
});
