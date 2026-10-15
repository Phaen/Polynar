/**
 * Values spelled by recall: a value the node has already coded in the
 * message costs its place among the distinct values seen so far, a new one
 * an escape plus its full spelling. `.recall()` on a node puts it in front
 * of the node's own spelling; `p.any` prices its strings, record keys and
 * record shapes this way.
 */

import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { Fenwick } from './fenwick';
import { readLive, writeLive } from './adaptive';

/**
 * The identity a value is recalled under: the symbols a fresh message
 * holding only the value logs as `write` spells it, each its bucket and
 * total. Values with the same spelling decode the same, so recalling one
 * for the other changes nothing the decoder sees. Throws whatever `write`
 * throws.
 */
export function identity(write: (enc: Encoder) => void): string {
  const enc = new Encoder();
  write(enc);
  const { cums, freqs, totals, weighted } = enc.events();
  let key = '';
  for (let i = 0; i < totals.length; i++) {
    key += weighted[i] ? `${cums[i]}+${freqs[i]}/${totals[i]},` : `${cums[i]}/${totals[i]},`;
  }
  return key;
}

/**
 * A deep copy of a decoded value, made in the caller's realm, for a recall
 * whose values may be mutated: plain objects (an own `__proto__` key kept
 * as one, a null prototype kept), arrays, Maps (keys and values), Sets,
 * Dates, RegExps, ArrayBuffers, DataViews and typed arrays copy, their
 * contents copied in turn. Primitives and instances of any other class
 * pass through as they are.
 */
export function copy<T>(value: T): T {
  return clone(value) as T;
}

/** `copy` over any value. */
function clone(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(clone);
  }
  if (value instanceof Map) {
    return new Map([...value].map(([key, item]) => [clone(key), clone(item)]));
  }
  if (value instanceof Set) {
    return new Set([...value].map(clone));
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof RegExp) {
    return new RegExp(value);
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }
  if (value instanceof DataView) {
    const { buffer, byteOffset, byteLength } = value;
    return new DataView(buffer.slice(byteOffset, byteOffset + byteLength));
  }
  if (ArrayBuffer.isView(value)) {
    // `from` copies the view's elements into a buffer of its own, and keeps
    // the class, a Buffer included.
    return (value.constructor as unknown as { from(items: unknown): unknown }).from(value);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  const out: Record<string, unknown> = Object.create(proto as object | null);
  for (const key of Object.keys(value)) {
    // Defined rather than assigned, so a '__proto__' key lands as an own property.
    Object.defineProperty(out, key, {
      value: clone((value as Record<string, unknown>)[key]),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

/** What the encoder knows of one message's recall: each value's member by identity, and the live counts when learned. */
interface Writing {
  readonly index: Map<string, number>;
  readonly counts?: Fenwick;
}

/** What the decoder knows of one message's recall: the values in order of first appearance, and the live counts when learned. */
interface Reading<T> {
  readonly values: T[];
  readonly counts?: Fenwick;
}

/**
 * The recall of one node: member 0 of its table is "new", every later
 * member a value the node coded in the message, in order of first
 * appearance. A recalled value costs its member, a new one member 0 and
 * then its spelling. With fixed odds every member is equally likely, so
 * with `n` values seen a member costs log2(n + 1) bits; `learned`, the
 * members are counted as the message goes on, "new" and every value
 * starting at a count of 1 and gaining 1 each time it is coded, so a value
 * that keeps coming back costs well under a bit. The message's first value
 * meets a table of one member, which costs nothing. The encoder matches
 * values by an identity string, `identity` unless the caller has a cheaper
 * one; the decoder needs none.
 */
export class Recall<T> {
  /** `copy` turns a recalled value into what `read` returns; the value itself when left out. */
  constructor(
    readonly learned: boolean,
    private readonly copy?: (value: T) => T
  ) {}

  private writing(enc: Encoder): Writing {
    return enc.state(this, () => ({
      index: new Map(),
      counts: this.learned ? new Fenwick([1], enc.journal) : undefined,
    }));
  }

  private reading(dec: Decoder): Reading<T> {
    return dec.state(this, () => ({
      values: [],
      counts: this.learned ? new Fenwick([1]) : undefined,
    }));
  }

  /**
   * Writes the member of the value whose identity is `key`, or member 0
   * and then `spell()` when the node has not coded it in the message.
   * Returns whether the value was recalled.
   */
  write(enc: Encoder, key: string, spell: () => void): boolean {
    const { index, counts } = this.writing(enc);
    const member = index.get(key);
    const seen = index.size;
    if (counts === undefined) {
      enc.compose(member ?? 0, seen + 1);
    } else {
      writeLive(enc, counts, member ?? 0);
      counts.add(member ?? 0, 1);
    }
    if (member !== undefined) {
      return true;
    }
    spell();
    counts?.push(1);
    index.set(key, seen + 1);
    if (enc.journal.active) {
      enc.journal.drop(index, key);
    }
    return false;
  }

  /**
   * Reads a value `write` wrote: a recalled value as `copy` makes it from
   * the one first decoded, or a new one read by `spell()`.
   */
  read(dec: Decoder, spell: () => T): T {
    const { values, counts } = this.reading(dec);
    let member: number;
    if (counts === undefined) {
      member = dec.parse(values.length + 1);
    } else {
      member = readLive(dec, counts);
      counts.add(member, 1);
    }
    if (member > 0) {
      const value = values[member - 1];
      return this.copy === undefined ? value : this.copy(value);
    }
    const value = spell();
    counts?.push(1);
    values.push(value);
    return value;
  }
}

/**
 * A value spelled by its place among the distinct values coded so far in
 * the message through `recall`, or as a new value through `inner`, under
 * learned odds. `key` gives the identity values are matched under. A
 * recall of its own unless given one, which nodes with different spellings
 * may share, so a value one of them coded recalls through any of them.
 */
export class PRecall<T> extends PNode<T> {
  readonly _kinds?: readonly Kind[];

  constructor(
    private readonly inner: PNode<T>,
    private readonly key: (value: T) => string,
    private readonly recall = new Recall<T>(true)
  ) {
    super();
    this._kinds = inner._kinds;
  }

  _write(enc: Encoder, value: T): void {
    this.recall.write(enc, this.key(value), () => this.inner._write(enc, value));
  }

  _read(dec: Decoder): T {
    return this.recall.read(dec, () => this.inner._read(dec));
  }
}
