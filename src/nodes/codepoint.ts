/**
 * The laddered code-point codec: the flat default for `p.string()` and the
 * escape route for the prose model. One slot per Unicode code point, sized
 * so the cheap symbols are the common ones. The first slot spends log2(131)
 * ≈ 7.03 bits; ASCII rides in it directly, and three escape symbols select a
 * band for everything else, paid with one more slot sized to exactly that
 * band: 17.9 bits up to U+07FF, 23.0 through the rest of the BMP, 27.0 for
 * astral code points. Surrogate code points are legal in the BMP band, so
 * lone surrogates round-trip bit-exact (WTF-8 style); a lead+trail pair
 * always encodes as one supplementary code point.
 */
import { Encoder, Decoder } from '../packer';

export const TEXT_DIRECT_MAX = 0x7f;
export const TEXT_BANDS: readonly [number, number][] = [
  [0x80, 0x7ff],
  [0x800, 0xffff],
  [0x10000, 0x10ffff],
];
export const TEXT_FIRST_RADIX = TEXT_DIRECT_MAX + 1 + TEXT_BANDS.length;

const CODE_POINT_MAX = 0x10ffff;

/**
 * The first slot's symbol of a code point, an integer in
 * `[0, TEXT_FIRST_RADIX)`: the code itself through TEXT_DIRECT_MAX, the
 * escape of its band above.
 */
export function codePointSymbol(code: number): number {
  // `>>> 0` keeps exactly the integers in [0, 2^32), so one comparison
  // passes every code point and stops NaN, fractions and negatives.
  if (code >>> 0 !== code || code > CODE_POINT_MAX) {
    throw Number.isInteger(code)
      ? new RangeError(`Code point ${code} is outside 0–0x10FFFF`)
      : new TypeError(`Code point must be an integer, got ${code}`);
  }
  if (code <= TEXT_DIRECT_MAX) {
    return code;
  }
  // The last band ends at CODE_POINT_MAX, so the loop always finds one.
  for (let band = 0; ; band++) {
    if (code <= TEXT_BANDS[band][1]) {
      return TEXT_DIRECT_MAX + 1 + band;
    }
  }
}

/**
 * The code points the first slot's `symbol` leaves a tail for, first and
 * last: its band; undefined through TEXT_DIRECT_MAX, where nothing follows.
 */
export function codePointBand(symbol: number): readonly [number, number] | undefined {
  return symbol <= TEXT_DIRECT_MAX ? undefined : TEXT_BANDS[symbol - TEXT_DIRECT_MAX - 1];
}

/**
 * The radix of the slot `composeCodePointTail` writes after the first
 * slot's `symbol`: the size of its band, 1 through TEXT_DIRECT_MAX, where
 * nothing follows.
 */
export function codePointTailRadix(symbol: number): number {
  if (symbol <= TEXT_DIRECT_MAX) {
    return 1;
  }
  const [min, max] = TEXT_BANDS[symbol - TEXT_DIRECT_MAX - 1];
  return max - min + 1;
}

/**
 * What the first slot's `symbol` leaves of `code`: nothing through
 * TEXT_DIRECT_MAX, the offset into its band, in a slot sized to exactly the
 * band, above. A symbol that is not `codePointSymbol(code)` is refused.
 */
export function composeCodePointTail(enc: Encoder, code: number, symbol: number): void {
  if (codePointSymbol(code) !== symbol) {
    throw new RangeError(`Code point ${code} does not take the first slot ${symbol}`);
  }
  if (symbol > TEXT_DIRECT_MAX) {
    const [min, max] = TEXT_BANDS[symbol - TEXT_DIRECT_MAX - 1];
    enc.compose(code - min, max - min + 1);
  }
}

/**
 * The code point of the first slot's `symbol` and the tail
 * `composeCodePointTail` wrote; a symbol outside `[0, TEXT_FIRST_RADIX)` is
 * refused.
 */
export function parseCodePointTail(dec: Decoder, symbol: number): number {
  if (symbol >>> 0 !== symbol || symbol >= TEXT_FIRST_RADIX) {
    throw new RangeError(`First slot ${symbol} is outside [0, ${TEXT_FIRST_RADIX})`);
  }
  if (symbol <= TEXT_DIRECT_MAX) {
    return symbol;
  }
  const [min, max] = TEXT_BANDS[symbol - TEXT_DIRECT_MAX - 1];
  return min + dec.parse(max - min + 1);
}

/**
 * One laddered slot per code point: values through TEXT_DIRECT_MAX ride in
 * the first slot directly, everything above pays an escape symbol plus a
 * second slot sized to exactly its band.
 */
export function composeCodePoint(enc: Encoder, code: number): void {
  const symbol = codePointSymbol(code);
  enc.compose(symbol, TEXT_FIRST_RADIX);
  composeCodePointTail(enc, code, symbol);
}

/** Read one laddered code point; every wire state names one in 0–0x10FFFF. */
export function parseCodePoint(dec: Decoder): number {
  return parseCodePointTail(dec, dec.parse(TEXT_FIRST_RADIX));
}
