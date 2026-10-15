/**
 * Two spellings of text a sequence can take beyond the plain one and the
 * delta: digit fields (`.digits()`), where each maximal run of digits is one
 * integer of its exact width and the text around the runs is a frame of its
 * own, and positions (`.positional()`), where each place of a string whose
 * length the node already met keeps the items seen there. Both read what
 * the sequence knows of a value before its items: its span and the node's
 * previous value.
 */

import { Encoder, Decoder, CorruptInputError } from '../packer';
import { writeLive, readLive } from './adaptive';
import { Fenwick } from './fenwick';
import { MAX_CLASS, STATIC_MAGNITUDE, classOf, type Magnitude } from './magnitude';
import type { Method } from './methods';
import type { Symbols } from './sequence';

/** What a field spelling reads of the sequence it spells for. */
export interface FieldHost {
  readonly symbols: Symbols<unknown>;
  /** The span of the value being coded on `side`, its length prefix already coded. */
  span(side: Encoder | Decoder): number;
  /** The items of the node's previous value on `side`, none before its first. */
  prev(side: Encoder | Decoder): readonly number[] | undefined;
  /** Writes `items` of `span` units in the node's plain spelling, with no length of their own. */
  writeBody(enc: Encoder, items: readonly number[], span: number): void;
  /** Reads items `writeBody` wrote. */
  readBody(dec: Decoder, span: number): number[];
}

/**
 * Past this total the counts of a learned flag halve, so the flag follows
 * how its field behaves lately rather than over the whole message.
 */
const FLAG_WINDOW = 64;

/** A learned flag: two members starting at 1, gaining 2 per value. */
const flag = (side: Encoder | Decoder): Fenwick => new Fenwick([1, 1], side.journal);

/** Counts one more `bit` in a learned flag. */
function learnFlag(table: Fenwick, bit: number): void {
  table.add(bit, 2);
  if (table.total > FLAG_WINDOW) {
    table.halve(true);
  }
}

/** The most digits one field holds: its value stays a safe integer. A longer run splits into fields of this width from its start. */
export const FIELD_DIGITS = 15;

/** How many fields keep a learned scale of their own; later ones share the last. */
const FIELD_SCALES = 16;

/** A value split into digit fields: the frame's gaps around them, and each field's width and value. */
interface Fields {
  /** The items between fields, one more than there are fields; each empty only between fields of a split run. */
  readonly gaps: readonly (readonly number[])[];
  readonly widths: readonly number[];
  readonly values: readonly number[];
  /** The units of every gap together. */
  readonly frame: number;
}

/** What one side reads or writes a field spelling's numbers through. */
interface Io {
  /** A flag, learned when `table` is given, else at even odds. */
  bit(table: Fenwick | undefined, bit: number): number;
  /** An integer in `[lo, hi]` on `scale` around `origin`. */
  scaled(scale: Magnitude, value: number, origin: number, lo: number, hi: number): number;
  /** An integer below `radix`, every one alike. */
  uniform(value: number, radix: number): number;
}

/** Writes each number as it goes. */
const writer = (enc: Encoder): Io => ({
  bit(table, bit) {
    if (table === undefined) {
      enc.compose(bit, 2);
    } else {
      writeLive(enc, table, bit);
      learnFlag(table, bit);
    }
    return bit;
  },
  scaled(scale, value, origin, lo, hi) {
    scale.write(enc, value, origin, lo, hi);
    return value;
  },
  uniform(value, radix) {
    enc.compose(value, radix);
    return value;
  },
});

/** Reads each number back. */
const reader = (dec: Decoder): Io => ({
  bit(table) {
    if (table === undefined) {
      return dec.parse(2);
    }
    const bit = readLive(dec, table);
    learnFlag(table, bit);
    return bit;
  },
  scaled(scale, _value, origin, lo, hi) {
    return scale.read(dec, origin, lo, hi);
  },
  uniform(_value, radix) {
    return dec.parse(radix);
  },
});

