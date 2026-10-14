/**
 * Values spelled by recall: a value the message has already coded costs its
 * place among the distinct values seen so far, a new one an escape plus its
 * full spelling. `p.any` prices its strings, record keys and record shapes
 * this way.
 */

import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { Fenwick } from './fenwick';
import { readLive, writeLive } from './adaptive';

/** What one message has recalled: the live counts, the values in order of first appearance, and each value's member by key. */
interface Recalled<T> {
  readonly counts: Fenwick;
  readonly values: T[];
  readonly index: Map<string, number>;
}

/**
 * A value spelled by its place among the distinct values this node has coded
 * so far in the message, or as a new value through `inner`. Member 0 of the
 * live table is "new" and starts at a count of 1; every later member is a
 * value in order of first appearance, appended at a count of 1. Each coded
 * member adds 1 to its count, so a value that keeps coming back costs well
 * under a bit and a new one costs the escape plus its spelling. `key` gives
 * the identity values are matched under.
 */
export class PRecall<T> extends PNode<T> {
  readonly _kinds?: readonly Kind[];

  constructor(
    private readonly inner: PNode<T>,
    private readonly key: (value: T) => string,
    private readonly who: string
  ) {
    super();
    this._kinds = inner._kinds;
  }

  private _state(side: Encoder | Decoder): Recalled<T> {
    return side.state(this, () => ({ counts: new Fenwick([1]), values: [], index: new Map() }));
  }

  _write(enc: Encoder, value: T): void {
    const { counts, values, index } = this._state(enc);
    const k = this.key(value);
    const member = index.get(k);
    if (member !== undefined) {
      writeLive(enc, counts, member);
      counts.add(member, 1);
      return;
    }
    // The message's first value meets a table of one member, "new", which
    // writeLive spells with nothing; readLive reads it back the same way.
    writeLive(enc, counts, 0);
    counts.add(0, 1);
    this.inner._write(enc, value);
    counts.push(1);
    values.push(value);
    index.set(k, values.length);
  }

  _read(dec: Decoder): T {
    const { counts, values, index } = this._state(dec);
    const member = readLive(dec, counts);
    counts.add(member, 1);
    if (member > 0) {
      return values[member - 1];
    }
    const value = this.inner._read(dec);
    const k = this.key(value);
    counts.push(1);
    values.push(value);
    index.set(k, values.length);
    return value;
  }
}
