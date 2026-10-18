/**
 * The symbol ids of one message (spec §4.3). Ids 0..35 are the fixed END, structure and DIGIT
 * symbols, 36..291 the bytes, and code points take the next ids in order of first reference.
 */

import { shr } from './arith';
import { BYTE_BASE, CP_BASE, DIGIT, END } from './types';
import type { LoadedPrior } from './types';
import { CASE_PAIRS, CASE_PAIRS_BY_UPPER, LN_RANGES } from './unicode-tables';

const MAX_CP = 0x10ffff;
const NEWLINE = 10;
const SPACE = 32;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const PARTNER_UNKNOWN = -2;
const BOUNDARY_UNKNOWN = 2;

/** The value paired with `key` in a table of alternating [key, value] sorted by key, or -1. */
function lookup(table: Int32Array, key: number): number {
  let lo = 0;
  let hi = shr(table.length, 1) - 1;
  while (lo <= hi) {
    const mid = shr(lo + hi, 1);
    const k = table[2 * mid];
    if (k === key) return table[2 * mid + 1];
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** The code point that differs from `cp` only in case, or -1 when the pair is not one-to-one. */
export function casePartnerCp(cp: number): number {
  const up = lookup(CASE_PAIRS, cp);
  return up >= 0 ? up : lookup(CASE_PAIRS_BY_UPPER, cp);
}

/** Whether `cp` matches /[\p{L}\p{N}]/u. */
export function isLetterOrNumberCp(cp: number): boolean {
  let lo = 0;
  let hi = shr(LN_RANGES.length, 1) - 1;
  while (lo <= hi) {
    const mid = shr(lo + hi, 1);
    if (cp < LN_RANGES[2 * mid]) hi = mid - 1;
    else if (cp > LN_RANGES[2 * mid + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * The id table of one message. Assignment order: the fixed ids, the prior's symbols in order,
 * then '0'..'9', '\n' and ' ' where not already present, then code points by first reference.
 * Lone surrogates are ordinary code points under their code unit value.
 */
export class Ids {
  private readonly cps: number[] = [];
  private readonly map = new Map<number, number>();
  private partners = new Int32Array(CP_BASE * 2).fill(PARTNER_UNKNOWN);
  private boundaries = new Uint8Array(CP_BASE * 2).fill(BOUNDARY_UNKNOWN);
  private readonly digits = new Int32Array(10);
  private readonly boundary = new Int32Array(3);

  constructor(prior: LoadedPrior | null) {
    for (let id = 0; id < BYTE_BASE; id++) this.cps.push(-1);
    for (let b = 0; b < 256; b++) this.cps.push(b);
    if (prior !== null) for (const cp of prior.builtinSymbols) this.idOf(cp);
    for (let d = 0; d < 10; d++) this.digits[d] = this.idOf(DIGIT_0 + d);
    this.boundary[0] = END;
    this.boundary[1] = this.idOf(NEWLINE);
    this.boundary[2] = this.idOf(SPACE);
  }

  /** The id of a code point, assigning the next free id on first reference. */
  idOf(cp: number): number {
    let id = this.map.get(cp);
    if (id === undefined) {
      if (!Number.isInteger(cp) || cp < 0 || cp > MAX_CP) {
        throw new RangeError(`code point out of range: ${cp}`);
      }
      id = this.cps.length;
      this.cps.push(cp);
      this.map.set(cp, id);
    }
    return id;
  }

  /** The fixed id of a byte value. */
  byteId(b: number): number {
    if (!Number.isInteger(b) || b < 0 || b > 255) throw new RangeError(`byte out of range: ${b}`);
    return BYTE_BASE + b;
  }

  has(cp: number): boolean {
    return this.map.has(cp);
  }

  /** The code point of an id, the byte value of a byte id, or -1 for END and structure ids. */
  cpOf(id: number): number {
    return id >= 0 && id < this.cps.length ? this.cps[id] : -1;
  }

  size(): number {
    return this.cps.length;
  }

  /** The id of the case partner (assigned on first reference), or -1. */
  partner(id: number): number {
    if (id < CP_BASE || id >= this.cps.length) return -1;
    this.partners = grow(this.partners, id, PARTNER_UNKNOWN);
    let r = this.partners[id];
    if (r === PARTNER_UNKNOWN) {
      const cp = casePartnerCp(this.cps[id]);
      r = cp < 0 ? -1 : this.idOf(cp);
      this.partners[id] = r;
    }
    return r;
  }

  /** END, structure ids and bytes are boundaries, as are code points that are no letter or number. */
  isBoundary(id: number): boolean {
    if (id < CP_BASE || id >= this.cps.length) return true;
    this.boundaries = grow(this.boundaries, id, BOUNDARY_UNKNOWN);
    let r = this.boundaries[id];
    if (r === BOUNDARY_UNKNOWN) {
      r = isLetterOrNumberCp(this.cps[id]) ? 0 : 1;
      this.boundaries[id] = r;
    }
    return r === 1;
  }

  isDigit(id: number): boolean {
    const cp = id >= CP_BASE ? this.cpOf(id) : -1;
    return cp >= DIGIT_0 && cp <= DIGIT_9;
  }

  isBoundaryClass(id: number): boolean {
    return id === END || id === this.boundary[1] || id === this.boundary[2];
  }

  /** Digit ids map to DIGIT and END to the newline id; every other id stays. */
  foldDigit(id: number): number {
    if (id === END) return this.boundary[1];
    return this.isDigit(id) ? DIGIT : id;
  }

  /** The ids of '0'..'9'. The array is shared. */
  digitIds(): Int32Array {
    return this.digits;
  }

  /** The ids of END, '\n' and ' '. The array is shared. */
  boundaryIds(): Int32Array {
    return this.boundary;
  }

  newlineId(): number {
    return this.boundary[1];
  }
}

/** `arr` or a doubled copy that holds `index`, new cells set to `fill`. */
function grow<T extends Int32Array | Uint8Array>(arr: T, index: number, fill: number): T {
  if (index < arr.length) return arr;
  let n = arr.length;
  while (n <= index) n += n;
  const next = new (arr.constructor as new (n: number) => T)(n);
  next.fill(fill);
  next.set(arr);
  return next;
}
