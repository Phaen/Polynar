import { Encoder, Decoder, CorruptInputError } from '../packer';
import { resolve } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import { session, type Session } from '../predictor/session';
import { STRUCT, type CompressOptions, type Resolved } from '../predictor/types';
import { PNode, adapt } from './base';
import { atPath } from './path';
import type { Kind } from './guards';
import { IndexRange, checkUnset, lengthRange, type LengthBounds } from './lattice';
import { checkIndex, type Cdf } from './weights';
import type { AdaptOptions } from './adaptive';
import {
  checkOrder,
  ordinal,
  ordinalDigits,
  readOrdinal,
  restricts,
  writeOrdinal,
  type Order,
} from './ordinal';
import { readRun, runOrder, writeRun } from './runs';
import { members, type Members } from './members';
import { readMarker, writeMarker } from './markers';
import { learningOf, MethodNode, type MethodSet } from './methods';

const ARRAY_MARKERS: ReadonlySet<number> = new Set([STRUCT.ARR_START]);

const MAX_ARRAY_LENGTH = 2 ** 32 - 1;

/**
 * Array of one item type. The count travels through the shared integer
 * lattice with bounds `[min ?? 0, max]`: unbounded counts are term-prefixed,
 * bounded counts pack against their range, and a fixed `.length(n)` collapses
 * the range to one state — the count then costs zero bits on the wire.
 */
export class PArray<TItem> extends MethodNode<TItem[]> {
  readonly _kinds: readonly Kind[] = ['array'];

  private readonly _item: PNode<TItem>;
  private readonly _bounds: LengthBounds;
  private readonly _count: IndexRange;
  private readonly _order: Order;
  /** How the node learns. */
  readonly _methods: MethodSet;
  readonly _compress?: CompressOptions;
  /** Under `.compress()`: the options the array's structure symbols code under. */
  private readonly _resolved?: Resolved;
  /** Whether the node or its item codes through the predictor. */
  private readonly _holds: boolean;
  /**
   * How distinct strings in their own order are spelled, see `./runs`:
   * learned when the count is compressed.
   */
  private readonly _choice: Members;

  constructor(
    item: PNode<TItem>,
    bounds: LengthBounds = {},
    order: Order = {},
    methods: MethodSet = {}
  ) {
    super();
    this._item = item;
    this._bounds = bounds;
    const learning = learningOf(methods);
    this._count = lengthRange(bounds, 'p.array', 'count', learning);
    if (order.sorted !== undefined && order.unordered !== undefined) {
      throw new TypeError('p.array takes sorted or unordered, not both');
    }
    this._order = order;
    this._methods = methods;
    this._compress = methods.compress;
    if (this._compress !== undefined) {
      if (bounds.prior !== undefined) {
        throw new TypeError(
          'p.array compress cannot weigh the count: a compressed array ends with a symbol'
        );
      }
      this._resolved = resolve(this._compress, loadedPriors.json, 'p.array');
    }
    this._holds = this._compress !== undefined || item._holdsCompress;
    this._choice = members(2, learning === undefined ? undefined : { adapt: learning }, 'p.array');
  }

  /** Require at least `n` items. A raised floor packs the count denser. */
  min(n: number): PArray<TItem> {
    checkUnset(this._bounds.min, 'p.array', 'min');
    return this._with({ ...this._bounds, min: n });
  }

  /** Cap the item count. A capped count packs denser than the uncapped prefix. */
  max(n: number): PArray<TItem> {
    checkUnset(this._bounds.max, 'p.array', 'max');
    return this._with({ ...this._bounds, max: n });
  }

  /**
   * Fix the exact item count, the same as `.min(n).max(n)`. The count then
   * costs zero bits on the wire.
   */
  length(n: number): PArray<TItem> {
    checkUnset(this._bounds.min, 'p.array', 'min');
    checkUnset(this._bounds.max, 'p.array', 'max');
    return this._with({ ...this._bounds, min: n, max: n });
  }

  /**
   * Declare a prior over the item COUNT as an integer CDF: `fn(n)` is the
   * cumulative weight of counts below `n`. Requires a max; a zero-weight
   * count cannot encode.
   */
  cdf(fn: Cdf): PArray<TItem> {
    checkUnset(this._bounds.prior, 'p.array', 'prior');
    return this._with({ ...this._bounds, prior: fn });
  }

  /**
   * Declare how likely each count from min (or 0) to max is, lowest first.
   * Same prior as `.cdf()`, given as the histogram instead of its running
   * total.
   */
  weights(w: readonly number[]): PArray<TItem> {
    checkUnset(this._bounds.prior, 'p.array', 'prior');
    return this._with({ ...this._bounds, prior: w });
  }