/** Learns each number as though it were written. */
const learner = (side: Encoder | Decoder): Io => ({
  bit(table, bit) {
    if (table !== undefined) {
      learnFlag(table, bit);
    }
    return bit;
  },
  scaled(scale, value, origin, lo, hi) {
    scale.learn(side, value, origin, lo, hi);
    return value;
  },
  uniform(value) {
    return value;
  },
});

/** The members of a field scale: the origin, then each class above it, then each below. */
const SCALE_MEMBERS = 1 + 2 * MAX_CLASS;

/** What a field scale starts each member at: the origin and small classes likelier. */
const SCALE_START: readonly number[] = Array.from({ length: SCALE_MEMBERS }, (_, member) => {
  const cls = member === 0 ? 0 : member <= MAX_CLASS ? member : member - MAX_CLASS;
  return Math.max(1, 16 >> cls);
});

/** What a field scale adds to a member per value, and the total past which it halves. */
const SCALE_GAIN = 16;
const SCALE_WINDOW = 1024;

/**
 * A learned magnitude scale with no static start to choose: the side and
 * bit-length class of the distance from the origin as one member of
 * learned counts, the classes the interval does not reach owning no
 * states, then the distance within its class, every one alike.
 */
class FieldScale implements Magnitude {
  private table(side: Encoder | Decoder): Fenwick {
    return side.state(this, () => new Fenwick(SCALE_START, side.journal));
  }

  /** The states the reached members own: the origin and the classes above it, and those below it. */
  private static reach(table: Fenwick, origin: number, lo: number, hi: number): [number, number] {
    const ups = table.prefix(classOf(hi - origin) + 1);
    const downs = table.prefix(MAX_CLASS + 1 + classOf(origin - lo)) - table.prefix(MAX_CLASS + 1);
    return [ups, downs];
  }

  write(enc: Encoder, value: number, origin: number, lo: number, hi: number): void {
    const table = this.table(enc);
    const up = value >= origin;
    const distance = up ? value - origin : origin - value;
    const cls = classOf(distance);
    const member = cls === 0 ? 0 : up ? cls : MAX_CLASS + cls;
    const [ups, downs] = FieldScale.reach(table, origin, lo, hi);
    const cum = up ? table.cum(member) : ups + table.cum(member) - table.prefix(MAX_CLASS + 1);
    enc.composeWeighted(cum, table.freq(member), ups + downs);
    if (cls > 0) {
      const start = 2 ** (cls - 1);
      const end = Math.min(2 * start - 1, up ? hi - origin : origin - lo);
      enc.compose(distance - start, end - start + 1);
    }
    FieldScale.learnMember(table, member);
  }

  read(dec: Decoder, origin: number, lo: number, hi: number): number {
    const table = this.table(dec);
    const [ups, downs] = FieldScale.reach(table, origin, lo, hi);
    const below = table.prefix(MAX_CLASS + 1);
    const member = dec.parseWeighted(ups + downs, (residual) => {
      const at = table.locate(residual < ups ? residual : residual - ups + below);
      const cum = residual < ups ? table.cum(at) : ups + table.cum(at) - below;
      return [at, cum, table.freq(at)] as const;
    });
    FieldScale.learnMember(table, member);
    if (member === 0) {
      return origin;
    }
    const up = member <= MAX_CLASS;
    const cls = up ? member : member - MAX_CLASS;
    const start = 2 ** (cls - 1);
    const end = Math.min(2 * start - 1, up ? hi - origin : origin - lo);
    const distance = start + dec.parse(end - start + 1);
    return up ? origin + distance : origin - distance;
  }

  learn(side: Encoder | Decoder, value: number, origin: number): void {
    const up = value >= origin;
    const cls = classOf(up ? value - origin : origin - value);
    FieldScale.learnMember(this.table(side), cls === 0 ? 0 : up ? cls : MAX_CLASS + cls);
  }

  private static learnMember(table: Fenwick, member: number): void {
    table.add(member, SCALE_GAIN);
    if (table.total > SCALE_WINDOW) {
      table.halve(true);
    }
  }
}

