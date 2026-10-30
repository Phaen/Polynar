import { Encoder, Decoder } from '../packer';
import { resolve } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import { session, type Bound, type Session } from '../predictor/session';
import { STRUCT, type AdaptiveOptions, type Ends, type Resolved } from '../predictor/types';
import { PNode, adapt } from './base';
import { atPath } from './path';
import type { Kind } from './guards';
import { IndexRange, checkUnset, lengthRange, type LengthBounds } from './lattice';
import { checkIndex, type Cdf } from './weights';
import type { LearningOptions } from './adaptive';
import {
  checkOrder,
  ordinal,
  ordinalDigits,
  readOrdinal,
  writeOrdinal,
  type Order,
} from './ordinal';
import { readRun, runOrder, writeRun } from './runs';
import { readMarker, writeMarker } from './markers';
import { learningOf, MethodNode, type MethodSet } from './methods';
import { PString } from './string';

/** A record key's text under `.adaptive()`: any length, ended by END. */
const KEY_TEXT: Ends = { min: 0, max: undefined, fixed: false };

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
  /** The structure symbols the collection starts and ends with under `.adaptive()`. */
  readonly start: number;
  readonly end: number;
  size(value: T): number;
  /** Each key with its value, in write order. A set's item is its own key and value. */
  entries(value: T): Iterable<readonly [unknown, unknown]>;
  /** The collection of `entries`, whose keys are distinct and never -0. */
  build(entries: Map<unknown, unknown>): T;
  /**
   * The node the keys go through under `.learn()`, for a layout whose keys
   * have no node of the caller's; the declared key otherwise. A layout with
   * one has string keys, which `.adaptive()` codes as key text.
   */
  learnedKey?(): PNode<any>;
}

export const MAP: Layout<Map<any, any>> = {
  who: 'p.map',
  name: 'Map',
  kind: 'map',
  start: STRUCT.MAP_START,
  end: STRUCT.MAP_END,
  size: (value) => value.size,
  entries: (value) => value.entries(),
  build: (entries) => entries,
};

export const SET: Layout<Set<any>> = {
  who: 'p.set',
  name: 'Set',
  kind: 'set',
  start: STRUCT.SET_START,
  end: STRUCT.SET_END,
  size: (value) => value.size,
  entries: (value) => value.entries(),
  build: (entries) => new Set(entries.keys()),
};

