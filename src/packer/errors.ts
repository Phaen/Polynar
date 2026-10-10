/**
 * Error types.
 */

/**
 * Thrown when decode input is not the canonical encoding of a value, such as
 * truncated input, trailing padding, or characters outside the charset.
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
}