/** `value` within `[lo, hi]`. */
const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/** The learned flags of one message's digit fields. */
interface DigitLearning {
  /** Whether the frame is the previous value's. */
  readonly frame: Fenwick;
  /** Whether the widths are the previous value's, where they can be. */
  readonly widths: Fenwick;
}

/**
 * Digit fields: a value is its frame, the items around its maximal runs of
 * digits, and the runs, each split into fields of at most `FIELD_DIGITS`
 * digits read as one integer of exactly that width, leading zeros kept.
 * Once the node has a previous value, a flag says whether the frame is
 * that value's; else the number of fields and of digits come first, then
 * the frame in the node's plain spelling, each field one placeholder
 * digit. Then the widths, unless one field takes every digit, or a flag
 * says they are the previous value's where their sum allows; then each
 * field's value. `learned`, the flags learn and every number sits on a
 * learned scale, a field's around the same field of the previous value,
 * each of the first `FIELD_SCALES` fields on a scale of its own; `delta`
 * alone puts the values on the static scale around that field, and
 * otherwise each is uniform over its width. Needs an alphabet that knows
 * its digits.
 */
export class DigitFields implements Method<number[]> {
  private readonly digit: (item: number) => number;
  private readonly digitItem: (digit: number) => number;
  /** The item a field stands as in a spelled frame: the least digit the alphabet holds. */
  private readonly placeholder: number;
  private readonly counts: Magnitude;
  private readonly sums: Magnitude;
  private readonly widthScale: Magnitude;
  /** The scale of each field's value, by field; uniform where undefined. */
  private readonly scales: Magnitude[] = [];

  constructor(
    private readonly host: FieldHost,
    private readonly learned: boolean,
    delta: boolean
  ) {
    const { symbols } = host;
    this.digit = (symbols.digit as (item: number) => number).bind(symbols);
    this.digitItem = (symbols.digitItem as (digit: number) => number).bind(symbols);
    let placeholder = -1;
    for (let d = 9; d >= 0; d--) {
      const item = this.digitItem(d);
      placeholder = item < 0 ? placeholder : item;
    }
    this.placeholder = placeholder;
    const scale = (): Magnitude => (learned ? new FieldScale() : STATIC_MAGNITUDE);
    this.counts = scale();
    this.sums = scale();
    this.widthScale = scale();
    if (learned || delta) {
      for (let i = 0; i < FIELD_SCALES; i++) {
        this.scales.push(scale());
      }
    }
  }

  private learning(side: Encoder | Decoder): DigitLearning | undefined {
    return !this.learned
      ? undefined
      : side.state(this, () => ({ frame: flag(side), widths: flag(side) }));
  }

  /** The items last split, and their fields: a value's are split again for each spelling tried and as the next one's previous. */
  private memo: [readonly number[], Fields][] = [];

  /** The fields of `items`. */
  private fields(items: readonly number[]): Fields {
    const { memo } = this;
    for (const [known, fields] of memo) {
      if (known === items) {
        return fields;
      }
    }
    const fields = this.split(items);
    memo.unshift([items, fields]);
    memo.length = Math.min(memo.length, 2);
    return fields;
  }

  /** The fields of `items`, split afresh. */
  private split(items: readonly number[]): Fields {
    const gaps: number[][] = [];
    const widths: number[] = [];
    const values: number[] = [];
    const units = this.host.symbols.units.bind(this.host.symbols);
    let gap: number[] = [];
    let frame = 0;
    let k = 0;
    while (k < items.length) {
      const item = items[k];
      if (this.digit(item) < 0) {
        gap.push(item);
        frame += units(item);
        k++;
        continue;
      }
      let width = 0;
      let value = 0;
      for (; k < items.length && width < FIELD_DIGITS; k++, width++) {
        const d = this.digit(items[k]);
        if (d < 0) {
          break;
        }
        value = value * 10 + d;
      }
      gaps.push(gap);
      gap = [];
      widths.push(width);
      values.push(value);
    }
    gaps.push(gap);
    return { gaps, widths, values, frame };
  }

