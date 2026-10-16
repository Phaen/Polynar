import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import { atPath } from './path';
import type { Kind } from './guards';
import { IndexRange, checkUnset, lengthRange, type LengthBounds } from './lattice';
import type { Cdf } from './weights';
import type { LearningOptions, Learning } from './adaptive';
import {
  checkOrder,
  ordinal,
  ordinalDigits,
  readOrdinal,
  writeOrdinal,
  type Order,
} from './ordinal';
import { readRun, writeRun } from './runs';
import { CONTAINER_METHODS, learningOf, MethodNode, recallOf, type MethodSet } from './methods';
import { copy, identity, type Recall } from './recall';
import { PString } from './string';

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
  /**
   * The node the keys go through under `.adaptive()`, for a layout whose
   * keys have no node of the caller's to adapt; the declared key otherwise.
   */
  learnedKey?(learning: Learning): PNode<any>;
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
  learnedKey: (learning) => new PString().adaptive(learning),
};

/**
 * A Map, a Set or a plain-object record: a count, then each entry's key and,
 * for a map or record, its value. The count travels like an array's length,
 * through the shared integer lattice with bounds `[min ?? 0, max]`.
 * `p.map`, `p.record` and `p.set` differ only in their `Layout`.
 */
export class PCollection<T> extends MethodNode<T> {
  readonly _kinds: readonly Kind[];

  private readonly _layout: Layout<T>;
  /** The key as declared. */
  private readonly _key: PNode<any>;
  /** The key entries are written through: the layout's learned key under `.adaptive()`, if it has one. */
  private readonly _keys: PNode<any>;
  /** The value node; a set has none. */
  private readonly _value?: PNode<any>;
  private readonly _bounds: LengthBounds;
  private readonly _count: IndexRange;
  /** Set by `.unordered()`. */
  private readonly _unordered?: true;
  /** The methods the node has, declared or open. */
  readonly _methods: MethodSet;
  readonly _methodNames = CONTAINER_METHODS;
  /** Set by `.recall()` or opened: learned where the node learns. */
  private readonly _recall?: Recall<T>;

