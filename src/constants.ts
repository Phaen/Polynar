/**
 * Constants and character sets for Polynar
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
export const DEFAULT_BASE = 3;

/**
 * Full UTF-16 code-unit range. Used wherever a string must round-trip ANY
 * character (the schema's `p.string()` default, and the self-describing `any`
 * encoder for string values and object keys) rather than the compact but
 * ASCII-only `printable` default.
 */
export const UTF16_RANGE: [number, number] = [0, 65535];

export const dates = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'] as const;
export const dateInts = [1000, 60, 60, 24, 7, 4.348214285714286, 12] as const;
