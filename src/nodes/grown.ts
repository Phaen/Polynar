/**
 * A learned alphabet that grows through the message: an item spelled once
 * as its symbol and a tail joins the alphabet as a symbol of its own, which
 * the contexts then learn like any other, and later occurrences carry no
 * tail. Both sides admit items in the order they meet them, so they number
 * them alike. Where the contexts escape, an admitted item is the prior's
 * one symbol for "an item seen before", then the item among those admitted,
 * by how often each occurred.
 *
 * The tail of an item new to the message is its offset among the items its
 * symbol spells, the admitted ones left out: they cannot be new. The offset
 * follows the halvings of that range, each half weighed by how many admitted
 * items it holds against how many items it leaves, so the stretches a
 * message's new items have come from, a script's block, its letters, grow
 * likelier. Below a half holding no admitted item the offset is uniform.
 */
import {
  CorruptInputError,
  Encoder,
  SlotCache,
  costUnits,
  type Decoder,
  type Journal,
} from '../packer';
import type { AdaptivePrior } from './adaptive';
import type { SymbolPrior } from './contexts';
import { Exclusion } from './excluded';
import { Fenwick } from './fenwick';
import { KeyMap } from './keymap';

/** The most items a message admits; later new items keep their symbol and tail. */
export const MAX_ADMITTED = 1 << 14;

/** The count an item takes when admitted, and what each recurrence adds. */
const ADMIT_COUNT = 2;
const RECUR_COUNT = 1;

/**
 * The weight, in admitted items, of the split by size of a halving of
 * `width` items: the narrower, the heavier, as a message keeps to few
 * blocks while their letters spread through them.
 */
const evenness = (width: number): number => (width <= 128 ? 4 : width <= 256 ? 2 : 1);

/** The first index in `[from, to)` of `sorted`, ascending, whose value is at least `value`. */
function lowerBound(sorted: readonly number[], value: number, from: number, to: number): number {
  while (from < to) {
    const mid = (from + to) >>> 1;
    if (sorted[mid] < value) {
      from = mid + 1;
    } else {
      to = mid;
    }
  }
  return from;
}

/**
 * Codes `offset` in `[0, size)`, not in `admitted`, ascending, on `side`,
 * down the halvings of the smallest power of two over `size`; returns it,
 * read on a decoder, where `offset` is ignored. A half of `n` admitted
 * items and `f` left, beside one of `n'` and `f'`, weighs
 * `n·(f + f') + b·f` against `n'·(f + f') + b·f'`, `b` its `evenness`.
 */
function codeOffset(
  side: Encoder | Decoder,
  admitted: readonly number[],
  size: number,
  offset: number
): number {
  const enc = side instanceof Encoder ? side : undefined;
  let lo = 0;
  let width = 2 ** Math.ceil(Math.log2(size));
  // The admitted offsets in [lo, lo + width).
  let from = 0;
  let to = admitted.length;
  while (from < to) {
    const half = width / 2;
    const mid = lo + half;
    width = half;
    if (mid >= size) {
      continue;
    }
    const end = Math.min(mid + half, size);
    const at = lowerBound(admitted, mid, from, to);
    const left = half - (at - from);
    const right = end - mid - (to - at);
    // A range holding an offset not admitted keeps a half that holds one.
    let upper = left === 0;
    if (left > 0 && right > 0) {
      const all = left + right;
      const even = evenness(2 * half);
      const low = (at - from) * all + even * left;
      const total = (to - from + even) * all;
      if (enc !== undefined) {
        upper = offset >= mid;
        enc.composeWeighted(upper ? low : 0, upper ? total - low : low, total);
      } else {
        upper = (side as Decoder).parseSplit(low, total);
      }
    }
    if (upper) {
      lo = mid;
      from = at;
    } else {
      to = at;
    }
  }
  const end = Math.min(lo + width, size);
  if (enc !== undefined) {
    enc.compose(offset - lo, end - lo);
    return offset;
  }
  return lo + (side as Decoder).parse(end - lo);
}

/** One message's admitted items on a side. */
interface Admitted {
  /** The symbol of each admitted item. */
  readonly symbols: KeyMap<number>;
  /** The admitted items, in the order they were admitted. */
  readonly items: number[];
  /** How often each admitted item occurred. */
  readonly counts: Fenwick;
  /** The offsets of the admitted items in the range of each symbol, by symbol, ascending. */
  readonly offsets: number[][];
  readonly journal?: Journal;
}

