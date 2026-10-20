/**
 * The context tables' map from safe-integer keys to entry indices, and the
 * context hashes they are keyed by.
 */

import { div } from './arith';

/** The slots an `IndexMap` starts with: 2^MAP_BITS. */
const MAP_BITS = 6;

/**
 * Entry indices by key, a safe integer: an open-addressing hash table with
 * linear probing, kept at most half full, which a hot lookup finds faster
 * than a Map does. A slot holds 1 + an index, 0 when empty; the keys stay
 * in the caller's key column `keys` (index to key), passed to every call.
 */
export class IndexMap {
  private slots = new Int32Array(1 << MAP_BITS);
  private mask = (1 << MAP_BITS) - 1;
  /** 32 less the bits a slot takes: a key's home is the top bits of its hash. */
  private shift = 32 - MAP_BITS;
  /** The indices held. */
  size = 0;

  /** The home slot of `key`. */
  private home(key: number): number {
    const low = key >>> 0;
    // Below 2^32 the high word is 0 and mixes in nothing.
    const high = key === low ? 0 : div(key, 4294967296);
    return Math.imul(low ^ Math.imul(high, 0x85ebca6b), 0x9e3779b1) >>> this.shift;
  }

  /** The index of `key`, −1 when absent. */
  get(keys: Float64Array, key: number): number {
    const { slots, mask } = this;
    for (let at = this.home(key); slots[at] !== 0; at = (at + 1) & mask) {
      if (keys[slots[at] - 1] === key) {
        return slots[at] - 1;
      }
    }
    return -1;
  }

  /** Adds index `x`, whose key `keys[x]` is absent. */
  add(keys: Float64Array, x: number): void {
    this.place(keys[x], x);
    this.size++;
    if (2 * this.size > this.slots.length) {
      this.grow(keys);
    }
  }

  /** Puts index `x` in the first empty slot from the home of `key`. */
  private place(key: number, x: number): void {
    const { slots, mask } = this;
    let at = this.home(key);
    while (slots[at] !== 0) {
      at = (at + 1) & mask;
    }
    slots[at] = x + 1;
  }

  /** Doubles the slots, placing every index again. */
  private grow(keys: Float64Array): void {
    const old = this.slots;
    this.slots = new Int32Array(old.length * 2);
    this.mask = old.length * 2 - 1;
    this.shift--;
    for (let i = 0; i < old.length; i++) {
      if (old[i] !== 0) {
        this.place(keys[old[i] - 1], old[i] - 1);
      }
    }
  }
}

/**
 * The 48-bit context hashes of the symbols before position `t`: `out[k]` keys the last k symbols
 * for k = 1..min(n, t); returns that count. Two 32-bit mixes run side by side, the prototype's
 * and a second one with other constants; the key is the first's 32 bits above the second's top
 * 16. The 32-bit operators of the predictor's tables are confined to this function.
 */
export function hashes(seq: Int32Array, t: number, n: number, out: Float64Array): number {
  let h = 0;
  let g = 0;
  let k = 1;
  for (; k <= n && k <= t; k++) {
    const x = seq[t - k] + 0x9e37;
    h = Math.imul(h ^ x, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    g = Math.imul(g ^ x, 0x27d4eb2f);
    g ^= g >>> 15;
    g = Math.imul(g, 0x165667b1);
    out[k] = ((h ^ (h >>> 16)) >>> 0) * 65536 + ((g ^ (g >>> 13)) >>> 16);
  }
  return k - 1;
}
