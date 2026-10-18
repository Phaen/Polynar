/**
 * A map from safe integers to values, for the lookups an encoder or decoder
 * makes per symbol.
 */

import { div } from './arith';

/** The slots a `KeyMap` starts with: 2^MAP_BITS. */
const MAP_BITS = 6;

/**
 * Values by key, a safe integer: an open-addressing hash table with
 * linear probing, kept at most half full, which a hot lookup finds faster
 * than a Map does. No value is undefined.
 */
export class KeyMap<V> {
  private keys = new Float64Array(1 << MAP_BITS);
  private values: (V | undefined)[] = new Array<V | undefined>(1 << MAP_BITS);
  private mask = (1 << MAP_BITS) - 1;
  /** 32 less the bits a slot takes: a key's home is the top bits of its hash. */
  private shift = 32 - MAP_BITS;
  /** The entries held. */
  size = 0;

  /** The home slot of `key`. */
  private home(key: number): number {
    const low = key >>> 0;
    // Below 2^32 the high word is 0 and mixes in nothing.
    const high = key === low ? 0 : div(key, 4294967296);
    return Math.imul(low ^ Math.imul(high, 0x85ebca6b), 0x9e3779b1) >>> this.shift;
  }

  /** The slot holding `key`, else the empty slot where it would go. */
  private slot(key: number): number {
    const { keys, values, mask } = this;
    let at = this.home(key);
    while (values[at] !== undefined && keys[at] !== key) {
      at = (at + 1) & mask;
    }
    return at;
  }

  get(key: number): V | undefined {
    return this.values[this.slot(key)];
  }

  /** Sets `key`'s value to `value`. */
  set(key: number, value: V): void {
    const at = this.slot(key);
    if (this.values[at] !== undefined) {
      this.values[at] = value;
      return;
    }
    this.keys[at] = key;
    this.values[at] = value;
    this.size++;
    if (2 * this.size > this.values.length) {
      this.grow();
    }
  }

  /** Drops the entry of `key`, shifting back the entries probed past it. */
  delete(key: number): boolean {
    const { keys, values, mask } = this;
    let at = this.slot(key);
    if (values[at] === undefined) {
      return false;
    }
    this.size--;
    for (let next = (at + 1) & mask; values[next] !== undefined; next = (next + 1) & mask) {
      const home = this.home(keys[next]);
      // The entry at `next` may fill the hole at `at` when its home does not
      // lie cyclically within (at, next].
      if (at <= next ? home <= at || home > next : home <= at && home > next) {
        keys[at] = keys[next];
        values[at] = values[next];
        at = next;
      }
    }
    values[at] = undefined;
    return true;
  }

  /** Doubles the slots, placing every entry again. */
  private grow(): void {
    const { keys, values } = this;
    this.keys = new Float64Array(keys.length * 2);
    this.values = new Array<V | undefined>(values.length * 2);
    this.mask = values.length * 2 - 1;
    this.shift--;
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value !== undefined) {
        const at = this.slot(keys[i]);
        this.keys[at] = keys[i];
        this.values[at] = value;
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