/** The items a symbol spells with a tail, first and last; undefined where it has none. */
export type Range = (symbol: number) => readonly [number, number] | undefined;

/**
 * The items a message admits to an alphabet of `base` symbols. The prior's
 * symbol for an admitted item is `base`, which no context ever codes, so a
 * history may also use it for "before the value began"; the `i`-th admitted
 * item is `base + 1 + i`, up to `size`. The counts of the admitted items
 * halve, rounding up, once they pass `window`, or twice the items admitted
 * when more.
 */
export class GrownAlphabet {
  /** The symbols: the alphabet's, the prior's for an admitted item, and room for every admitted one. */
  readonly size: number;
  /** Each message's admitted items. */
  private readonly messages = new SlotCache<Admitted, Encoder | Decoder>(this, (side) => ({
    symbols: new KeyMap(),
    items: [],
    counts: new Fenwick([], side.journal),
    offsets: [],
    journal: side.journal,
  }));

  constructor(
    readonly base: number,
    private readonly window: number,
    private readonly range: Range
  ) {
    this.size = base + 1 + MAX_ADMITTED;
  }

  /** This message's admitted items on `side`. */
  message(side: Encoder | Decoder): Admitted {
    return this.messages.get(side);
  }

  /** The symbol of `item` on `side`, -1 when it is not admitted. */
  symbol(side: Encoder | Decoder, item: number): number {
    const { symbols } = this.message(side);
    return symbols.size === 0 ? -1 : (symbols.get(item) ?? -1);
  }

  /** How many items `side` admitted. */
  admitted(side: Encoder | Decoder): number {
    return this.message(side).items.length;
  }

  /** The item of `sym`, an admitted item's symbol on `side`. */
  item(side: Encoder | Decoder, sym: number): number {
    return this.message(side).items[sym - this.base - 1];
  }

  /**
   * Admits `item`, which is not admitted yet and which the alphabet's
   * `symbol` spells with a tail, while there is room.
   */
  admit(side: Encoder | Decoder, item: number, symbol: number): void {
    const { symbols, items, counts, offsets, journal } = this.message(side);
    if (items.length === MAX_ADMITTED) {
      return;
    }
    const sorted = (offsets[symbol] ??= []);
    const offset = item - (this.range(symbol) as readonly [number, number])[0];
    const at = lowerBound(sorted, offset, 0, sorted.length);
    symbols.set(item, this.base + 1 + items.length);
    if (journal?.active === true) {
      journal.drop(symbols, item);
      journal.truncate(items, items.length);
      journal.call(() => sorted.splice(at, 1));
    }
    items.push(item);
    counts.push(ADMIT_COUNT);
    sorted.splice(at, 0, offset);
  }

  /**
   * Writes the tail of `item`, new to the message, spelled as the
   * alphabet's `symbol`, and admits it; false, writing nothing, where
   * `symbol` has no tail.
   */
  tail(enc: Encoder, item: number, symbol: number): boolean {
    const range = this.range(symbol);
    if (range === undefined) {
      return false;
    }
    const sorted = this.message(enc).offsets[symbol] ?? [];
    codeOffset(enc, sorted, range[1] - range[0] + 1, item - range[0]);
    this.admit(enc, item, symbol);
    return true;
  }

  /**
   * The item `tail` wrote after the alphabet's `symbol`, admitted;
   * undefined, reading nothing, where `symbol` has no tail.
   */
  untail(dec: Decoder, symbol: number): number | undefined {
    const range = this.range(symbol);
    if (range === undefined) {
      return undefined;
    }
    const sorted = this.message(dec).offsets[symbol] ?? [];
    const size = range[1] - range[0] + 1;
    if (sorted.length === size) {
      throw new CorruptInputError(
        `A new item where every one of ${size} its symbol spells is admitted`
      );
    }
    const item = range[0] + codeOffset(dec, sorted, size, 0);
    this.admit(dec, item, symbol);
    return item;
  }

  /** Counts one more occurrence of `sym`, an admitted item's symbol. */
  learn(side: Encoder | Decoder, sym: number): void {
    const { counts, items } = this.message(side);
    counts.add(sym - this.base - 1, RECUR_COUNT);
    if (counts.total > Math.max(this.window, 2 * items.length)) {
      counts.halve(true);
    }
  }
}