  /**
   * Let the prior over the count learn from the message: the declared weights,
   * or even ones when none are, are the starting point, and each count coded
   * counts as one observation, so a count that keeps recurring gets cheaper as
   * the message goes on. From its second value on, the node spends one bit to
   * stay static, or a few to name the learning rate that paid off. Without a
   * max, the count learns on the magnitude scale from the min instead: by its
   * distance's bit-length class. `window` is how many observations a table's
   * counts hold before they halve, so the newest weigh most (1024 when left
   * out, and raised to the number of values counted when smaller), and
   * `separate` keeps its tables from starting where other nodes of its kind and
   * window got to. Takes weights, not a cdf; part of the wire format, like the
   * weights. Not with `.compress()`.
   */
  adapt(options?: AdaptOptions): PArray<TItem> {
    return this._declare('adapt', 'p.array', options);
  }

  /**
   * Code the array through the similarity predictor: its start, each item
   * after the symbol it starts with, and its end in place of a count, as
   * symbols of the message's structure, `.min()` and `.max()` bounding where
   * the end may come; and the item as under its own `.compress(options)`
   * unless it has `.compress()` or `.adapt()` already. A restricted order
   * still holds: the items go one by one, ascending unless they keep their
   * own order. Not with `.adapt()`, `.weights()` or `.cdf()`. Set once.
   */
  compress(options?: CompressOptions): PArray<TItem> {
    return this._sugar(options, 'p.array');
  }

  _adapted(options: CompressOptions, memo: Map<PNode<any>, PNode<any>>): PArray<TItem> {
    if (this._keeps()) {
      return this;
    }
    const item = adapt(this._item, options, memo);
    return new PArray<TItem>(item, this._bounds, this._order, {
      ...this._methods,
      compress: options,
    });
  }

  get _holdsCompress(): boolean {
    return this._holds;
  }

  _marker(): number {
    return STRUCT.ARR_START;
  }

  _markers(): ReadonlySet<number> {
    return ARRAY_MARKERS;
  }

  /**
   * Require the items in ascending order, by the item's value order: numbers
   * and dates ascending, enum members in list order, true before false,
   * strings by UTF-16 code units. Repeats stay allowed unless `.unique()`
   * forbids them. The order then costs nothing: a sorted run of n items has
   * n! fewer possible values, and each string is written after the start it
   * shares with the one before. Takes items of p.string, or of bounded
   * p.int, p.date or p.decimal, p.enum or p.bool without weights or
   * compress.
   */
  sorted(): PArray<TItem> {
    checkUnset(this._order.sorted, 'p.array', 'sorted');
    checkOrder(this._item, 'p.array', 'sorted', 'items');
    return this._with(this._bounds, { ...this._order, sorted: true });
  }

  /**
   * Forbid repeated items. Each item is then coded among the values not yet
   * used, so a shuffled deck costs log2 52! bits instead of 52 · log2 52;
   * strings are written as they stand or ascending, as `.sorted()` writes
   * them, and then their order, whichever is shorter, after a choice that
   * learns when the count is compressed. Takes the same items as `.sorted()`.
   */
  unique(): PArray<TItem> {
    checkUnset(this._order.unique, 'p.array', 'unique');
    checkOrder(this._item, 'p.array', 'unique', 'items');
    return this._with(this._bounds, { ...this._order, unique: true });
  }

  /**
   * Let the order go: any order encodes and the items decode ascending, as
   * `.sorted()` orders them, which saves what the order would cost. Takes the
   * same items as `.sorted()`, and not together with it.
   */
  unordered(): PArray<TItem> {
    checkUnset(this._order.unordered, 'p.array', 'unordered');
    checkOrder(this._item, 'p.array', 'unordered', 'items');
    return this._with(this._bounds, { ...this._order, unordered: true });
  }

  /** This node with `methods` in place of its own. */
  _withMethods(methods: MethodSet): PArray<TItem> {
    return new PArray<TItem>(this._item, this._bounds, this._order, methods);
  }

  private _with(bounds: LengthBounds, order: Order = this._order): PArray<TItem> {
    return new PArray<TItem>(this._item, bounds, order, this._methods);
  }

  _write(enc: Encoder, value: TItem[]): void {
    if (!this._holds) {
      this._spell(enc, value);
      return;
    }
    const s = session(enc);
    const o = this._resolved;
    if (o !== undefined && s.take(this) < 0) s.marker(this, o).imply(STRUCT.ARR_START);
    this._enter(s);
    try {
      if (o === undefined) {
        this._spell(enc, value, s);
      } else {
        this._items(enc, value, o, s);
      }
    } finally {
      this._leave(s);
    }
  }