  /** Digit fields stand for a value only once the node's previous value holds a digit. */
  available(side: Encoder | Decoder): boolean {
    const prev = this.host.prev(side);
    return prev !== undefined && prev.some((item) => this.digit(item) >= 0);
  }

  write(enc: Encoder, items: number[]): void {
    this.walk(enc, writer(enc), this.fields(items));
  }

  read(dec: Decoder): number[] {
    return this.walk(dec, reader(dec), undefined);
  }

  learn(side: Encoder | Decoder, items: number[]): void {
    this.walk(side, learner(side), this.fields(items), true);
  }

  /** Whether `a` and `b` hold the same gaps. */
  private static sameGaps(a: Fields, b: Fields): boolean {
    if (a.gaps.length !== b.gaps.length) {
      return false;
    }
    return a.gaps.every((gap, i) => {
      const other = b.gaps[i];
      return gap.length === other.length && gap.every((item, j) => item === other[j]);
    });
  }

  /**
   * Codes a value through `io`: `own`, the value's fields, when writing or
   * learning; read, the items it returns. `learnOnly` skips the frame,
   * which the plain spelling neither writes nor learns.
   */
  private walk(
    side: Encoder | Decoder,
    io: Io,
    own: Fields | undefined,
    learnOnly = false
  ): number[] {
    const { host } = this;
    const span = host.span(side);
    const learning = this.learning(side);
    const prevItems = host.prev(side);
    const prev = prevItems === undefined ? undefined : this.fields(prevItems);
    let gaps: readonly (readonly number[])[];
    let count: number;
    let digits: number;
    const same =
      prev !== undefined &&
      io.bit(learning?.frame, own !== undefined && DigitFields.sameGaps(own, prev) ? 1 : 0) === 1;
    if (same) {
      gaps = prev.gaps;
      count = gaps.length - 1;
      digits = span - prev.frame;
      if (digits < count || digits > count * FIELD_DIGITS) {
        throw new CorruptInputError('Digit fields do not fit the frame');
      }
    } else {
      count = io.scaled(
        this.counts,
        own?.widths.length ?? 0,
        clamp(prev?.widths.length ?? 0, 0, span),
        0,
        span
      );
      const top = Math.min(span, count * FIELD_DIGITS);
      const sum = own === undefined ? 0 : span - own.frame;
      digits = io.scaled(
        this.sums,
        sum,
        clamp(prev === undefined ? count : span - prev.frame, count, top),
        count,
        top
      );
      gaps = learnOnly ? [] : this.frame(side, own, count, span - digits + count);
    }
    const widths = this.widths(io, learning, own, prev, count, digits);
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const radix = 10 ** widths[i];
      const value = own?.values[i] ?? 0;
      const scale = this.scales[Math.min(i, FIELD_SCALES - 1)];
      if (scale === undefined) {
        values.push(io.uniform(value, radix));
      } else {
        const origin = prev !== undefined && i < prev.values.length ? prev.values[i] : 0;
        values.push(io.scaled(scale, value, clamp(origin, 0, radix - 1), 0, radix - 1));
      }
    }
    return own === undefined ? this.build(gaps, widths, values) : [];
  }

  /**
   * The gaps of a frame spelled in full, `units` of them with one
   * placeholder per field: written from `own`, or read and split at the
   * placeholders.
   */
  private frame(
    side: Encoder | Decoder,
    own: Fields | undefined,
    count: number,
    units: number
  ): readonly (readonly number[])[] {
    if (own !== undefined) {
      const spelled: number[] = [...own.gaps[0]];
      for (let i = 1; i < own.gaps.length; i++) {
        spelled.push(this.placeholder, ...own.gaps[i]);
      }
      this.host.writeBody(side as Encoder, spelled, units);
      return own.gaps;
    }
    const spelled = this.host.readBody(side as Decoder, units);
    const gaps: number[][] = [[]];
    for (const item of spelled) {
      if (this.digit(item) >= 0) {
        gaps.push([]);
      } else {
        gaps[gaps.length - 1].push(item);
      }
    }
    if (gaps.length !== count + 1) {
      throw new CorruptInputError('A frame holds the wrong number of fields');
    }
    return gaps;
  }

  /** The widths of `count` fields of `digits` digits in all, through `io`. */
  private widths(
    io: Io,
    learning: DigitLearning | undefined,
    own: Fields | undefined,
    prev: Fields | undefined,
    count: number,
    digits: number
  ): number[] {
    if (count === 0) {
      return [];
    }
    if (count === 1) {
      return [digits];
    }
    if (prev !== undefined && prev.widths.length === count) {
      const sum = prev.widths.reduce((a, b) => a + b, 0);
      if (sum === digits) {
        const same = own !== undefined && own.widths.every((w, i) => w === prev.widths[i]);
        if (io.bit(learning?.widths, same ? 1 : 0) === 1) {
          return [...prev.widths];
        }
      }
    }
    // `digits` lies in [count, count * FIELD_DIGITS], so each width's range
    // is never empty, and what is left for the last lies in [1, FIELD_DIGITS].
    const widths: number[] = [];
    let rest = digits;
    for (let i = 0; i < count - 1; i++) {
      const after = count - 1 - i;
      const lo = Math.max(1, rest - after * FIELD_DIGITS);
      const hi = Math.min(FIELD_DIGITS, rest - after);
      const origin = clamp(prev?.widths[i] ?? 1, lo, hi);
      const width = io.scaled(this.widthScale, own?.widths[i] ?? 0, origin, lo, hi);
      widths.push(width);
      rest -= width;
    }
    widths.push(rest);
    return widths;
  }

  /** The items of a value from its gaps and fields. */
  private build(
    gaps: readonly (readonly number[])[],
    widths: readonly number[],
    values: readonly number[]
  ): number[] {
    const items: number[] = [...gaps[0]];
    for (let i = 0; i < widths.length; i++) {
      const text = String(values[i]).padStart(widths[i], '0');
      for (let j = 0; j < text.length; j++) {
        const item = this.digitItem(text.charCodeAt(j) - 48);
        if (item < 0) {
          throw new CorruptInputError('A digit field holds a digit outside the alphabet');
        }
        items.push(item);
      }
      items.push(...gaps[i + 1]);
    }
    return items;
  }
}

