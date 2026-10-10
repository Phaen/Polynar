/**
 * `p.string()`: unicode strings, optionally under a charset or a prose model.
 */

import { p, Encoder, ProseModels, buildProseModel } from '../../index';
import { TEXT_DIRECT_MAX, TEXT_FIRST_RADIX } from '../../nodes/codepoint';
import { compileProse } from '../../nodes/prose';
import { mulberry32, trip } from '../support';

const rand = mulberry32(0x57a1);
const below = (n: number): number => Math.floor(rand() * n);

describe('Schema string', () => {
  it('packs ASCII near seven bits per character', () => {
    // 24 slots of log2(131) bits plus the length prefix: 22 bytes, where flat
    // 16-bit code units would spend 49.
    expect(p.string().max(24).encode('twenty four ascii chars!')).toHaveLength(22);
  });

  it.each(['\uD800', '\uDC00', 'a\uD800b', '\uDFFF\uD800', '👋\uD800👋'])(
    'round-trips the lone surrogates of %j bit-exact',
    (value) => {
      expect(trip(p.string(), value)).toBe(value);
      expect(trip(p.string().max(8), value)).toBe(value);
    }
  );

  it('keeps a lead surrogate that a slice cut from its trail', () => {
    // Enough iterations for V8 to optimize the encode loop, where an
    // optimized `codePointAt` reads past the slice into the parent string.
    const node = p.string();
    for (let i = 0; i < 20000; i++) {
      const whole = `abcdefghijklmnopqrstuvwxyz${i}😀 tail`;
      const cut = whole.slice(0, whole.length - 6);
      expect(node.decode(node.encode(cut))).toBe(cut);
    }
  });

  it('narrows the length prefix with min and length', () => {
    const ranged = p.string().min(8).max(12);
    expect(trip(ranged, 'abcdefghij')).toBe('abcdefghij');
    expect(() => ranged.encode('short')).toThrow('String length 5 is below the minimum 8');
    expect(() => ranged.encode('a'.repeat(13))).toThrow('String length 13 is above the maximum 12');
    expect(trip(p.string().min(2), 'abc')).toBe('abc');
    // A fixed length spends nothing on the prefix: eight binary characters
    // fill one byte exactly, where a max of 8 needs a second.
    const bits = p.string().charset('ab');
    expect(bits.length(8).encode('abababab')).toHaveLength(1);
    expect(bits.max(8).encode('abababab')).toHaveLength(2);
    expect(trip(bits.length(8), 'aaaabbbb')).toBe('aaaabbbb');
  });

  it('takes a prior on the length', () => {
    const code = p.string().charset('0123456789').min(4).max(8).weights([1, 1, 50, 1, 1]);
    expect(trip(code, '123456')).toBe('123456');
    const list = (n: typeof code) => p.array(n).length(16).encode(Array(16).fill('123456')).length;
    expect(list(code)).toBeLessThan(list(p.string().charset('0123456789').min(4).max(8)));
    const cdf = p
      .string()
      .max(3)
      .cdf((n) => (n > 0 ? (n - 1) * (n - 1) : 0));
    expect(() => cdf.encode('')).toThrow(
      new RangeError('String length 0 has zero weight under the declared cdf')
    );
    expect(() => p.string().cdf((n) => n)).toThrow(
      new TypeError('p.string cdf requires a max length')
    );
    // A fixed length is one value, so its prior costs nothing either way.
    expect(p.string().length(3).weights([1]).encode('abc')).toEqual(
      p.string().length(3).encode('abc')
    );
    expect(() => p.string().max(2).weights([1, 1])).toThrow('one weight per value');
  });

  it('rejects a value outside its charset', () => {
    expect(() => p.string().charset('0123456789').encode('12a')).toThrow(
      new RangeError('Character "a" at 2 is not in the character set')
    );
    expect(() => p.string().charset([97, 98]).encode('abc')).toThrow(
      new RangeError('Character "c" (code 99) at 2 is outside the range 97–98')
    );
  });

  it('rejects a charset holding half of a surrogate pair', () => {
    expect(() => p.string().charset([0xdc00, 0xdfff])).toThrow(RangeError);
    expect(() => p.string().charset('x\udfff')).toThrow(RangeError);
  });

  it('takes a one-character charset, whose characters cost nothing', () => {
    expect(trip(p.string().charset('x').length(5), 'xxxxx')).toBe('xxxxx');
    expect(p.string().charset([120, 120]).length(5).encode('xxxxx')).toHaveLength(0);
    expect(trip(p.string().charset('a'), 'aaaa')).toBe('aaaa');
  });

  it('round-trips long charset strings', () => {
    const hex = Array.from({ length: 20_000 }, () => '0123456789abcdef'[below(16)]).join('');
    expect(trip(p.string().charset('0123456789abcdef'), hex)).toBe(hex);
    const cyrillic = String.fromCharCode(...Array.from({ length: 3000 }, () => 0x400 + below(256)));
    expect(trip(p.string().charset([0x400, 0x4ff]), cyrillic)).toBe(cyrillic);
  });

  it('rejects a surrogate pair split into two code points', () => {
    // The encoder merges an adjacent lead+trail into one astral code point,
    // so the two-slot spelling would be a second wire form of the same string.
    const enc = new Encoder();
    enc.composeTerm(2);
    for (const code of [0xd800, 0xdc00]) {
      enc.compose(TEXT_DIRECT_MAX + 2, TEXT_FIRST_RADIX);
      enc.compose(code - 0x800, 0xffff - 0x800 + 1);
    }
    expect(() => p.string().decode(enc.output())).toThrow('Non-canonical split surrogate pair');
  });

  it('rejects an astral code point past the length prefix', () => {
    // A one-unit prefix followed by a two-unit code point fits no string.
    const enc = new Encoder();
    enc.composeTerm(1);
    enc.compose(TEXT_DIRECT_MAX + 3, TEXT_FIRST_RADIX);
    enc.compose(0x1f44b - 0x10000, 0x10ffff - 0x10000 + 1);
    expect(() => p.string().decode(enc.output())).toThrow('Code points overrun the length prefix');
  });
});

