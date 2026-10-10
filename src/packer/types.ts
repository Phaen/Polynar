/**
 * Shared public types.
 */

/**
 * A digit alphabet for text output: either an explicit string of unique
 * characters, or an inclusive `[min, max]` range of UTF-16 code units.
 */
export type Charset = string | [number, number];

/**
 * An inclusive `[min, max]` range of byte values for binary output. Defaults
 * to the whole byte when omitted.
 */
export type ByteRange = [number, number];

/** How `toUint8Array`, `encode` and the byte `Decoder` lay out bytes. */
export interface BinaryOptions {
  /** The byte values the output may use; the whole byte when omitted. */
  range?: ByteRange;
  /** Block size in bits, 2048 when omitted; both sides must agree on it. */
  blockBits?: number;
}

/** How `toString`, `encodeString` and the text `Decoder` lay out text. */
export interface TextOptions {
  /** The digit alphabet; Base64 when omitted. */
  charset?: Charset;
  /** Block size in bits, 2048 when omitted; both sides must agree on it. */
  blockBits?: number;
}