/**
 * One place of the strings of a length: the items seen there, and under
 * learning how often each occurred and whether the item was new or seen.
 */
interface Spot {
  readonly items: number[];
  readonly counts?: number[];
  /** How many values reached the spot: the sum of `counts`. */
  total: number;
  /** How often the item here was new, and seen, gaining 2 a value and halving past `SPOT_WINDOW`. */
  readonly fresh?: number[];
}

/** The strings of one span: the first one's items until a second comes, then a spot per place. */
interface Layout {
  readonly first: readonly number[];
  seen: number;
  spots?: Spot[];
}

/** One message's positions: the layout of each span, and the learned odds of an item new to its spot. */
interface Positions {
  readonly layouts: Map<number, Layout>;
  readonly symbols?: Fenwick;
}

/** Past this total a spot's new-or-seen counts halve. */
const SPOT_WINDOW = 32;

/** What an item new to its spot adds to its symbol's learned count, against 1 each to start. */
const SYMBOL_GAIN = 32;

/** No spot: a place no string of the span reached yet. */
const EMPTY: Spot = { items: [], total: 0 };

/**
 * Positions: a value whose span the node met `gate` times before spells
 * each item at its place among the items the strings of that span held
 * there. A place first says whether its item is one seen there, then which;
 * a new one is its symbol and tail. With fixed odds every item seen there
 * and the escape are alike, and a new symbol is uniform. `learned`, the
 * new-or-seen flag learns per place, a seen item weighs by how often it
 * occurred there, and a new one's symbol by how often symbols came new to
 * any place of the node. The odds of a span learn from every value of it
 * the node spells, whichever spelling it takes.
 */
export class Positional implements Method<number[]> {
  constructor(
    private readonly host: FieldHost,
    private readonly learned: boolean,
    private readonly gate: number
  ) {}

