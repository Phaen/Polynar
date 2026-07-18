/**
 * The laddered code-point codec: the flat default for `p.string()` and the
 * escape route for the prose model. One slot per Unicode code point, sized
 * so the cheap symbols are the common ones. The first slot spends log2(131)
 * ≈ 7.03 bits; ASCII rides in it directly, and three escape symbols select a
 * band for everything else, paid with one more slot sized to exactly that
 * band: 17.9 bits up to U+07FF, 23.0 through the rest of the BMP, 27.0 for
 * astral code points. Surrogate code points are legal in the BMP band, so
 * lone surrogates round-trip bit-exact (WTF-8 style); a lead+trail pair
 * always encodes as one supplementary code point, and the decoder rejects
 * the split spelling as non-canonical.
 */
import { Encoder, Decoder } from '../packer';

export const TEXT_DIRECT_MAX = 0x7f;
export const TEXT_BANDS: readonly [number, number][] = [
  [0x80, 0x7ff],
  [0x800, 0xffff],
  [0x10000, 0x10ffff],
];
export const TEXT_FIRST_RADIX = TEXT_DIRECT_MAX + 1 + TEXT_BANDS.length;

/**
 * One laddered slot per code point: values through TEXT_DIRECT_MAX ride in
 * the first slot directly, everything above pays an escape symbol plus a
 * second slot sized to exactly its band.
 */
export function composeCodePoint(enc: Encoder, code: number): void {
  if (code <= TEXT_DIRECT_MAX) {
    enc.compose(code, TEXT_FIRST_RADIX);
    return;
  }
  for (let band = 0; band < TEXT_BANDS.length; band++) {
    const [min, max] = TEXT_BANDS[band];
    if (code <= max) {
      enc.compose(TEXT_DIRECT_MAX + 1 + band, TEXT_FIRST_RADIX);
      enc.compose(code - min, max - min + 1);
      return;
    }
  }
}

export function parseCodePoint(dec: Decoder): number {
  const first = dec.parse(TEXT_FIRST_RADIX);
  if (first <= TEXT_DIRECT_MAX) {
    return first;
  }
  const [min, max] = TEXT_BANDS[first - TEXT_DIRECT_MAX - 1];
  return min + dec.parse(max - min + 1);
}
