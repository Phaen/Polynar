/**
 * Error types.
 */

/**
 * Thrown when input cannot be decoded: truncated input, trailing padding,
 * characters outside the charset, or a state the encoder never writes.
 * Catching this class separates "bad input" from "bug" at an untrusted-input
 * boundary. Each class names itself, so a printed error says which it is.
 */
export class CorruptInputError extends Error {
  readonly name: string = 'CorruptInputError';
}

/**
 * Thrown when a `p.versioned` schema meets data written by a version it does
 * not list, such as a newer writer.
 */
export class UnknownVersionError extends CorruptInputError {
  readonly name: string = 'UnknownVersionError';

  constructor(
    /** The version the data was written by, counting from 1. */
    readonly version: number,
    /** How many versions the schema knows. */
    readonly known: number
  ) {
    super(`Data was written by version ${version}; this schema knows ${known}`);
  }
}