  private positions(side: Encoder | Decoder): Positions {
    return side.state(this, () => ({
      layouts: new Map(),
      symbols: this.learned
        ? new Fenwick(new Array<number>(this.host.symbols.size).fill(1), side.journal)
        : undefined,
    }));
  }

  available(side: Encoder | Decoder): boolean {
    const layout = this.positions(side).layouts.get(this.host.span(side));
    return layout !== undefined && layout.seen >= this.gate;
  }

  /** The spot of place `k` in `layout`, standing in for one not built yet. */
  private spot(layout: Layout, k: number): Spot {
    const { spots, first } = layout;
    if (spots !== undefined) {
      return k < spots.length ? spots[k] : EMPTY;
    }
    return k < first.length ? this.newSpot(first[k]) : EMPTY;
  }

  /** A spot holding `item` once. */
  private newSpot(item: number): Spot {
    return this.learned
      ? { items: [item], counts: [1], total: 1, fresh: [1, 1] }
      : { items: [item], total: 1 };
  }

  write(enc: Encoder, items: number[]): void {
    const { layouts, symbols: table } = this.positions(enc);
    const layout = layouts.get(this.host.span(enc)) as Layout;
    const { symbols } = this.host;
    for (let k = 0; k < items.length; k++) {
      const item = items[k];
      const spot = this.spot(layout, k);
      const member = spot.items.indexOf(item);
      const n = spot.items.length;
      const { counts, fresh } = spot;
      if (counts === undefined || fresh === undefined) {
        enc.compose(member + 1, n + 1);
      } else if (n > 0) {
        enc.composeWeighted(
          member < 0 ? 0 : fresh[0],
          fresh[member < 0 ? 0 : 1],
          fresh[0] + fresh[1]
        );
        if (member >= 0 && n > 1) {
          let cum = 0;
          for (let j = 0; j < member; j++) {
            cum += counts[j];
          }
          enc.composeWeighted(cum, counts[member], spot.total);
        }
      }
      if (member < 0) {
        const symbol = symbols.symbol(item);
        const ruled = this.ruled(spot);
        if (table === undefined) {
          const below = ruled.filter((other) => other < symbol).length;
          enc.compose(symbol - below, symbols.size - ruled.length);
        } else {
          let cum = table.cum(symbol);
          let total = table.total;
          for (const other of ruled) {
            const freq = table.freq(other);
            total -= freq;
            cum -= other < symbol ? freq : 0;
          }
          enc.composeWeighted(cum, table.freq(symbol), total);
        }
        symbols.tail(enc, item, symbol);
      }
    }
  }

  read(dec: Decoder): number[] {
    const { layouts, symbols: table } = this.positions(dec);
    const span = this.host.span(dec);
    const layout = layouts.get(span) as Layout;
    const { symbols } = this.host;
    const items: number[] = [];
    let units = 0;
    while (units < span) {
      if (items.length > 2 * span) {
        throw new CorruptInputError(`More items than twice the length ${span}`);
      }
      const spot = this.spot(layout, items.length);
      const n = spot.items.length;
      const { counts, fresh } = spot;
      let member = -1;
      if (counts === undefined || fresh === undefined) {
        member = dec.parse(n + 1) - 1;
      } else if (n > 0) {
        const seen = dec.parseWeighted(fresh[0] + fresh[1], (r) =>
          r < fresh[0] ? ([0, 0, fresh[0]] as const) : ([1, fresh[0], fresh[1]] as const)
        );
        if (seen === 1) {
          member = n === 1 ? 0 : dec.parseWeighted(spot.total, (r) => locate(counts, r));
        }
      }
      let item: number;
      if (member >= 0) {
        item = spot.items[member];
      } else {
        const symbol = this.readNew(dec, table, spot);
        item = symbols.untail(dec, symbol);
      }
      items.push(item);
      units += symbols.units(item);
    }
    if (units > span) {
      throw new CorruptInputError(`Items overrun the length ${span}`);
    }
    return items;
  }

