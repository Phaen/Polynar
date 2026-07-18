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
  printable:
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
  htmlSafe:
    " !#$%'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
  Base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  urlSafe: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$-_.+!*'()",
} as const;

export const DEFAULT_CHARSET = CharSets.Base64;

/**
 * Unbounded integers (`composeTerm`/`parseTerm`) ride in terminated base-3
 * digit runs: radix-4 slots where 0 terminates. Base 3 is the measured
 * optimum for the small values that dominate term traffic (lengths, counts),
 * re-verified 2026 against bases 2..15 over realistic distributions.
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
 * State-space cap per packed block, in bits. Values fold into one
 * arbitrary-precision integer only until the block's radix product would
 * exceed this, then the block flushes and a fresh one starts. The cap bounds
 * every BigInt operation, keeping encode/decode linear in message size (one
 * uncapped integer would make them quadratic), at a worst-case cost of one
 * unfilled digit per block boundary. Must comfortably exceed 2^53, the
 * largest single radix `compose` accepts.
 */
export const BLOCK_BITS = 2048;