describe('Schema string prose', () => {
  it.each(['See you at noon?', 'Ünïcödé — 漢字 👋', 'a\uD800b', '\t\n~'])(
    'round-trips %j under a max length',
    (value) => {
      expect(trip(p.string().prose().max(24), value)).toBe(value);
    }
  );

  it('packs English tighter than the flat ladder', () => {
    // ~4.5 bits per character against the ladder's 7.03. A pangram would
    // fail this: rare letters cost 10+ bits under the frequency model.
    const text =
      'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.';
    const prose = p.string().prose().encode(text).length;
    const flat = p.string().encode(text).length;
    expect(prose).toBeLessThan(flat * 0.7);
  });

  it('cannot combine with a charset', () => {
    expect(() => p.string().prose().charset('abc')).toThrow('cannot combine prose with a charset');
    expect(() => p.string().charset('abc').prose()).toThrow(TypeError);
  });

  it('takes any model, starting outside the alphabet when it has no space', () => {
    const kana = buildProseModel('ありがとうございます。こんにちは。さようなら。');
    for (const value of ['ありがとう', 'こんにちは!', '', 'xyz 🎉']) {
      expect(trip(p.string().prose(kana), value)).toBe(value);
    }
    const text = 'ありがとうございます。こんにちは。';
    expect(p.string().prose(kana).encode(text).length).toBeLessThan(
      p.string().prose().encode(text).length
    );
  });

  it('builds a model as plain data that depends only on its corpus', () => {
    const corpus = 'de kat zit op de mat';
    const copy = JSON.parse(JSON.stringify(buildProseModel(corpus)));
    expect(p.string().prose(buildProseModel(corpus)).encode('de mat')).toEqual(
      p.string().prose(copy).encode('de mat')
    );
    // With an explicit alphabet, everything else rides the escape.
    const ab = buildProseModel('abcba', { alphabet: 'ab' });
    expect(ab.weights).toHaveLength(3);
    expect(trip(p.string().prose(ab), 'abc')).toBe('abc');
  });

  it('leaves rare characters of a built model to the escape', () => {
    const corpus = 'the cat sat on the mat, the end 🎉';
    expect(buildProseModel(corpus).alphabet).toBe(' aehnt');
    expect(Array.from(buildProseModel(corpus, { minCount: 1 }).alphabet)).toContain('🎉');
    expect(trip(p.string().prose(buildProseModel(corpus)), 'the dog 🎉')).toBe('the dog 🎉');
    const lone = buildProseModel('a\udc00a\ud800a', { minCount: 1 });
    expect(lone.alphabet).toBe('a');
    expect(trip(p.string().prose(lone), 'a\ud800\ud800a')).toBe('a\ud800\ud800a');
    expect(() => buildProseModel('abc')).toThrow('no characters to model');
    expect(() => buildProseModel('aa', { alphabet: '' })).toThrow('no characters to model');
    expect(() => buildProseModel('aa', { minCount: 0 })).toThrow(
      new RangeError('buildProseModel minCount must be a positive integer, got 0')
    );
  });

  const row = [1, 1, 1];
  it.each([
    [{ alphabet: '', weights: [[1]] }, 'non-empty'],
    [{ alphabet: 'aa', weights: [row, row, row] }, 'free of duplicates'],
    [
      { alphabet: 'ab', weights: [row, row] },
      'p.string prose weights need a row per alphabet character, plus one: expected 3, got 2',
    ],
    [{ alphabet: 'ab', weights: [row, [1, 1], row] }, 'one weight per value'],
    [{ alphabet: 'ab', weights: [row, [1, 0, 1], row] }, 'positive integers'],
  ])('rejects a model that does not match its alphabet: %j', (model, message) => {
    expect(() => p.string().prose(model)).toThrow(message);
  });

  it('rejects a modeled character behind the escape', () => {
    // 'e' has its own bucket, so its escaped form would be a second wire
    // spelling of the same string.
    const table = compileProse(ProseModels.english);
    const start = table.rows[table.start];
    const enc = new Encoder();
    enc.composeTerm(1);
    enc.composeWeighted(start.cums[table.escape], start.freqs[table.escape], start.total);
    enc.compose('e'.charCodeAt(0), TEXT_FIRST_RADIX);
    expect(() => p.string().prose().decode(enc.output())).toThrow(
      'Non-canonical escape of a modeled character'
    );
  });
});
