/**
 * Shared test utilities for schema node tests.
 */

export const trip = <T>(
  node: { encode(v: T): Uint8Array; decode(b: Uint8Array): T },
  value: T
): T => node.decode(node.encode(value));
