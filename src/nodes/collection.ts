import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { atPath } from './path';
import type { Kind } from './guards';
import { IndexRange, checkUnset, lengthRange, type LengthBounds } from './lattice';
import type { Cdf } from './weights';
import type { AdaptiveOptions } from './adaptive';
import { checkOrdinal, ordinalDigits, readOrdinal, writeOrdinal, type Order } from './ordinal';

/** The keys of an unordered collection: distinct by construction, so a set of digits. */
const UNORDERED: Order = { unordered: true, unique: true };

/**
 * How one JS collection type sits on the collection wire: how many entries
 * it holds, which entries it lists in which order, and how a decoded run of
 * entries becomes the collection again.
 */
export interface Layout<T> {
  /** The factory, as schema errors name it. */
  readonly who: string;
  /** The collection, as value errors name it. */
  readonly name: string;
  readonly kind: Kind;
  size(value: T): number;
  /** Each key with its value, in write order. A set's item is its own key and value. */
  entries(value: T): Iterable<readonly [unknown, unknown]>;
  /** The collection of `entries`, whose keys are distinct and never -0. */
  build(entries: Map<unknown, unknown>): T;
}

export const MAP: Layout<Map<any, any>> = {
  who: 'p.map',
  name: 'Map',
  kind: 'map',
  size: (value) => value.size,
  entries: (value) => value.entries(),
  build: (entries) => entries,
};

export const SET: Layout<Set<any>> = {
  who: 'p.set',
  name: 'Set',
  kind: 'set',
  size: (value) => value.size,
  entries: (value) => value.entries(),
  build: (entries) => new Set(entries.keys()),
};

export const RECORD: Layout<Record<string, any>> = {
  who: 'p.record',
  name: 'Record',
  kind: 'object',
  size: (value) => Object.keys(value).length,
  entries: (value) => Object.entries(value),
  build: (entries) => {
    // fromEntries defines own properties, so a '__proto__' key lands as one
    // instead of replacing the prototype.
    return Object.fromEntries(entries);
  },
};

/**
 * A Map, a Set or a plain-object record: a count, then each entry's key and,
 * for a map or record, its value. The count travels like an array's length,
 * through the shared integer lattice with bounds `[min ?? 0, max]`.
 * `p.map`, `p.record` and `p.set` differ only in their `Layout`.
 */
export class PCollection<T> extends PNode<T> {
  readonly _kinds: readonly Kind[];

  private readonly _layout: Layout<T>;
  private readonly _key: PNode<any>;
  /** The value node; a set has none. */
  private readonly _value?: PNode<any>;
  private readonly _bounds: LengthBounds;
  private readonly _count: IndexRange;
  /** Set by `.unordered()`. */
  private readonly _unordered?: true;

  constructor(
    layout: Layout<T>,
    key: PNode<any>,
    value?: PNode<any>,
    bounds: LengthBounds = {},
    unordered?: true
  ) {
    super();
    this._layout = layout;
    this._key = key;
    this._value = value;
    this._bounds = bounds;
    this._count = lengthRange(bounds, layout.who, 'count');
    this._kinds = [layout.kind];
    this._unordered = unordered;
  }

  /** Require at least `n` entries. A raised floor packs the count denser. */
  min(n: number): PCollection<T> {
    checkUnset(this._bounds.min, this._layout.who, 'min');
    return this._with({ ...this._bounds, min: n });
  }

  /** Cap the entry count. A capped count packs denser than the uncapped prefix. */
  max(n: number): PCollection<T> {
    checkUnset(this._bounds.max, this._layout.who, 'max');
    return this._with({ ...this._bounds, max: n });
  }

  /**
   * Fix the exact entry count, the same as `.min(n).max(n)`. The count then
   * costs zero bits on the wire.
   */
  length(n: number): PCollection<T> {
    checkUnset(this._bounds.min, this._layout.who, 'min');
    checkUnset(this._bounds.max, this._layout.who, 'max');
    return this._with({ ...this._bounds, min: n, max: n });
  }

