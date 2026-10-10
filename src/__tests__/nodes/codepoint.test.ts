/**
 * The laddered code-point codec behind `p.string()` and the prose escape.
 */

import { Encoder, Decoder } from '../../index';
import {
  composeCodePoint,
  parseCodePoint,
  TEXT_BANDS,
  TEXT_DIRECT_MAX,
  TEXT_FIRST_RADIX,
} from '../../nodes/codepoint';

const BAND_EDGES = [0, 0x7f, 0x80, 0x7ff, 0x800, 0xd800, 0xdfff, 0xffff, 0x10000, 0x10ffff];

describe('composeCodePoint', () => {
  it('round-trips both edges of every band', () => {
    const enc = new Encoder();
    for (const code of BAND_EDGES) {
      composeCodePoint(enc, code);
    }
    const dec = new Decoder(enc.output());
    expect(BAND_EDGES.map(() => parseCodePoint(dec))).toEqual(BAND_EDGES);
  });

  it('spends one slot on ASCII and two above it', () => {
    const ascii = new Encoder();
    composeCodePoint(ascii, TEXT_DIRECT_MAX);
    const direct = new Encoder();
    direct.compose(TEXT_DIRECT_MAX, TEXT_FIRST_RADIX);
    expect(ascii.output()).toEqual(direct.output());

    const astral = new Encoder();
    composeCodePoint(astral, 0x10ffff);
    const laddered = new Encoder();
    laddered.compose(TEXT_DIRECT_MAX + 3, TEXT_FIRST_RADIX);
    laddered.compose(0xfffff, 0x100000);
    expect(astral.output()).toEqual(laddered.output());
  });

  it.each([-1, 0x110000, 2 ** 32, Number.MAX_SAFE_INTEGER])(
    'rejects %p outside the code points, writing nothing',
    (code) => {
      const enc = new Encoder();
      expect(() => composeCodePoint(enc, code)).toThrow(
        new RangeError(`Code point ${code} is outside 0–0x10FFFF`)
      );
      expect(enc.output()).toHaveLength(0);
    }
  );

  it.each([0.5, NaN, Infinity, -Infinity])('rejects the non-integer %p', (code) => {
    expect(() => composeCodePoint(new Encoder(), code)).toThrow(
      new TypeError(`Code point must be an integer, got ${code}`)
    );
  });
});

describe('parseCodePoint', () => {
  it('reads every first-slot state', () => {
    // The direct range, then each band's escape with offset zero.
    const enc = new Encoder();
    for (let first = 0; first < TEXT_FIRST_RADIX; first++) {
      enc.compose(first, TEXT_FIRST_RADIX);
      if (first > TEXT_DIRECT_MAX) {
        const [min, max] = TEXT_BANDS[first - TEXT_DIRECT_MAX - 1];
        enc.compose(0, max - min + 1);
      }
    }
    const dec = new Decoder(enc.output());
    const codes = Array.from({ length: TEXT_FIRST_RADIX }, () => parseCodePoint(dec));
    const direct = Array.from({ length: TEXT_DIRECT_MAX + 1 }, (_, code) => code);
    expect(codes).toEqual([...direct, 0x80, 0x800, 0x10000]);
  });
});
