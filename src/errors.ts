/**
 * Error types.
 */

/**
 * Thrown when decode input is not the canonical encoding of a value: tampered
 * digits, truncation, trailing padding, or characters outside the charset.
 * Catching this class separates "bad input" from "bug" at an untrusted-input
 * boundary. The literal `name` doubles as a stable discriminant
 * (`err.name === 'CorruptInputError'`) for contexts where `instanceof` can
 * fail, such as two package copies in one process.
 */
export class CorruptInputError extends Error {
  readonly name = 'CorruptInputError';
}
