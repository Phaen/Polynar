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
 * One laddered slot per code point: values through TEXT_DIRECT_MAX ride in
 * the first slot directly, everything above pays an escape symbol plus a
 * second slot sized to exactly its band. `writeFirst` spells the first
 * slot's symbol, an integer in `[0, TEXT_FIRST_RADIX)`, uniformly unless
 * given.
 */
export function composeCodePoint(
  enc: Encoder,
  code: number,
  writeFirst: (symbol: number) => void = (symbol) => enc.compose(symbol, TEXT_FIRST_RADIX)
): void {
  // `>>> 0` keeps exactly the integers in [0, 2^32), so one comparison
  // passes every code point and stops NaN, fractions and negatives.
  if (code >>> 0 !== code || code > CODE_POINT_MAX) {
    throw Number.isInteger(code)
      ? new RangeError(`Code point ${code} is outside 0–0x10FFFF`)
      : new TypeError(`Code point must be an integer, got ${code}`);
  }
  if (code <= TEXT_DIRECT_MAX) {
    writeFirst(code);
    return;
  }
  // The last band ends at CODE_POINT_MAX, so the loop always finds one.
  for (let band = 0; ; band++) {
    const [min, max] = TEXT_BANDS[band];
    if (code <= max) {
      writeFirst(TEXT_DIRECT_MAX + 1 + band);
      enc.compose(code - min, max - min + 1);
      return;
    }
  }
}

/**
 * Read one laddered code point; every wire state names one in 0–0x10FFFF.
 * `readFirst` reads the first slot's symbol as `composeCodePoint`'s
 * `writeFirst` spelled it; a symbol outside `[0, TEXT_FIRST_RADIX)` is
 * refused.
 */
export function parseCodePoint(
  dec: Decoder,
  readFirst: () => number = () => dec.parse(TEXT_FIRST_RADIX)
): number {
  const first = readFirst();
  if (first >>> 0 !== first || first >= TEXT_FIRST_RADIX) {
    throw new RangeError(`First slot ${first} is outside [0, ${TEXT_FIRST_RADIX})`);
  }
  if (first <= TEXT_DIRECT_MAX) {
    return first;
  }
  const [min, max] = TEXT_BANDS[first - TEXT_DIRECT_MAX - 1];
  return min + dec.parse(max - min + 1);
}
