/**
 * Shared public types.
 */

/**
 * A digit alphabet for text output: either an explicit string of unique
 * characters, or an inclusive `[min, max]` range of UTF-16 code units.
 */
export type Charset = string | [number, number];
