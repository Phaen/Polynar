/**
 * The coded distribution of one step (spec §6.1): entries sorted by symbol id, ESCAPE last, with
 * integer frequencies of at least 1 summing to `total` (spec §5.5) and their prefix sums. It is
 * both the encoder's lookup and the decoder's `MemberTable`. One instance serves every step of a
 * predictor; its arrays grow and never shrink.
 */
import { PB, POW2, clampi, mulDiv, scaleDown, shr } from './arith';
import { ESCAPE } from './types';
import type { MemberLike } from './types';

/** Bits of a mass after the quantisation's own scaling, so that mass · (room − 1) < 2^52. */
const QB = 27;
/** Bits of the entry index inside a sort key (entries never exceed total / 2 <= 2^23). */
const KB = 24;

export class Distribution implements MemberLike {
  /** The quantisation total of the current step. */
  total = 0;
  /** Entries of the finished table, ESCAPE included. */
  n = 0;
  /** ESCAPE is entry n − 1 when true. */
  hasEscape = false;
  /** Symbol id per entry, ascending, then ESCAPE. */
  ids = new Int32Array(16);
  /** Frequency per entry. */
  freqs = new Int32Array(16);
  /** cums[i] is the sum of freqs[0..i). */
  cums = new Int32Array(17);
  private added = 0;
  private masses = new Float64Array(16);
  private sorted = new Float64Array(16);
  private keys = new Float64Array(16);

  /** Starts a step: no entries, coded with `total` and an ESCAPE entry when `hasEscape`. */
  begin(total: number, hasEscape: boolean): void {
    this.total = total;
    this.hasEscape = hasEscape;
    this.added = 0;
    this.n = 0;
  }

  /** One entry: a symbol id (>= 0, each at most once per step) and its integer mass (< 2^52). */
  add(id: number, mass: number): void {
    if (this.added + 1 === this.ids.length) this.grow();
    this.ids[this.added] = id;
    this.masses[this.added] = mass;
    this.added++;
  }

  private grow(): void {
    const size = this.ids.length * 2;
    const ids = new Int32Array(size);
    ids.set(this.ids);
    this.ids = ids;
    const masses = new Float64Array(size);
    masses.set(this.masses);
    this.masses = masses;
    this.freqs = new Int32Array(size);
    this.cums = new Int32Array(size + 1);
    this.sorted = new Float64Array(size);
    this.keys = new Float64Array(size);
  }

  /**
   * Sorts the entries by id, appends ESCAPE with `escapeMass` when the step has one, and turns
   * the masses into frequencies: after scaling the masses below 2^27, f = 1 + floor(P · (room − 1)
   * / Z) with room = total − n, and the remainder goes to the largest mass (lowest index on
   * ties). A zero total mass leaves every entry at 1 and the remainder on entry 0.
   */
  finish(escapeMass: number): void {
    const m = this.added;
    const n = this.hasEscape ? m + 1 : m;
    const total = this.total;
    if (n === 0 || 2 * n > total) {
      throw new RangeError(`distribution: ${n} entries do not fit a total of ${total}`);
    }
    const keys = this.keys;
    const ids = this.ids;
    const P = this.sorted;
    const scale = POW2[KB];
    for (let i = 0; i < m; i++) keys[i] = ids[i] * scale + i;
    keys.subarray(0, m).sort();
    for (let i = 0; i < m; i++) {
      const id = shr(keys[i], KB);
      ids[i] = id;
      P[i] = this.masses[keys[i] - id * scale];
    }
    if (this.hasEscape) {
      ids[m] = ESCAPE;
      P[m] = escapeMass;
    }
    this.n = n;
    scaleDown(P, n, QB);
    let z = 0;
    let best = 0;
    for (let i = 0; i < n; i++) {
      z += P[i];
      if (P[i] > P[best]) best = i;
    }
    const freqs = this.freqs;
    const room = total - n;
    let used = 0;
    for (let i = 0; i < n; i++) {
      const f = z === 0 ? 1 : 1 + mulDiv(P[i], room - 1, z);
      freqs[i] = f;
      used += f;
    }
    freqs[best] += total - used;
    this.sums();
  }

  /**
   * Gives entry `top` the PB-bit share `f16` of the total (spec §5.6) and rescales the other
   * entries' frequencies above their floor of 1 into what remains; the remainder of the floors
   * goes to `top`.
   */
  rescaleTop(top: number, f16: number): void {
    const { n, total, freqs } = this;
    const others = n - 1;
    const target = clampi(mulDiv(f16, total, POW2[PB]), 1, total - others);
    const before = total - freqs[top] - others;
    const after = total - target - others;
    let used = 0;
    for (let j = 0; j < n; j++) {
      if (j === top) continue;
      if (before > 0) freqs[j] = 1 + mulDiv(freqs[j] - 1, after, before);
      used += freqs[j];
    }
    freqs[top] = total - used;
    this.sums();
  }

  private sums(): void {
    const { n, freqs, cums } = this;
    cums[0] = 0;
    for (let i = 0; i < n; i++) cums[i + 1] = cums[i] + freqs[i];
  }

  /** The entry of symbol `id`, ESCAPE's entry for ESCAPE, −1 when absent. */
  indexOf(id: number): number {
    if (id === ESCAPE) return this.hasEscape ? this.n - 1 : -1;
    const ids = this.ids;
    let lo = 0;
    let hi = this.hasEscape ? this.n - 2 : this.n - 1;
    while (lo <= hi) {
      const mid = shr(lo + hi, 1);
      if (ids[mid] < id) lo = mid + 1;
      else if (ids[mid] > id) hi = mid - 1;
      else return mid;
    }
    return -1;
  }

  /** The symbol id of entry `i` (ESCAPE for the escape entry). */
  idAt(i: number): number {
    return this.ids[i];
  }

  /** The entry whose interval holds `residual` in [0, total): the largest i with cums[i] <= it. */
  locate(residual: number): number {
    const cums = this.cums;
    let lo = 0;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = shr(lo + hi + 1, 1);
      if (cums[mid] <= residual) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  cum(i: number): number {
    return this.cums[i];
  }

  freq(i: number): number {
    return this.freqs[i];
  }
}
