/**
 * Schema string node (`p.string()`) — unicode strings, prose mode, charsets.
 */

import { p, Encoder } from '../../index';
import { TEXT_DIRECT_MAX, TEXT_FIRST_RADIX } from '../../nodes/codepoint';
import { PROSE_ESCAPE, PROSE_TOTALS, proseBucket, proseContext } from '../../nodes/prose';
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
      'String not compliant with character set'
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
    const ctx = proseContext(' '.charCodeAt(0));
    const [cum, freq] = proseBucket(ctx, PROSE_ESCAPE);
    const enc = new Encoder();
    enc.composeTerm(1);
    enc.composeWeighted(cum, freq, PROSE_TOTALS[ctx]);
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
});
