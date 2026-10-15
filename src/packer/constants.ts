/**
 * Constants and character sets for Polynar packer
 */

/**
 * Character sets for encoding
 */
export const CharSets = {
  digit: '0123456789',
  hex: '0123456789ABCDEF',
  lowalpha: 'abcdefghijklmnopqrstuvwxyz',
  hialpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  alpha: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  alphanumeric: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  asciiSafe:
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
  htmlSafe:
    ' !#$%()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
  base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  // RFC 3986 unreserved. The wider RFC 1738 set would buy 0.13 bits per
  // character, but it contains `+`, which form decoding — URLSearchParams and
  // every server-side equivalent — turns back into a space.
  urlSafe: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~',
} as const;

export const DEFAULT_CHARSET = CharSets.base64;

/**
 * Unbounded integers (`composeTerm`/`parseTerm`) ride in terminated base-3
 * digit runs: radix-4 slots where 0 terminates. Base 3 is the measured
 * optimum for the small values that dominate term traffic (lengths, counts),
 * across bases 2..15 over realistic distributions.
 *
 * The FIRST slot of a term is one state wider (radix 5); its extra symbol
 * escapes to a length-prefixed form for values >= 3^TERM_INLINE_DIGITS:
 * the base-8 digit count as a plain run (offset by its known minimum), then
 * the digits at full density with a never-zero top digit. Small terms pay
 * only the wider first slot (~0.3 bits) while timestamps get ~11% cheaper
 * and very large values ~19%. Changing any of this breaks every encoding.
 */
export const TERM_BASE = 3;
/** Values below 3^21 encode inline; the exponent caps canonical run length. */
export const TERM_INLINE_DIGITS = 21;
export const TERM_ESCAPE_MIN = TERM_BASE ** TERM_INLINE_DIGITS;
export const TERM_PAYLOAD_BASE = 8;
/** Base-8 digit count of TERM_ESCAPE_MIN — the smallest escaped term. */
export const TERM_PAYLOAD_MIN_DIGITS = (() => {
  let digits = 0;
  for (let x = TERM_ESCAPE_MIN; x >= 1; x /= TERM_PAYLOAD_BASE) digits++;
  return digits;
})();
/**
 * Cap on the digit-count run: the largest double is 2^1024, or 342 base-8
 * digits, so a canonical offset count never exceeds 330 = six base-3 digits.
 */
export const TERM_COUNT_RUN_DIGITS = 6;

/**
 * The window L of the streaming coder in base `size`: 2^(52 − ⌈log2 size⌉),
 * so size·2L is at most 2^53. Symbol i of `total` T_i and `freq` f_i has
 * window k_i = max(1, ⌊L/T_i⌋, ⌈B_{i−1}/T_i⌉), where B_{i−1} = k_{i−1}·f_{i−1}
 * of the coded symbol before it, 0 for the first; the decoder's state is at
 * least A_i = k_i·T_i before symbol i is read, unless the input has run
 * out. The renormalisation is exact when A_i ≥ B_{i−1} for every symbol:
 * the encoder's state after emitting for a symbol then never falls below
 * the window of the next, so the decoder stops reading exactly where the
 * encoder started emitting. The ceiling term makes that hold by
 * construction, for any totals. While T_{i−1}·T_i ≤ L it is never the
 * largest, and A_i ≤ L keeps the state, below size·A_i, a safe integer.
 */
export function ransWindow(size: number): number {
  let bits = 0;
  while (2 ** bits < size) {
    bits++;
  }
  return 2 ** (52 - bits);
}