/**
 * An adaptive prior over a grown alphabet: `inner` codes the alphabet's
 * symbols and, at `base`, an admitted item, which then follows among the
 * admitted items, those the contexts ruled out left out, by their counts.
 * The prior's symbol for an admitted item is ruled out where no admitted
 * item is left.
 */
export class GrownPrior implements SymbolPrior {
  readonly members: number;
  readonly bases: readonly unknown[];
  /** The exclusion `inner` codes under: the alphabet's members of the contexts'. */
  private readonly split: Exclusion;
  /** The admitted items the contexts ruled out, by index, as `part` found them. */
  private readonly out: number[] = [];

  constructor(
    private readonly inner: AdaptivePrior,
    private readonly alphabet: GrownAlphabet
  ) {
    this.members = alphabet.size;
    this.bases = inner.bases;
    this.split = new Exclusion(alphabet.base + 1);
  }

  /**
   * Splits `excluded`: its members of the alphabet into `split`, with the
   * prior's symbol for an admitted item when `excluded` leaves none of
   * `counts`' items, `extra` more counted; its admitted items into `out`.
   * The counts of the admitted items left, `extra` included.
   */
  private part(counts: Fenwick, excluded: Exclusion, extra = 0): number {
    const { split, out } = this;
    const first = this.alphabet.base + 1;
    split.clear();
    out.length = 0;
    let left = counts.total + extra;
    for (let i = 0; i < excluded.count; i++) {
      const member = excluded.member(i);
      if (member < first) {
        split.add(member);
      } else {
        out.push(member - first);
        left -= counts.count(member - first);
      }
    }
    if (left === 0) {
      split.add(first - 1);
    }
    return left;
  }

  /** The counts of the admitted items in `out` below `index`. */
  private below(counts: Fenwick, index: number): number {
    let sum = 0;
    for (const at of this.out) {
      if (at < index) {
        sum += counts.count(at);
      }
    }
    return sum;
  }

  write(enc: Encoder, pos: number, row: number, excluded: Exclusion): void {
    const { alphabet, split } = this;
    const { base } = alphabet;
    const { counts } = alphabet.message(enc);
    const left = this.part(counts, excluded);
    if (pos < base) {
      this.inner.write(enc, pos, row, split);
      return;
    }
    this.inner.write(enc, base, row, split);
    const index = pos - base - 1;
    enc.composeWeighted(
      counts.prefix(index) - this.below(counts, index),
      counts.count(index),
      left
    );
    alphabet.learn(enc, pos);
  }

  read(dec: Decoder, row: number, excluded: Exclusion): number {
    const { alphabet, out } = this;
    const { base } = alphabet;
    const { counts } = alphabet.message(dec);
    const left = this.part(counts, excluded);
    const sym = this.inner.read(dec, row, this.split);
    if (sym < base) {
      return sym;
    }
    out.sort((a, b) => a - b);
    // A residual among the items left lies past every ruled-out item that
    // starts at or below it, each moving it on by its count.
    const index = dec.parseWeighted(left, (residual) => {
      let full = residual;
      for (const at of out) {
        if (counts.prefix(at) > full) {
          break;
        }
        full += counts.count(at);
      }
      const at = counts.locate(full);
      return [at, counts.prefix(at) - (full - residual), counts.count(at)];
    });
    const pos = base + 1 + index;
    alphabet.learn(dec, pos);
    return pos;
  }

  learn(side: Encoder | Decoder, pos: number, row: number): void {
    const { base } = this.alphabet;
    if (pos < base) {
      this.inner.learn(side, pos, row);
      return;
    }
    this.inner.learn(side, base, row);
    this.alphabet.learn(side, pos);
  }

  /**
   * The cost `write` would charge: an item the encoder numbered ahead of
   * admitting it, past the admitted ones, is priced as if just admitted.
   */
  cost(enc: Encoder, pos: number, row: number, excluded: Exclusion): number {
    const { base } = this.alphabet;
    const { counts } = this.alphabet.message(enc);
    const { split } = this;
    if (pos < base) {
      this.part(counts, excluded);
      return this.inner.cost(enc, pos, row, split);
    }
    const index = pos - base - 1;
    const ahead = index >= counts.size;
    const left = this.part(counts, excluded, ahead ? ADMIT_COUNT : 0);
    const freq = ahead ? ADMIT_COUNT : counts.count(index);
    return this.inner.cost(enc, base, row, split) + costUnits(freq, left);
  }
}
