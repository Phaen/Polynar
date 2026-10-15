/**
 * Output options: text or bytes and the charset that spells the digits, on `encode`/`decode` and on `Encoder.output`/`new Decoder`.
 */

import { p, Encoder, Decoder, CharSets, CorruptInputError } from '../index';

const composed = (value = 123, radix = 1001): Encoder => {
  const encoder = new Encoder();
  encoder.compose(value, radix);
  return encoder;
};

describe('Text output', () => {
  it.each(Object.entries(CharSets))('round-trips through the %s charset', (_name, charset) => {
    const text = composed().output({ type: 'text', charset });
    expect(new Decoder(text, { charset }).parse(1001)).toBe(123);
  });

  it('defaults to Base64 on both ends', () => {
    expect(composed().output({ type: 'text' })).toBe('B7');
    expect(composed().output({ type: 'text', charset: CharSets.base64 })).toBe('B7');
    expect(new Decoder('B7').parse(1001)).toBe(123);
  });

  it('spells an empty message as the empty string and no bytes', () => {
    expect(new Encoder().output({ type: 'text' })).toBe('');
    expect(new Encoder().output()).toHaveLength(0);
  });

  it('spells text in a range charset, down to two symbols', () => {
    expect(composed().output({ type: 'text', charset: [0x4e00, 0x9fff] })).toBe('乻');
    for (const range of [
      [65, 90],
      [48, 49],
    ] as [number, number][]) {
      const text = composed().output({ type: 'text', charset: range });
      expect(new Decoder(text, { charset: range }).parse(1001)).toBe(123);
    }
  });

  it('emits only characters from the chosen charset', () => {
    const str = p
      .string()
      .encode('any text at all — 👋', { type: 'text', charset: CharSets.digit });
    expect(str).toMatch(/^[0-9]+$/);
  });

  it('reads ASCII digits that sit past index 32767 of a long charset', () => {
    const codes = Array.from({ length: 65536 }, (_, i) => 65535 - i).filter(
      (code) => code < 0xd800 || code > 0xdfff
    );
    const charset = String.fromCharCode(...codes);
    const size = charset.length;
    const enc = new Encoder();
    enc.compose(size - 1, size);
    enc.compose(65, size);
    const dec = new Decoder(enc.output({ type: 'text', charset }), { charset });
    expect([dec.parse(size), dec.parse(size)]).toEqual([size - 1, 65]);
    dec.finalize();
  });

  it('keeps validating past the charsets it remembers', () => {
    // Validated charsets are remembered, up to a bound; a long stream of
    // distinct ones keeps being checked and keeps round-tripping.
    for (let i = 0; i < 300; i++) {
      const charset = String.fromCharCode(0x100 + i, 0x1000 + i, 0x2000 + i);
      const text = composed(i % 7, 7).output({ type: 'text', charset });
      expect(new Decoder(text, { charset }).parse(7)).toBe(i % 7);
    }
    expect(() => new Decoder('aa', { charset: 'aa' })).toThrow('Invalid character set');
  });
});

describe('Text charset validation', () => {
  it('rejects a duplicate character', () => {
    expect(() => new Decoder('test', { charset: 'aab' })).toThrow(
      new TypeError('Invalid character set: "a" appears more than once')
    );
    expect(() => new Decoder('test', { charset: 'ab\ncd\na' })).toThrow('Invalid character set');
  });

  it('rejects a charset of fewer than two characters', () => {
    // Base 1 has no digit variation to carry information.
    expect(() => new Encoder().output({ type: 'text', charset: 'a' })).toThrow(
      'Invalid character set: needs at least 2 characters, got 1'
    );
    expect(() => new Decoder('aaa', { charset: 'a' })).toThrow('Invalid character set');
    expect(() => new Decoder('test', { charset: [5, 5] })).toThrow(
      'Invalid character range: [5, 5] holds only one code'
    );
  });

  it('rejects a reversed range', () => {
    expect(() => composed().output({ type: 'text', charset: [90, 65] })).toThrow(
      new RangeError('Invalid character range: [90, 65] is empty')
    );
    expect(() => new Decoder('A', { charset: [90, 65] })).toThrow(RangeError);
  });

  it('rejects a range outside the UTF-16 code-unit space', () => {
    // String.fromCharCode truncates modulo 2^16, so such digits would decode
    // back as different in-range values without any error.
    expect(() => composed().output({ type: 'text', charset: [0, 100000] })).toThrow(
      'Invalid character range: [0, 100000] must be integer codes within 0–65535'
    );
    expect(() => composed().output({ type: 'text', charset: [-5, 100] })).toThrow(
      'Invalid character range'
    );
    expect(() => composed().output({ type: 'text', charset: [0.5, 100.5] })).toThrow(
      'Invalid character range'
    );
  });

  it('rejects a charset holding half of a surrogate pair', () => {
    expect(() => p.bool().encode(true, { type: 'text', charset: 'ab😀' })).toThrow(
      new RangeError('Invalid character set: code 55357 at 2 is half of a surrogate pair')
    );
    expect(() => p.bool().encode(true, { type: 'text', charset: [0xd000, 0xd900] })).toThrow(
      new RangeError(
        'Invalid character range: [53248, 55552] includes codes 55296–57343, the halves of surrogate pairs'
      )
    );
  });

  it('rejects a character absent from the charset', () => {
    // A character is checked when the decoder reads it.
    expect(() => new Decoder('!', { charset: CharSets.digit }).parse(10)).toThrow(
      /is not in the charset/
    );
    expect(() => new Decoder('a', { charset: '一丁' }).parse(2)).toThrow(
      'Character at 0 is not in the charset'
    );
    // '[' (code 91) is one beyond the maximum of the [65, 90] range.
    expect(() => new Decoder('Z[', { charset: [65, 90] }).parse(1001)).toThrow(
      'Character at 1 is not in the charset'
    );
  });
});