export const RECORD: Layout<Record<string, any>> = {
  who: 'p.record',
  name: 'Record',
  kind: 'object',
  start: STRUCT.OBJ_START,
  end: STRUCT.OBJ_END,
  size: (value) => Object.keys(value).length,
  entries: (value) => Object.entries(value),
  build: (entries) => {
    // fromEntries defines own properties, so a '__proto__' key lands as one
    // instead of replacing the prototype.
    return Object.fromEntries(entries);
  },
  learnedKey: () => new PString().adaptive(),
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
  /** How the node learns. */
  readonly _methods: MethodSet;
  readonly _adaptive?: AdaptiveOptions;
  /** Under `.adaptive()`: the options the collection's structure symbols code under. */
  private readonly _resolved?: Resolved;
  /** Whether the node or a node of its entries codes through the predictor. */
  private readonly _holds: boolean;

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
      learning === undefined || layout.learnedKey === undefined ? key : layout.learnedKey();
    this._value = value;
    this._bounds = bounds;
    this._count = lengthRange(bounds, layout.who, 'count', learning);
    this._kinds = [layout.kind];
    this._unordered = unordered;
    this._methods = methods;
    this._adaptive = methods.adaptive;
    if (this._adaptive !== undefined) {
      if (bounds.prior !== undefined) {
        throw new TypeError(
          `${layout.who} adaptive cannot weigh the count: an adaptive collection ends with a symbol`
        );
      }
      this._resolved = resolve(this._adaptive, loadedPriors.json, layout.who);
    }
    this._holds =
      this._adaptive !== undefined ||
      key._holdsAdaptive ||
      (value !== undefined && value._holdsAdaptive);
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
    checkUnset(this._bounds.prior, this._layout.who, 'prior');
    return this._with({ ...this._bounds, prior: fn });
  }

  /**
   * Declare how likely each count from min (or 0) to max is, lowest first.
   * Same prior as `.cdf()`, given as the histogram instead of its running
   * total.
   */
  weights(w: readonly number[]): PCollection<T> {
    checkUnset(this._bounds.prior, this._layout.who, 'prior');
    return this._with({ ...this._bounds, prior: w });
  }

  /**
   * Let the prior over the entry count learn from the message: the declared
   * weights, or even ones when none are, are the starting point, and each
   * entry count coded counts as one observation, so an entry count that keeps
   * recurring gets cheaper as the message goes on. From its second value on,
   * the node spends one bit to stay static, or a few to name the learning rate
   * that paid off. Without a max, the count learns on the magnitude scale from
   * the min instead: by its distance's bit-length class. `window` is how many
   * observations a table's counts hold before they halve, so the newest weigh
   * most (1024 when left out, and raised to the number of values counted when
   * smaller), and `separate` keeps its tables from starting where other nodes
   * of its kind and window got to. Takes weights, not a cdf; part of the wire
   * format, like the weights. A record's keys learn as under
   * `p.string().adaptive()`: keys that recur are recalled and new ones learn
   * their characters with the message's other strings. Not with
   * `.adaptive()`.
   */
  learn(options?: LearningOptions): PCollection<T> {
    return this._declare('learn', this._layout.who, options);
  }

  /**
   * Code the collection through the similarity predictor: its start, each
   * entry, and its end in place of a count, as symbols of the message's
   * structure, `.min()` and `.max()` bounding where the end may come. A map's
   * key and value and a set's item each follow the symbol they start with; a
   * record's key is a key symbol and the key's characters, then its value.
   * The nodes of the entries code as under their own `.adaptive(options)`
   * unless they have `.adaptive()` or `.learn()` already. Unordered entries go
   * ascending by key. Not with `.learn()`, `.weights()` or `.cdf()`. Set once.
   */
  adaptive(options?: AdaptiveOptions): PCollection<T> {
    return this._sugar(options, this._layout.who);
  }

  _adapted(options: AdaptiveOptions, memo: Map<PNode<any>, PNode<any>>): PCollection<T> {
    if (this._keeps()) {
      return this;
    }
    const { _layout, _key, _value } = this;
    // A record's keys are key text under `.adaptive()`, whatever their node.
    const key = _layout.learnedKey === undefined ? adapt(_key, options, memo) : _key;
    const value = _value === undefined ? undefined : adapt(_value, options, memo);
    return new PCollection<T>(_layout, key, value, this._bounds, this._unordered, {
      ...this._methods,
      adaptive: options,
    });
  }

  get _holdsAdaptive(): boolean {
    return this._holds;
  }

  _marker(): number {
    return this._layout.start;
  }

  _markers(): ReadonlySet<number> {
    return new Set([this._layout.start]);
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
    if (!this._holds) {
      this._spell(enc, value);
      return;
    }
    const s = session(enc);
    const o = this._resolved;
    if (o !== undefined && s.take(this) < 0) s.marker(this, o).write(enc, this._layout.start);
    this._enter(s);
    try {
      if (o === undefined) {
        this._spell(enc, value, s);
      } else {
        this._entries(enc, value, o, s);
      }
    } finally {
      this._leave(s);
    }
  }

  _read(dec: Decoder): T {
    if (!this._holds) {
      return this._unspell(dec);
    }
    const s = session(dec);
    const o = this._resolved;
    if (o !== undefined && s.take(this) < 0) s.marker(this, o).read(dec);
    this._enter(s);
    try {
      return o === undefined ? this._unspell(dec, s) : this._unentries(dec, o, s);
    } finally {
      this._leave(s);
    }
  }

  /** Opens the collection's list and marker scope. */
  private _enter(s: Session): void {
    const o = this._resolved;
    if (o === undefined) {
      s.enterPlain();
    } else {
      s.enterScope(this, o);
    }
    s.enterList();
  }

  private _leave(s: Session): void {
    s.leaveList();
    s.leaveScope();
  }

  /**
   * Writes the entries under `.adaptive()`, then the end unless the collection is at its max:
   * in insertion order, or ascending by key when unordered.
   */
  private _entries(enc: Encoder, value: T, o: Resolved, s: Session): void {
    const { name, end } = this._layout;
    const size = this._layout.size(value);
    const { lo, hi } = this._count;
    checkIndex(size, lo, hi, () => `${name} size ${size}`);
    const entries = [...this._layout.entries(value)];
    const keys = entries.map(([key]) => key);
    const segment = (j: number): string | number => this._segment(keys[j], j);
    let at: readonly number[] = keys.map((_, j) => j);
    if (this._unordered !== undefined) {
      at = ordinal(this._keys)
        ? ordinalDigits(this._keys, keys, UNORDERED, segment).at
        : runOrder(keys, UNORDERED, segment, true);
    }
    const min = lo as number;
    for (let k = 0; k < at.length; k++) {
      const j = at[k];
      const [key, item] = entries[j];
      s.nextItem();
      const bound = { end, allow: k >= min };
      try {
        this._writeKey(enc, key, o, bound);
      } catch (error) {
        throw atPath(this._value === undefined ? error : atPath(error, '<key>'), j);
      }
      const node = this._value;
      if (node !== undefined) {
        try {
          writeMarker(enc, this, o, node, node._marker(item));
          node._write(enc, item);
        } catch (error) {
          throw atPath(error, this._segment(key, j));
        }
      }
    }
    if (size !== hi) {
      s.marker(this, o).write(enc, end, undefined, { end, allow: true });
    }
  }

  /** Writes a key, a record's as key text, after its first structure symbol. */
  private _writeKey(enc: Encoder, key: unknown, o: Resolved, bound: Bound): void {
    if (this._layout.learnedKey === undefined) {
      const node = this._keys;
      writeMarker(enc, this, o, node, node._marker(key), bound);
      node._write(enc, key);
      return;
    }
    const s = session(enc);
    s.marker(this, o).write(enc, STRUCT.KEY, undefined, bound);
    // A record's entries come from `Object.entries`, whose keys are strings.
    const cps = Array.from(key as string, (ch) => ch.codePointAt(0) as number);
    s.text(this, o, 'text').write(enc, cps, cps.length, KEY_TEXT);
  }

  /** Reads the entries `_entries` wrote. */
  private _unentries(dec: Decoder, o: Resolved, s: Session): T {
    const { end } = this._layout;
    const { lo, hi } = this._count;
    const min = lo as number;
    const entries = new Map<unknown, unknown>();
    for (let i = 0; i !== hi; i++) {
      s.nextItem();
      const bound = { end, allow: i >= min };
      let key: unknown;
      try {
        if (this._layout.learnedKey === undefined) {
          const node = this._keys;
          if (readMarker(dec, this, o, node, bound) === end) break;
          key = node._read(dec);
        } else {
          if (s.marker(this, o).read(dec, undefined, bound) === end) break;
          let text = '';
          for (const cp of s.text(this, o, 'text').read(dec, KEY_TEXT)) {
            text += String.fromCodePoint(cp);
          }
          key = text;
        }
      } catch (error) {
        throw atPath(this._value === undefined ? error : atPath(error, '<key>'), i);
      }
      const node = this._value;
      try {
        if (node !== undefined) readMarker(dec, this, o, node);
        // A repeated key overwrites, as it does in an object literal.
        entries.set(key, node?._read(dec));
      } catch (error) {
        throw atPath(error, this._segment(key, i));
      }
    }
    return this._layout.build(entries);
  }

  /** Writes the collection in full. */
  private _spell(enc: Encoder, value: T, s?: Session): void {
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
        at = writeRun(enc, this._keys, keys, UNORDERED, segment, undefined, s);
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
      s?.nextItem();
      try {
        this._keys._write(enc, key);
      } catch (error) {
        throw atPath(this._value === undefined ? error : atPath(error, '<key>'), i);
      }
      try {
        this._value?._write(enc, item);
      } catch (error) {
        throw atPath(error, this._segment(key, i));
      }
      i++;
    }
  }

  /** Reads a collection `_spell` wrote. */
  private _unspell(dec: Decoder, s?: Session): T {
    const count = this._count.read(dec);
    this._count.learn(dec, count);
    dec.charge(count);
    const entries = new Map<unknown, unknown>();
    if (this._unordered !== undefined) {
      const keys = this._keys;
      if (!ordinal(keys)) {
        for (const key of readRun(dec, keys, count, UNORDERED, undefined, s)) {
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
      s?.nextItem();
      let key: unknown;
      try {
        key = this._keys._read(dec);
      } catch (error) {
        throw atPath(this._value === undefined ? error : atPath(error, '<key>'), i);
      }
      try {
        // A repeated key overwrites, as it does in an object literal.
        entries.set(key, this._value?._read(dec));
      } catch (error) {
        throw atPath(error, this._segment(key, i));
      }
    }
    return this._layout.build(entries);
  }
}