  /**
   * Declare a prior over the entry COUNT as an integer CDF: `fn(n)` is the
   * cumulative weight of counts below `n`. Requires a max; a zero-weight
   * count cannot encode.
   */
  cdf(fn: Cdf): PCollection<T> {
    return this._with({ ...this._bounds, prior: fn });
  }

  /**
   * Declare how likely each count from min (or 0) to max is, lowest first.
   * Same prior as `.cdf()`, given as the histogram instead of its running
   * total.
   */
  weights(w: readonly number[]): PCollection<T> {
    return this._with({ ...this._bounds, prior: w });
  }

  /**
   * Let the prior over the entry count learn from the message: the declared
   * weights, or even ones when none are, are the starting point, and each entry
   * count coded counts as one observation, so an entry count that keeps
   * recurring gets cheaper as the message goes on. `window` is how many
   * observations the counts hold before they halve, so the newest weigh most
   * (1024 when left out, and raised to the number of values it counts when
   * smaller). From its second value on, the node spends one bit to stay static,
   * or a few to name the learning rate that paid off. Requires a max and takes
   * weights, not a cdf; part of the wire format, like the weights.
   */
  adaptive(options?: AdaptiveOptions): PCollection<T> {
    return this._with({ ...this._bounds, adaptive: options ?? {} });
  }

  /**
   * Let the insertion order go: entries encode in any order and decode in
   * ascending key order, by the key's value order, which saves what the
   * order would cost. Takes keys (a set's items) of bounded p.int, p.date or
   * p.decimal, or of p.enum or p.bool, without weights or adaptive.
   */
  unordered(): PCollection<T> {
    const { who } = this._layout;
    checkUnset(this._unordered, who, 'unordered');
    checkOrdinal(this._key, who, 'unordered', this._value === undefined ? 'items' : 'keys');
    return this._with(this._bounds, true);
  }

  private _with(bounds: LengthBounds, unordered = this._unordered): PCollection<T> {
    return new PCollection<T>(this._layout, this._key, this._value, bounds, unordered);
  }

  /**
   * Where an entry sits in an error: a map or record entry with a string key
   * by its key, a set's item and any other entry by its position.
   */
  private _segment(key: unknown, i: number): string | number {
    return this._value !== undefined && typeof key === 'string' ? key : i;
  }

  _write(enc: Encoder, value: T): void {
    const { name } = this._layout;
    const size = this._layout.size(value);
    this._count.write(enc, size, () => `${name} size ${size}`);
    if (this._unordered !== undefined) {
      const entries = [...this._layout.entries(value)];
      const keys = entries.map(([key]) => key);
      // checkOrdinal accepted the key when the collection was made unordered.
      const { digits, at } = ordinalDigits(this._key, keys, UNORDERED, (j) =>
        this._segment(keys[j], j)
      );
      writeOrdinal(enc, digits, this._key._radix as number, UNORDERED);
      for (const j of at) {
        try {
          this._value?._write(enc, entries[j][1]);
        } catch (error) {
          throw atPath(error, this._segment(keys[j], j));
        }
      }
      return;
    }
    let i = 0;
    for (const [key, item] of this._layout.entries(value)) {
      try {
        this._key._write(enc, key);
        this._value?._write(enc, item);
      } catch (error) {
        throw atPath(error, this._segment(key, i));
      }
      i++;
    }
  }

  _read(dec: Decoder): T {
    const count = this._count.read(dec);
    const entries = new Map<unknown, unknown>();
    if (this._unordered !== undefined) {
      const keys = this._key;
      const fromDigit = keys._fromDigit as (digit: number) => unknown;
      for (const digit of readOrdinal(dec, keys._radix as number, count, UNORDERED)) {
        entries.set(fromDigit.call(keys, digit), this._value?._read(dec));
      }
      return this._layout.build(entries);
    }
    for (let i = 0; i < count; i++) {
      const key = this._key._read(dec);
      // A repeated key overwrites, as it does in an object literal.
      entries.set(key, this._value?._read(dec));
    }
    return this._layout.build(entries);
  }
}