describe('Byte output', () => {
  const Player = p.object({ name: p.string().max(20), level: p.int().min(1).max(99) });
  const value = { name: 'Ada', level: 42 };

  it('keeps every byte inside a range and round-trips with it', () => {
    const bytes = Player.encode(value, { charset: [32, 126] });
    expect(bytes.every((b) => b >= 32 && b <= 126)).toBe(true);
    expect(Player.decode(bytes, { charset: [32, 126] })).toEqual(value);
    const enc = new Encoder();
    p.string().max(10)._write(enc, 'test');
    const raw = enc.output({ charset: [32, 126] });
    expect(raw.every((b) => b >= 32 && b <= 126)).toBe(true);
    expect(
      p
        .string()
        .max(10)
        ._read(new Decoder(raw, { charset: [32, 126] }))
    ).toBe('test');
  });

  it('defaults to every byte value', () => {
    const node = p.int().min(0).max(1e6);
    expect(node.encode(123456)).toEqual(node.encode(123456, { charset: [0, 255] }));
  });

  it('spends more bytes in a narrower range', () => {
    const long = { name: 'a'.repeat(20), level: 42 };
    expect(Player.encode(long, { charset: [32, 126] }).length).toBeGreaterThan(
      Player.encode(long).length
    );
    expect(Player.encode(value, { charset: [32, 126] }).length).toBeGreaterThanOrEqual(
      Player.encode(value).length
    );
  });

  it('rejects bytes read without the range they were written in', () => {
    const bytes = Player.encode(value, { charset: [32, 126] });
    expect(() => Player.decode(bytes)).toThrow(CorruptInputError);
  });

  it('writes a string charset as the code of each character', () => {
    const node = p.int().min(0).max(1000);
    const bytes = node.encode(737, { charset: '01' });
    // 737 is 1011100001 in binary, written most significant digit first.
    expect(String.fromCharCode(...bytes)).toBe('1011100001');
    expect(node.decode(bytes, { charset: '01' })).toBe(737);
  });

  it('spells the same symbols as text output in the same charset', () => {
    const node = p.string().max(20);
    const bytes = node.encode('same symbols', { charset: CharSets.hex });
    const text = node.encode('same symbols', { type: 'text', charset: CharSets.hex });
    expect(String.fromCharCode(...bytes)).toBe(text);
    expect(node.decode(bytes, { charset: CharSets.hex })).toBe('same symbols');
  });

  it.each([
    [-1, 255],
    [0, 256],
    [100, 50],
    [0.5, 10],
  ] as [number, number][])('rejects the range [%d, %d] on both ends', (lo, hi) => {
    expect(() => composed(42, 101).output({ charset: [lo, hi] })).toThrow(RangeError);
    expect(() => new Decoder(Uint8Array.of(100, 150, 200), { charset: [lo, hi] })).toThrow(
      RangeError
    );
  });

  it('rejects a charset symbol that is not a byte', () => {
    expect(() => p.bool().encode(true, { charset: 'aĀ' })).toThrow(
      new RangeError('Character "Ā" (code 256) is not a byte, so binary output cannot use it')
    );
    expect(() => p.bool().decode(Uint8Array.of(97), { charset: 'a一' })).toThrow(RangeError);
    expect(() => p.bool().encode(true, { charset: [200, 300] })).toThrow(
      new RangeError('Code 300 is not a byte, so binary output cannot use the range [200, 300]')
    );
  });

  it('throws when a byte is not in the charset', () => {
    expect(() => new Decoder(Uint8Array.of(10, 200), { charset: [0, 100] }).parse(1000)).toThrow(
      'Byte at 1 is not in the charset'
    );
  });
});

describe('Long messages', () => {
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
  const log = Array.from({ length: 1000 }, (_, i) => ({
    level: (i * 37) % 1000,
    kind: (['a', 'a', 'b', 'a', 'c'] as const)[i % 5],
    on: i % 3 === 0,
  }));

  it('round-trips a long message through bytes and text', () => {
    const bytes = Log.encode(log);
    expect(Log.decode(bytes)).toEqual(log);

    const options = { type: 'text' as const, charset: CharSets.urlSafe };
    const text = Log.encode(log, options);
    expect(Log.decode(text, options)).toEqual(log);
  });

  it('spells a long message in a byte charset of its own', () => {
    const range = { charset: [32, 126] as [number, number] };
    const bytes = Log.encode(log.slice(0, 50), range);
    expect(bytes.every((b) => b >= 32 && b <= 126)).toBe(true);
    expect(Log.decode(bytes, range)).toEqual(log.slice(0, 50));
  });
});
