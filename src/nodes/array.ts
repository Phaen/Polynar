import { Encoder, Decoder, CorruptInputError } from '../packer';
import { PNode } from './base';
import { atPath } from './path';
import type { Kind } from './guards';
import { IndexRange, checkUnset, lengthRange, type LengthBounds } from './lattice';
import type { Cdf } from './weights';
import type { AdaptiveOptions } from './adaptive';
import {
  checkOrdinal,
  ordinalDigits,
  readOrdinal,
  restricts,
  writeOrdinal,
  type Order,
} from './ordinal';
import { withMethod, type Spelling } from './methods';
import { Recall, copy, identity } from './recall';

const MAX_ARRAY_LENGTH = 2 ** 32 - 1;

/**
 * Array of one item type. The count travels through the shared integer
 * lattice with bounds `[min ?? 0, max]`: unbounded counts are term-prefixed,
 * bounded counts pack against their range, and a fixed `.length(n)` collapses
 * the range to one state — the count then costs zero bits on the wire.
 */
export class PArray<TItem> extends PNode<TItem[]> {
  readonly _kinds: readonly Kind[] = ['array'];

  private readonly _item: PNode<TItem>;
  private readonly _bounds: LengthBounds;
  private readonly _count: IndexRange;
  private readonly _order: Order;
  private readonly _spelling: Spelling;
  /** Set by `.recall()`: learned when the count is adaptive. */
  private readonly _recall?: Recall<TItem[]>;

  constructor(
    item: PNode<TItem>,
    bounds: LengthBounds = {},
    order: Order = {},
    spelling: Spelling = {}
  ) {
    super();
    this._item = item;
    this._bounds = bounds;
    this._count = lengthRange(bounds, 'p.array', 'count');
    if (order.sorted !== undefined && order.unordered !== undefined) {
      throw new TypeError('p.array takes sorted or unordered, not both');
    }
    this._order = order;
    this._spelling = spelling;
    if (spelling.recall !== undefined) {
      this._recall = new Recall(bounds.adaptive !== undefined, copy);
    }
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
    return this._with({ ...this._bounds, prior: fn });
  }

  /**
   * Declare how likely each count from min (or 0) to max is, lowest first.
   * Same prior as `.cdf()`, given as the histogram instead of its running
   * total.
   */
  weights(w: readonly number[]): PArray<TItem> {
    return this._with({ ...this._bounds, prior: w });
  }

  /**
   * Let the prior over the count learn from the message: the declared weights,
   * or even ones when none are, are the starting point, and each count coded
   * counts as one observation, so a count that keeps recurring gets cheaper as
   * the message goes on. `window` is how many observations the counts hold
   * before they halve, so the newest weigh most (1024 when left out, and raised
   * to the number of values it counts when smaller). From its second value on,
   * the node spends one bit to stay static, or a few to name the learning rate
   * that paid off. Without a max, the count learns on the magnitude scale
   * from the min instead: by its distance's bit-length class. Takes weights,
   * not a cdf; part of the wire format, like the weights.
   */
  adaptive(options?: AdaptiveOptions): PArray<TItem> {
    return this._with({ ...this._bounds, adaptive: options ?? {} });
  }

  /**
   * Require the items in ascending order, by the item's value order: numbers
   * and dates ascending, enum members in list order, true before false.
   * Repeats stay allowed unless `.unique()` forbids them. The order then
   * costs nothing: a sorted run of n items has n! fewer possible values.
   * Takes items of bounded p.int, p.date or p.decimal, or of p.enum or
   * p.bool, without weights or adaptive.
   */
  sorted(): PArray<TItem> {
    checkUnset(this._order.sorted, 'p.array', 'sorted');
    checkOrdinal(this._item, 'p.array', 'sorted', 'items');
    return this._with(this._bounds, { ...this._order, sorted: true });
  }

  /**
   * Forbid repeated items. Each item is then coded among the values not yet
   * used, so a shuffled deck costs log2 52! bits instead of 52 · log2 52.
   * Takes the same items as `.sorted()`.
   */
  unique(): PArray<TItem> {
    checkUnset(this._order.unique, 'p.array', 'unique');
    checkOrdinal(this._item, 'p.array', 'unique', 'items');
    return this._with(this._bounds, { ...this._order, unique: true });
  }

  /**
   * Let the order go: any order encodes and the items decode ascending, as
   * `.sorted()` orders them, which saves what the order would cost. Takes the
   * same items as `.sorted()`, and not together with it.
   */
  unordered(): PArray<TItem> {
    checkUnset(this._order.unordered, 'p.array', 'unordered');
    checkOrdinal(this._item, 'p.array', 'unordered', 'items');
    return this._with(this._bounds, { ...this._order, unordered: true });
  }

  /**
   * Spell an array this node already wrote in the message by its place
   * among the distinct arrays it wrote, and a new one as an escape and then
   * in full: with n arrays seen, a repeat costs log2(n + 1) bits, or under
   * `.adaptive()` less the more often it recurs. The message's first array
   * costs nothing extra. Arrays the schema writes the same way are the same
   * array, and a repeat decodes as a copy of the array first decoded.
   */
  recall(): PArray<TItem> {
    const spelling = withMethod(this._spelling, 'recall', 'p.array');
    return new PArray<TItem>(this._item, this._bounds, this._order, spelling);
  }

  private _with(bounds: LengthBounds, order: Order = this._order): PArray<TItem> {
    return new PArray<TItem>(this._item, bounds, order, this._spelling);
  }

  _write(enc: Encoder, value: TItem[]): void {
    const recall = this._recall;
    if (recall === undefined) {
      this._spell(enc, value);
    } else {
      const key = identity((alone) => this._spell(alone, value));
      recall.write(enc, key, () => this._spell(enc, value));
    }
  }

  _read(dec: Decoder): TItem[] {
    const recall = this._recall;
    return recall === undefined ? this._unspell(dec) : recall.read(dec, () => this._unspell(dec));
  }

  /** Writes the array in full. */
  private _spell(enc: Encoder, value: TItem[]): void {
    const count = value.length;

    this._count.write(enc, count, () => `Array length ${count}`);

    if (restricts(this._order)) {
      // checkOrdinal accepted the item when the order was set.
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
        this._item._write(enc, value[i]);
      }
    } catch (error) {
      throw atPath(error, i);
    }
  }

  /** Reads an array `_spell` wrote. */
  private _unspell(dec: Decoder): TItem[] {
    const count = this._count.read(dec);
    // No array is longer than 2^32 - 1, so a larger count was never written.
    // Items that take no bits never run out of input to say so themselves.
    if (count > MAX_ARRAY_LENGTH) {
      throw new CorruptInputError(`Array length ${count} is above the largest possible array`);
    }
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
    for (let i = 0; i < count; i++) {
      value.push(item._read(dec));
    }
    return value;
  }
}
