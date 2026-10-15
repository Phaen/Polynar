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
  /** Width of the checksum in bits, 1 to 32; none when omitted. */
  checksum?: number;
}

/** What decoding takes: the message's layout, and how much it may read past its end. */
export interface DecodeOptions<T extends OutputType = never> extends CodecOptions<T> {
  /**
   * How many values a decode may read after its input runs out, where every
   * value reads as zero for free; 2^26 when omitted, `Infinity` for no limit.
   */
  limit?: number;
}

declare const radixBrand: unique symbol;
declare const baseBrand: unique symbol;

/**
 * An integer radix in [1, 2^53): the states of one symbol. Only the radix
 * and total checks of the Encoder and Decoder produce one, so code taking a
 * `Radix` relies on that domain without checking it again.
 */
export type Radix = number & { readonly [radixBrand]: true };

/** A digit base: the size of an output charset, an integer in [2, 65536]. */
export type Base = Radix & { readonly [baseBrand]: true };

/** A weighted symbol's bucket: `[cum, cum + freq)` out of `total` states, as composeWeighted takes it. */
export type Bucket = readonly [cum: number, freq: number, total: number];
