/**
 * Schema string node (`p.string()`) — unicode strings, prose mode, charsets.
 */

import { p, Encoder, ProseModels, buildProseModel } from '../../index';
import { TEXT_DIRECT_MAX, TEXT_FIRST_RADIX } from '../../nodes/codepoint';
import { compileProse } from '../../nodes/prose';
import { trip } from '../support';

describe('Schema string', () => {
  it('string round-trips real-world unicode and bounded lengths', () => {
    const value = 'café — line1\nline2 👋 漢字';
    expect(trip(p.string(), value)).toBe(value);
    expect(trip(p.string().max(20), 'Ada Lovelace')).toBe('Ada Lovelace');
  });

  it('string honours a custom charset', () => {
    expect(trip(p.string().charset('0123456789'), '12345')).toBe('12345');
  });

  it('string rejects a value outside its charset', () => {
    expect(() => p.string().charset('0123456789').encode('12a')).toThrow(
      new RangeError("Character 'a' at 2 is not in the character set")
    );
  });

  it('string rejects a value longer than its max', () => {
    expect(() => p.string().max(3).encode('long')).toThrow(RangeError);
  });

  it('string round-trips lone surrogates and astral characters bit-exact', () => {
    for (const value of ['\uD800', '\uDC00', 'a\uD800b', '\uDFFF\uD800', '👋\uD800👋']) {
      expect(trip(p.string(), value)).toBe(value);
      expect(trip(p.string().max(8), value)).toBe(value);
    }
  });

  it('prose round-trips any string, model-shaped or not', () => {
    for (const value of ['See you at noon?', 'Ünïcödé — 漢字 👋', 'a\uD800b', '\t\n~']) {
      expect(trip(p.string().prose(), value)).toBe(value);
      expect(trip(p.string().prose().max(24), value)).toBe(value);
    }
  });

  it('prose packs English tighter than the flat ladder', () => {
    // ~4.5 bits per character against the ladder's 7.03. A pangram would
    // fail this: rare letters cost 10+ bits under the frequency model.
    const text =
      'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.';
    const prose = p.string().prose().encode(text).length;
    const flat = p.string().encode(text).length;
    expect(prose).toBeLessThan(flat * 0.7);
  });

  it('prose rejects a charset and a charset rejects prose', () => {
    expect(() => p.string().prose().charset('abc')).toThrow(TypeError);
    expect(() => p.string().charset('abc').prose()).toThrow(TypeError);
  });

  it('min and length narrow the length prefix', () => {
    const ranged = p.string().min(8).max(12);
    expect(trip(ranged, 'abcdefghij')).toBe('abcdefghij');
    expect(() => ranged.encode('short')).toThrow('String length 5 is below the minimum 8');
    expect(() => ranged.encode('a'.repeat(13))).toThrow('String length 13 is above the maximum 12');
    expect(trip(p.string().min(2), 'abc')).toBe('abc');
    expect(() => p.string().min(3).max(2)).toThrow('p.string range is empty: min 3 exceeds max 2');
    expect(() => p.string().min(-1)).toThrow('p.string min must be a non-negative length, got -1');
    // A fixed length is both bounds, so it combines with neither.
    expect(() => p.string().length(5).max(8)).toThrow('cannot be combined');
    expect(() => p.string().min(2).length(5)).toThrow('cannot be combined');
    expect(() => p.string().length(2.5)).toThrow('non-negative integer, got 2.5');
    expect(() => p.string().length(3).encode('ab')).toThrow(
      'String length 2 differs from the fixed length 3'
    );
    // A fixed length spends nothing on the prefix: eight binary characters
    // fill one byte exactly, where a max of 8 needs a second.
    const bits = p.string().charset('ab');
    expect(bits.length(8).encode('abababab')).toHaveLength(1);
    expect(bits.max(8).encode('abababab')).toHaveLength(2);
    expect(trip(bits.length(8), 'aaaabbbb')).toBe('aaaabbbb');
  });

  it('prose takes any model, starting outside the alphabet when it has no space', () => {
    const kana = buildProseModel('ありがとうございます。こんにちは。さようなら。');
    for (const value of ['ありがとう', 'こんにちは!', '', 'xyz 🎉']) {
      expect(trip(p.string().prose(kana), value)).toBe(value);
    }
    const text = 'ありがとうございます。こんにちは。';
    expect(p.string().prose(kana).encode(text).length).toBeLessThan(
      p.string().prose().encode(text).length
    );
  });

  it('a built model is plain data that depends only on its corpus', () => {
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

  it('a built model leaves rare characters to the escape', () => {
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

  it('prose models must match their alphabet', () => {
    const row = [1, 1, 1];
    expect(() => p.string().prose({ alphabet: '', weights: [[1]] })).toThrow('non-empty');
    expect(() => p.string().prose({ alphabet: 'aa', weights: [row, row, row] })).toThrow(
      'free of duplicates'
    );
    expect(() => p.string().prose({ alphabet: 'ab', weights: [row, row] })).toThrow(
      'p.string prose weights need a row per alphabet character, plus one: expected 3, got 2'
    );
    expect(() => p.string().prose({ alphabet: 'ab', weights: [row, [1, 1], row] })).toThrow(
      'one weight per value'
    );
    expect(() => p.string().prose({ alphabet: 'ab', weights: [row, [1, 0, 1], row] })).toThrow(
      'positive integers'
    );
  });

  it('string packs ASCII near seven bits per character', () => {
    // 24 slots of log2(131) bits plus the length prefix: 22 bytes, where the
    // former flat 16-bit code units spent 49.
    expect(p.string().max(24).encode('twenty four ascii chars!')).toHaveLength(22);
  });

  it('string decode rejects a surrogate pair split into two code points', () => {
    // The encoder merges an adjacent lead+trail into one astral code point,
    // so the two-slot spelling would be a second wire form of the same string.
    const enc = new Encoder();
    enc.composeTerm(2);
    for (const code of [0xd800, 0xdc00]) {
      enc.compose(TEXT_DIRECT_MAX + 2, TEXT_FIRST_RADIX);
      enc.compose(code - 0x800, 0xffff - 0x800 + 1);
    }
    expect(() => p.string().decode(enc.toUint8Array())).toThrow(
      'Non-canonical split surrogate pair'
    );
  });

  it('prose decode rejects a modeled character behind the escape', () => {
    // 'e' has its own bucket, so its escaped form would be a second wire
    // spelling of the same string.
    const table = compileProse(ProseModels.english);
    const row = table.rows[table.start];
    const enc = new Encoder();
    enc.composeTerm(1);
    enc.composeWeighted(row.cums[table.escape], row.freqs[table.escape], row.total);
    enc.compose('e'.charCodeAt(0), TEXT_FIRST_RADIX);
    expect(() => p.string().prose().decode(enc.toUint8Array())).toThrow(
      'Non-canonical escape of a modeled character'
    );
  });

  it('string decode rejects an astral code point past the length prefix', () => {
    // A one-unit prefix followed by a two-unit code point fits no string.
    const enc = new Encoder();
    enc.composeTerm(1);
    enc.compose(TEXT_DIRECT_MAX + 3, TEXT_FIRST_RADIX);
    enc.compose(0x1f44b - 0x10000, 0x10ffff - 0x10000 + 1);
    expect(() => p.string().decode(enc.toUint8Array())).toThrow(
      'Code points overrun the length prefix'
    );
  });

  it('rejects bad configuration and non-compliant values', () => {
    expect(() => p.string().max(-1)).toThrow('max must be a non-negative length, got -1');
    expect(() => p.string().prose().charset('ab')).toThrow('cannot combine prose with a charset');
    expect(() => p.string().charset([97, 98]).encode('abc')).toThrow(
      new RangeError("Character 'c' (code 99) at 2 is outside the range 97–98")
    );
  });
});