  constructor(
    layout: Layout<T>,
    key: PNode<any>,
    value?: PNode<any>,
    bounds: LengthBounds = {},
    unordered?: true,
    methods: MethodSet = {}
  ) {
    super();
    this._layout = layout;
    this._key = key;
    const learning = learningOf(methods);
    this._keys =
      learning === undefined || layout.learnedKey === undefined ? key : layout.learnedKey(learning);
    this._value = value;
    this._bounds = bounds;
    this._count = lengthRange(bounds, layout.who, 'count', learning);
    this._kinds = [layout.kind];
    this._unordered = unordered;
    this._methods = methods;
    this._recall = recallOf(methods, copy);
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
   * weights, or even ones when none are, are the starting point, and each
   * entry count coded counts as one observation, so an entry count that keeps
   * recurring gets cheaper as the message goes on. From its second value on,
   * the node spends one bit to stay static, or a few to name the learning rate
   * that paid off. Without a max, the count learns on the magnitude scale from
   * the min instead: by its distance's bit-length class. Takes weights, not a
   * cdf; part of the wire format, like the weights. A record's keys learn as
   * under `p.string().adaptive()`: keys that recur are recalled and new ones
   * learn their characters with the message's other strings.
   */
  learn(): PCollection<T> {
    return this._declare('learn', this._layout.who);
  }

  /**
   * What the node's learning goes by, for `.learn()` and the methods that
   * learn: `window` is how many observations a table's counts hold before
   * they halve, so the newest weigh most (1024 when left out, and raised to
   * the number of values counted when smaller), and `separate` keeps its
   * tables from starting where other nodes of its kind and window got to.
   * Set once.
   */
  learning(options: LearningOptions): PCollection<T> {
    return this._learning(options, this._layout.who);
  }

  /**
   * Learn with every method the node has: `.learn()`, and `.recall()` opens to
   * a learned choice per value unless declared, under `options` as
   * `.learning()` takes them.
   */
  adaptive(options?: LearningOptions): PCollection<T> {
    return this._adapt(options, this._layout.who);
  }

  /**
   * Let the insertion order go: entries encode in any order and decode in
   * ascending key order, by the key's value order, which saves what the
   * order would cost, as `p.array` orders its items under `.unordered()`.
   * Takes keys (a set's items) of p.string, or of bounded p.int, p.date or
   * p.decimal, p.enum or p.bool without weights or adaptive.
   */
  unordered(): PCollection<T> {
    const { who } = this._layout;
    checkUnset(this._unordered, who, 'unordered');
    checkOrder(this._key, who, 'unordered', this._value === undefined ? 'items' : 'keys');
    return this._with(this._bounds, true);
  }

  /**
   * Spell a collection this node already wrote in the message by its place
   * among the distinct collections it wrote, and a new one as an escape and
   * then in full: with n collections seen, a repeat costs log2(n + 1) bits,
   * less the more often it recurs. The message's
   * first collection costs nothing extra. Collections the schema writes the
   * same way are the same collection, and a repeat decodes as a copy
   * of the collection first decoded.
   */
  recall(): PCollection<T> {
    return this._declare('recall', this._layout.who);
  }

  /** This node with `methods` in place of its own. */
  _withMethods(methods: MethodSet): PCollection<T> {
    return this._with(this._bounds, this._unordered, methods);
  }

  private _with(
    bounds: LengthBounds,
    unordered = this._unordered,
    methods = this._methods
  ): PCollection<T> {
    const { _layout, _key, _value } = this;
    return new PCollection<T>(_layout, _key, _value, bounds, unordered, methods);
  }

  /**
   * Where an entry sits in an error: a map or record entry with a string key
   * by its key, a set's item and any other entry by its position.
   */
  private _segment(key: unknown, i: number): string | number {
    return this._value !== undefined && typeof key === 'string' ? key : i;
  }

  _write(enc: Encoder, value: T): void {
    const recall = this._recall;
    if (recall === undefined) {
      this._spell(enc, value);
    } else {
      const key = () => identity((alone) => this._spell(alone, value));
      recall.write(enc, key, () => this._spell(enc, value));
    }
  }

  _read(dec: Decoder): T {
    const recall = this._recall;
    return recall === undefined ? this._unspell(dec) : recall.read(dec, () => this._unspell(dec));
  }

  /** Writes the collection in full. */
  private _spell(enc: Encoder, value: T): void {
    const { name } = this._layout;
    const size = this._layout.size(value);
    this._count.write(enc, size, () => `${name} size ${size}`);
    this._count.learn(enc, size);
    if (this._unordered !== undefined) {
      const entries = [...this._layout.entries(value)];
      const keys = entries.map(([key]) => key);
      const segment = (j: number): string | number => this._segment(keys[j], j);
      let at: number[];
      // checkOrder accepted the key when the collection was made unordered.
      if (ordinal(this._keys)) {
        const ordered = ordinalDigits(this._keys, keys, UNORDERED, segment);
        writeOrdinal(enc, ordered.digits, this._keys._radix as number, UNORDERED);
        at = ordered.at;
      } else {
        at = writeRun(enc, this._keys, keys, UNORDERED, segment);
      }
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
        this._keys._write(enc, key);
        this._value?._write(enc, item);
      } catch (error) {
        throw atPath(error, this._segment(key, i));
      }
      i++;
    }
  }

  /** Reads a collection `_spell` wrote. */
  private _unspell(dec: Decoder): T {
    const count = this._count.read(dec);
    this._count.learn(dec, count);
    dec.charge(count);
    const entries = new Map<unknown, unknown>();
    if (this._unordered !== undefined) {
      const keys = this._keys;
      if (!ordinal(keys)) {
        for (const key of readRun(dec, keys, count, UNORDERED)) {
          entries.set(key, this._value?._read(dec));
        }
        return this._layout.build(entries);
      }
      const fromDigit = keys._fromDigit as (digit: number) => unknown;
      for (const digit of readOrdinal(dec, keys._radix as number, count, UNORDERED)) {
        entries.set(fromDigit.call(keys, digit), this._value?._read(dec));
      }
      return this._layout.build(entries);
    }
    for (let i = 0; i < count; i++) {
      const key = this._keys._read(dec);
      // A repeated key overwrites, as it does in an object literal.
      entries.set(key, this._value?._read(dec));
    }
    return this._layout.build(entries);
  }
}