  /**
   * The symbols an item new to `spot` cannot have, ascending: those of the
   * items seen there that are their symbol alone.
   */
  private ruled(spot: Spot): number[] {
    const { symbols } = this.host;
    const ruled: number[] = [];
    for (const item of spot.items) {
      const symbol = symbols.symbol(item);
      if (symbols.tails(item, symbol) === 1 && !ruled.includes(symbol)) {
        ruled.push(symbol);
      }
    }
    return ruled.sort((a, b) => a - b);
  }

  /**
   * Reads the symbol of an item new to `spot`, every one alike or from
   * `table`, the symbols `ruled` out owning no states: a rank or residual
   * at or past where a ruled-out symbol would stand lies past it.
   */
  private readNew(dec: Decoder, table: Fenwick | undefined, spot: Spot): number {
    const ruled = this.ruled(spot);
    if (table === undefined) {
      let symbol = dec.parse(this.host.symbols.size - ruled.length);
      for (const other of ruled) {
        symbol += other <= symbol ? 1 : 0;
      }
      return symbol;
    }
    let total = table.total;
    for (const symbol of ruled) {
      total -= table.freq(symbol);
    }
    return dec.parseWeighted(total, (residual) => {
      let skipped = 0;
      for (const symbol of ruled) {
        if (table.cum(symbol) - skipped > residual) {
          break;
        }
        skipped += table.freq(symbol);
      }
      const symbol = table.locate(residual + skipped);
      return [symbol, table.cum(symbol) - skipped, table.freq(symbol)] as const;
    });
  }

  /** The positions learn in `see`, from every value spelled. */
  learn(): void {}

  /** Learns `items`, a value of the current span the node spelled, whichever spelling it took. */
  see(side: Encoder | Decoder, items: readonly number[]): void {
    const { layouts, symbols: table } = this.positions(side);
    const span = this.host.span(side);
    const journal = side.journal?.active === true ? side.journal : undefined;
    const layout = layouts.get(span);
    if (layout === undefined) {
      layouts.set(span, { first: items, seen: 1 });
      journal?.drop(layouts, span);
      return;
    }
    let spots = layout.spots;
    if (spots === undefined) {
      spots = layout.first.map((item) => this.newSpot(item));
      if (table !== undefined) {
        for (const item of layout.first) {
          table.add(this.host.symbols.symbol(item), SYMBOL_GAIN);
        }
      }
      layout.spots = spots;
      journal?.call(() => {
        layout.spots = undefined;
      });
    }
    for (let k = 0; k < items.length; k++) {
      const item = items[k];
      if (k === spots.length) {
        journal?.truncate(spots, k);
        spots.push(this.newSpot(item));
        table?.add(this.host.symbols.symbol(item), SYMBOL_GAIN);
        continue;
      }
      const spot = spots[k];
      const member = spot.items.indexOf(item);
      const { counts, fresh } = spot;
      if (fresh !== undefined) {
        journal?.pair(fresh, fresh[0], fresh[1]);
        fresh[member < 0 ? 0 : 1] += 2;
        if (fresh[0] + fresh[1] > SPOT_WINDOW) {
          fresh[0] = Math.ceil(fresh[0] / 2);
          fresh[1] = Math.ceil(fresh[1] / 2);
        }
      }
      journal?.set(spot, 'total', spot.total);
      spot.total++;
      if (member >= 0) {
        if (counts !== undefined) {
          journal?.set(counts, member, counts[member]);
          counts[member]++;
        }
        continue;
      }
      journal?.truncate(spot.items, spot.items.length);
      spot.items.push(item);
      if (counts !== undefined) {
        journal?.truncate(counts, counts.length);
        counts.push(1);
      }
      table?.add(this.host.symbols.symbol(item), SYMBOL_GAIN);
    }
    journal?.set(layout, 'seen', layout.seen);
    layout.seen++;
  }
}

/** The member of `counts` whose bucket holds `residual`, as `parseWeighted` reads it. */
function locate(counts: readonly number[], residual: number): readonly [number, number, number] {
  let cum = 0;
  let member = 0;
  while (cum + counts[member] <= residual) {
    cum += counts[member];
    member++;
  }
  return [member, cum, counts[member]];
}