  _read(dec: Decoder): TItem[] {
    if (!this._holds) {
      return this._unspell(dec);
    }
    const s = session(dec);
    const o = this._resolved;
    if (o !== undefined && s.take(this) < 0) s.marker(this, o).imply(STRUCT.ARR_START);
    this._enter(s);
    try {
      return o === undefined ? this._unspell(dec, s) : this._unitems(dec, o, s);
    } finally {
      this._leave(s);
    }
  }

  /** Opens the array's list and marker scope. */
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
   * Writes the items under `.compress()`, each after its first structure symbol, then the end
   * unless the array is at its max: in order, or ascending where the order is let go.
   */
  private _items(enc: Encoder, value: TItem[], o: Resolved, s: Session): void {
    const count = value.length;
    const { lo, hi } = this._count;
    checkIndex(count, lo, hi, () => `Array length ${count}`);
    const item = this._item;
    const min = lo as number;
    let at: readonly number[] = value.map((_, i) => i);
    if (restricts(this._order)) {
      at = ordinal(item)
        ? ordinalDigits(item, value, this._order, (i) => i).at
        : runOrder(value, this._order, (i) => i, true);
    }
    for (let k = 0; k < count; k++) {
      const i = at[k];
      s.nextItem();
      try {
        const bound = { end: STRUCT.ARR_END, allow: k >= min };
        writeMarker(enc, this, o, item, item._marker(value[i]), bound);
        item._write(enc, value[i]);
      } catch (error) {
        throw atPath(error, i);
      }
    }
    if (count !== hi) {
      // The reader loads the item's declared weights before every symbol, the end included.
      s.marker(this, o).write(
        enc,
        STRUCT.ARR_END,
        undefined,
        { end: STRUCT.ARR_END, allow: true },
        item._markerPrior()
      );
    }
  }

  /** Reads the items `_items` wrote. */
  private _unitems(dec: Decoder, o: Resolved, s: Session): TItem[] {
    const { lo, hi } = this._count;
    const min = lo as number;
    const item = this._item;
    const value: TItem[] = [];
    while (value.length !== hi) {
      s.nextItem();
      const bound = { end: STRUCT.ARR_END, allow: value.length >= min };
      if (readMarker(dec, this, o, item, bound) === STRUCT.ARR_END) {
        break;
      }
      try {
        value.push(item._read(dec));
      } catch (error) {
        throw atPath(error, value.length);
      }
    }
    return value;
  }

  /** Writes the array in full. */
  private _spell(enc: Encoder, value: TItem[], s?: Session): void {
    const count = value.length;

    this._count.write(enc, count, () => `Array length ${count}`);
    this._count.learn(enc, count);

    if (restricts(this._order)) {
      // checkOrder accepted the item when the order was set.
      if (!ordinal(this._item)) {
        writeRun(enc, this._item, value, this._order, (i) => i, this._choice, s);
        return;
      }
      const { digits } = ordinalDigits(this._item, value, this._order, (i) => i);
      writeOrdinal(enc, digits, this._item._radix as number, this._order);
      return;
    }

    // Indexed iteration, not for-of over holes: a sparse array's holes read as
    // undefined and must fail the item's own validation rather than be skipped,
    // or the element count would desync from the length prefix.
    let i = 0;
    try {
      for (; i < count; i++) {
        s?.nextItem();
        this._item._write(enc, value[i]);
      }
    } catch (error) {
      throw atPath(error, i);
    }
  }

  /** Reads an array `_spell` wrote. */
  private _unspell(dec: Decoder, s?: Session): TItem[] {
    const count = this._count.read(dec);
    // No array is longer than 2^32 - 1, so a larger count was never written.
    // Items that take no bits never run out of input to say so themselves.
    if (count > MAX_ARRAY_LENGTH) {
      throw new CorruptInputError(`Array length ${count} is above the largest possible array`);
    }
    this._count.learn(dec, count);
    dec.charge(count);
    const item = this._item;
    const value: TItem[] = [];
    if (item._radix !== undefined && item._fromDigit !== undefined) {
      const digits = restricts(this._order)
        ? readOrdinal(dec, item._radix, count, this._order)
        : dec.parseMany(item._radix, count);
      for (const digit of digits) {
        value.push(item._fromDigit(digit));
      }
      return value;
    }
    if (restricts(this._order)) {
      return readRun(dec, item, count, this._order, this._choice, s) as TItem[];
    }
    let i = 0;
    try {
      for (; i < count; i++) {
        s?.nextItem();
        value.push(item._read(dec));
      }
    } catch (error) {
      throw atPath(error, i);
    }
    return value;
  }
}
