/**
 * Shared public types.
 */

/**
 * The symbols a message is spelled in: either an explicit string of unique
 * characters, or an inclusive `[min, max]` range of codes. Text output uses
 * the characters themselves; binary output uses their codes as byte values,
 * so every code must be a byte.
 */
export type Charset = string | [number, number];

/** The form of a message: a `Uint8Array` or a string. */
export type OutputType = 'binary' | 'text';

/**
 * How a message is laid out; encoder and decoder must agree on it. Without a
 * type argument it carries no `type`, so one options object fits both
 * `encode` and `decode` of either form.
 */
export interface CodecOptions<T extends OutputType = never> {
  /** The output form, binary when omitted. Decoding reads it off the input, so there it only guides the types. */
  type?: T;
  /** The symbols of the output: bytes 0–255 for binary and Base64 for text when omitted. */
  charset?: Charset;
  /** Block size in bits, 2048 when omitted. */
  blockBits?: number;
}
