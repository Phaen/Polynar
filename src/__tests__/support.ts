/**
 * Shared test utilities.
 */

export const trip = <T>(
  node: { encode(v: T): Uint8Array; decode(b: Uint8Array): T },
  value: T
): T => node.decode(node.encode(value));

/** A seeded generator of floats in [0, 1), so every run sees the same cases. */
export const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
