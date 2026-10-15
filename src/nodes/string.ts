/**
 * Text. The default encoding spends one laddered slot per code point — about
 * 7 bits for ASCII, 18 to 27 for everything else — and round-trips any JS
 * string bit-exact, lone surrogates included. `.prose()` swaps the ladder
 * for the order-1 frequency model over lowercase text, its casing and
 * separators carried by a shape; `.adaptive()` alone codes English prose
 * whose odds the message takes over. An explicit charset trades generality for
 * density over a known alphabet. `p.string`.
 */
import { Encoder, Decoder, Alphabet, CorruptInputError, costUnits } from '../packer';
import type { Charset } from '../packer';
import { PNode } from './base';
import { describe } from './path';
import { checkUnset } from './lattice';
import type { Cdf } from './weights';
import type { SequenceAdaptiveOptions } from './adaptive';
import type { Kind } from './guards';
import {
  TEXT_FIRST_RADIX,
  codePointBand,
  codePointSymbol,
  codePointTailRadix,
  composeCodePoint,
  composeCodePointTail,
  parseCodePoint,
  parseCodePointTail,
} from './codepoint';
import {
  ProseModels,
  SHIFT,
  compileProse,
  proseContext,
  shiftedTable,
  type ProseModel,
  type ProseTable,
  type ShiftedTable,
} from './prose';
import { buildWeights } from './weights';
import { withMethod } from './methods';
import { members, type Members } from './members';
import { LOWER, MIXED, SHAPE_COUNT, SHAPE_WEIGHTS, plain, restore, shapesOf } from './shape';
import {
  Sequence,
  withRepeats,
  type SequenceBounds,
  type SequenceSpelling,
  type Symbols,
} from './sequence';

/** What every text alphabet shares: a length prefix counting UTF-16 code units. */
abstract class Text {
  readonly who = 'p.string';
  readonly noun = 'length';
  readonly start: number = 0;

  // The length prefix counts UTF-16 code units (`.length`), not code
  // points, so `.max()` keeps plain JS string semantics.
  count(value: string): number {
    return value.length;
  }

  span(count: number): number {
    return count;
  }

  subject(value: string): string {
    return `String length ${value.length}`;
  }

  // Every alphabet spells distinct strings apart, so a string is its own identity.
  identity(value: string): string {
    return value;
  }
}

/** Whether `code` is an ASCII capital. */
const isCapital = (code: number): boolean => code >= 65 && code <= 90;

/** The code points a string is built from at a time: few enough to pass as arguments. */
const BUILD_CHUNK = 4096;

/** Text spelled one code point per item: the ladder and the prose model. */
abstract class CodePoints extends Text {
  readonly item = 'code point';
  readonly tailless = false;

  items(value: string): number[] {
    // Every adjacent lead+trail pair merges into one code point; lone
    // surrogates fall through as their own code points. The pairing reads
    // code units: V8's optimized `codePointAt` merges a sliced string's
    // final lead with the trail beyond the slice.
    const codes: number[] = [];
    for (let i = 0; i < value.length; ) {
      const unit = value.charCodeAt(i);
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      const code =
        unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
          ? (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000
          : unit;
      codes.push(code);
      i += code > 0xffff ? 2 : 1;
    }
    return codes;
  }

  units(code: number): number {
    return code > 0xffff ? 2 : 1;
  }

  build(codes: number[]): string {
    let value = '';
    for (let at = 0; at < codes.length; at += BUILD_CHUNK) {
      value += String.fromCodePoint(...codes.slice(at, at + BUILD_CHUNK));
    }
    return value;
  }
}

/** The laddered default: the first slot is the symbol, the band offset its tail. */
class Ladder extends CodePoints implements Symbols<string> {
  readonly pool = 'ladder';
  readonly size = TEXT_FIRST_RADIX;

  symbol(code: number): number {
    return codePointSymbol(code);
  }

  tail(enc: Encoder, code: number, symbol: number): void {
    composeCodePointTail(enc, code, symbol);
  }

  tails(_code: number, symbol: number): number {
    return codePointTailRadix(symbol);
  }

  untail(dec: Decoder, symbol: number): number {
    return parseCodePointTail(dec, symbol);
  }

  row(): number {
    return 0;
  }
}

/**
 * The prose model: a symbol per modeled character plus the escape, priced
 * in the row of the character before; an escaped code point follows its
 * symbol on the ladder. `shifted`, the text keeps its capitals: each one a
 * shift, which takes no length, before its lowercase letter. The shift
 * weighs by the character before it, and the letter after it is priced in a
 * row of its own.
 */
class Prose extends CodePoints implements Symbols<string> {
  /** The model, or its shifted table: the same model compiles to the same tables. */
  readonly pool: object;
  readonly size: number;
  readonly rows: readonly (readonly number[])[];
  override readonly start: number;
  /** The symbol of the escape. */
  readonly escape: number;
  /** The symbol of the shift, and the row after it; -1 without. */
  private readonly shift: number;

  constructor(
    model: ProseModel,
    private readonly table: ProseTable,
    shifted?: ShiftedTable
  ) {
    super();
    this.escape = table.escape;
    if (shifted === undefined) {
      this.pool = model;
      this.size = table.escape + 1;
      this.rows = model.weights;
      this.start = table.start;
      this.shift = -1;
    } else {
      this.pool = shifted;
      this.size = shifted.shift + 1;
      this.rows = shifted.rows;
      this.start = shifted.start;
      this.shift = shifted.shift;
    }
  }

  override items(value: string): number[] {
    if (this.shift < 0) {
      return super.items(value);
    }
    // The code points as `CodePoints` pairs them, each capital a shift and
    // its lowercase letter.
    const items: number[] = [];
    for (let i = 0; i < value.length; ) {
      const unit = value.charCodeAt(i);
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        items.push((unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000);
        i += 2;
        continue;
      }
      if (isCapital(unit)) {
        items.push(SHIFT, unit + 32);
      } else {
        items.push(unit);
      }
      i++;
    }
    return items;
  }

  override units(code: number): number {
    return code > 0xffff ? 2 : code === SHIFT ? 0 : 1;
  }

  symbol(code: number): number {
    return code === SHIFT ? this.shift : proseContext(this.table, code);
  }

  tail(enc: Encoder, code: number, symbol: number): void {
    if (symbol === this.table.escape) {
      composeCodePoint(enc, code);
    }
  }

  tails(code: number, symbol: number): number {
    return symbol === this.table.escape
      ? TEXT_FIRST_RADIX * codePointTailRadix(codePointSymbol(code))
      : 1;
  }

  untail(dec: Decoder, symbol: number): number {
    const { table } = this;
    return symbol < table.escape
      ? table.codes[symbol]
      : symbol === table.escape
        ? parseCodePoint(dec)
        : SHIFT;
  }

  row(code: number): number {
    return code === SHIFT ? this.shift : proseContext(this.table, code);
  }

  /** The text of the items, refusing a shift that a lowercase letter does not follow. */
  override build(items: number[]): string {
    if (this.shift < 0) {
      return super.build(items);
    }
    const codes: number[] = [];
    for (let k = 0; k < items.length; k++) {
      let code = items[k];
      if (code === SHIFT) {
        code = items[++k];
        if (!(code >= 97 && code <= 122)) {
          throw new CorruptInputError('A shift is not followed by a lowercase letter');
        }
        code -= 32;
      }
      codes.push(code);
    }
    return super.build(codes);
  }
}

/**
 * The learned text model's symbols for a prose model: its characters, then
 * one per first slot of the ladder whose code points it does not hold, the
 * ASCII capitals among them. `rows` are the model's, a capital weighing
 * what a shift before its letter would, every other slot an equal share of
 * the escape, then `SEEN_SHARE` such shares for a code point seen before;
 * `live` lifts every symbol of a row by `LIVE_SHARE` of its mean weight.
 */
interface LearnedTable {
  readonly size: number;
  readonly rows: readonly (readonly number[])[];
  readonly live: readonly (readonly number[])[];
  /** The symbol of each ladder slot outside the model, -1 for a slot inside it. */
  readonly slots: Int32Array;
  /** The ladder slot of each symbol from the model's escape on. */
  readonly ladder: readonly number[];
}

/**
 * The share of a row's mean weight every symbol gains in the tables that
 * learn, as tenths: odds a prose model all but rules out stay within reach
 * of text that is not prose, while the static coding keeps the model's own.
 */
const LIVE_SHARE = 3;

/** What a code point seen before weighs, in shares of the escape. */
const SEEN_SHARE = 3;

const learnedTables = new WeakMap<ProseModel, LearnedTable>();

/** The learned tables of `model`, built once per model. */
function learnedTable(model: ProseModel): LearnedTable {
  let learned = learnedTables.get(model);
  if (learned === undefined) {
    const table = compileProse(model);
    const shift = shiftedTable(model);
    const n = table.escape;
    const slots = new Int32Array(TEXT_FIRST_RADIX).fill(-1);
    const ladder: number[] = [];
    for (let slot = 0; slot < TEXT_FIRST_RADIX; slot++) {
      if (slot > 127 || table.ascii[slot] === n) {
        slots[slot] = n + ladder.length;
        ladder.push(slot);
      }
    }
    // A capital's share of a shift: its letter's weight at the start of a word.
    const start = model.weights[table.start];
    const letter = (code: number): number => {
      const sym = table.ascii[code + 32];
      return sym < n ? start[sym] : 0;
    };
    let letters = 0;
    for (let code = 65; code <= 90; code++) {
      letters += letter(code);
    }
    const rows = model.weights.map((row, r) => {
      const out = row.slice(0, n);
      const share = Math.max(1, Math.round(row[n] / ladder.length));
      for (const slot of ladder) {
        out.push(
          isCapital(slot) && letters > 0
            ? Math.max(1, Math.round((shift.rows[r][shift.shift] * letter(slot)) / letters))
            : share
        );
      }
      out.push(SEEN_SHARE * share);
      return out;
    });
    const live = rows.map((row) => {
      const total = row.reduce((sum, weight) => sum + weight, 0);
      const lift = Math.max(1, Math.round((LIVE_SHARE * total) / (10 * row.length)));
      return row.map((weight) => weight + lift);
    });
    learned = { size: n + ladder.length, rows, live, slots, ladder };
    learnedTables.set(model, learned);
  }
  return learned;
}

/**
 * Text under a prose model that learns: every code point a symbol, those
 * the model holds as their characters and every other as its ladder slot
 * followed by its band offset, capitals included. A code point spelled
 * with a band offset grows the symbols by one of its own once the message
 * has met it (`./grown`). A symbol is priced in the model's row of the
 * character before it, a capital's that of its lowercase letter, any other
 * slot's that of the escape.
 */
class LearnedText extends CodePoints implements Symbols<string> {
  /** The tables: the same model shares them. */
  readonly pool: object;
  readonly size: number;
  readonly rows: readonly (readonly number[])[];
  readonly prior: { readonly live: readonly (readonly number[])[]; readonly keep: true };
  override readonly start: number;
  private readonly learned: LearnedTable;

  constructor(
    model: ProseModel,
    private readonly table: ProseTable
  ) {
    super();
    const learned = learnedTable(model);
    this.learned = learned;
    this.pool = learned;
    this.size = learned.size;
    this.rows = learned.rows;
    this.prior = { live: learned.live, keep: true };
    this.start = table.start;
  }

  symbol(code: number): number {
    const sym = proseContext(this.table, code);
    return sym < this.table.escape ? sym : this.learned.slots[codePointSymbol(code)];
  }

  /** The ladder slot of `symbol`, -1 for one of the model's characters. */
  private slot(symbol: number): number {
    const at = symbol - this.table.escape;
    return at < 0 ? -1 : this.learned.ladder[at];
  }

  tail(enc: Encoder, code: number, symbol: number): void {
    const slot = this.slot(symbol);
    if (slot >= 0) {
      composeCodePointTail(enc, code, slot);
    }
  }

  tails(_code: number, symbol: number): number {
    const slot = this.slot(symbol);
    return slot < 0 ? 1 : codePointTailRadix(slot);
  }

  range(symbol: number): readonly [number, number] | undefined {
    const slot = this.slot(symbol);
    return slot < 0 ? undefined : codePointBand(slot);
  }

  untail(dec: Decoder, symbol: number): number {
    const slot = this.slot(symbol);
    return slot < 0 ? this.table.codes[symbol] : parseCodePointTail(dec, slot);
  }

  row(code: number): number {
    const sym = proseContext(this.table, code);
    return sym === this.table.escape && isCapital(code) ? proseContext(this.table, code + 32) : sym;
  }
}

/** An explicit charset: each character is its digit in the alphabet. */
class CharsetText extends Text implements Symbols<string> {
  readonly item = 'character';
  readonly tailless = true;
  readonly size: number;
  /** The charset, a range by its ends: the same charset is the same alphabet. */
  readonly pool: string;

  constructor(private readonly alphabet: Alphabet) {
    super();
    this.size = alphabet.size;
    const charset = alphabet.charset;
    this.pool =
      typeof charset === 'string' ? `charset ${charset}` : `range ${charset[0]} ${charset[1]}`;
  }

  items(value: string): number[] {
    const alphabet = this.alphabet;
    const digits: number[] = [];
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      const digit = alphabet.digitOf(code);
      if (digit === -1) {
        const charset = alphabet.charset;
        throw new RangeError(
          typeof charset === 'string'
            ? `Character ${describe(value.charAt(i))} at ${i} is not in the character set`
            : `Character ${describe(value.charAt(i))} (code ${code}) at ${i} is outside the range ${charset[0]}–${charset[1]}`
        );
      }
      digits.push(digit);
    }
    return digits;
  }

  units(): number {
    return 1;
  }

  symbol(digit: number): number {
    return digit;
  }

  tail(): void {}

  tails(): number {
    return 1;
  }

  untail(_dec: Decoder, digit: number): number {
    return digit;
  }

  row(): number {
    return 0;
  }

  build(digits: number[]): string {
    let value = '';
    for (const digit of digits) {
      value += this.alphabet.charAt(digit);
    }
    return value;
  }
}

/** How a node codes its strings: one spelling, or a learned pick among several. */
interface TextCodec {
  write(enc: Encoder, value: string): void;
  read(dec: Decoder): string;
}

/** The cost, in `COST_UNITS`, of each symbol in each row of a pool's static tables, row by row. */
const unitTables = new WeakMap<object, Int32Array>();

/** The longest string whose priced shape a node keeps, and how many it keeps before starting over. */
const PICKED_LENGTH = 64;

/**
 * The kinds of text a learned prose node codes, each in contexts and a
 * prior of its own while sharing the repeats: lowercase words, the text of
 * every shape but `mixed`, and the verbatim text of `mixed`.
 */
const WORDS = 0;
const VERBATIM = 1;
const MAX_PICKS = 4096;

/** The cost of the ladder's first slot after an escape. */
const ESCAPE_UNITS = costUnits(1, TEXT_FIRST_RADIX);

/** The cost of each shape under the static weights. */
const SHAPE_UNITS: readonly number[] = (() => {
  const { freqs, total } = buildWeights(SHAPE_WEIGHTS, SHAPE_COUNT, 'p.string');
  return freqs.map((freq) => costUnits(freq, total));
})();

/**
 * The cost, in `COST_UNITS`, of `text` spelled in `prose` one symbol each at
 * its static odds, as the members writing them charge, the tails of escaped
 * code points included: what writing it charges after the length prefix.
 */
function priceText(prose: Prose, text: string): number {
  const { size, pool, rows } = prose;
  let units = unitTables.get(pool);
  if (units === undefined) {
    units = new Int32Array(rows.length * size);
    rows.forEach((row, r) => {
      const { freqs, total } = buildWeights(row, size, 'p.string prose');
      freqs.forEach((freq, sym) => {
        (units as Int32Array)[r * size + sym] = costUnits(freq, total);
      });
    });
    unitTables.set(pool, units);
  }
  const shifts = prose.size > prose.escape + 1;
  let cost = 0;
  let row = prose.start;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (shifts && isCapital(code)) {
      const shift = prose.symbol(SHIFT);
      cost += units[row * size + shift];
      row = prose.row(SHIFT);
      code += 32;
    }
    const symbol = prose.symbol(code);
    cost += units[row * size + symbol];
    if (symbol === prose.escape) {
      cost += ESCAPE_UNITS + costUnits(1, codePointTailRadix(codePointSymbol(code)));
    }
    row = prose.row(code);
  }
  return cost;
}

/**
 * Strings in a prose model: a shape, then the text as the shape codes it,
 * lowercase words joined by spaces, in the model; under `mixed` the string
 * itself, each capital a shift. Each string takes the cheapest shape that
 * restores it exactly: priced from the static tables where nothing learns
 * and nothing but the characters follows the length, else by writing each.
 * The shapes are weighed statically, or learned under `adaptive`, where
 * the text is `LearnedText`, `mixed` keeping its capitals as they are, and
 * the words and the mixed text learn their contexts apart.
 */
export class ProseText implements TextCodec {
  private readonly lower: Prose;
  private readonly shifted: Prose;
  /** The text of every shape but `mixed`, which has no capitals. */
  private readonly words: Sequence<string>;
  /** The text of `mixed`: its capitals shifted, or as they are under adaptive. */
  private readonly mixed: Sequence<string>;
  private readonly shapes: Members;
  /** Whether the shapes are priced instead of tried. */
  private readonly priced: boolean;
  /** The shape and text priced for each short string with a choice of them, until there are too many. */
  private readonly picks = new Map<string, [number, string]>();
  /** The shape the encoder last picked, which only orders its next tries. */
  private last = 0;

  constructor(model: ProseModel, bounds: SequenceBounds, spelling: SequenceSpelling) {
    const table = compileProse(model);
    this.lower = new Prose(model, table);
    this.shifted = new Prose(model, table, shiftedTable(model));
    const { adaptive } = bounds;
    if (adaptive === undefined) {
      this.words = new Sequence(this.lower, bounds, spelling);
      this.mixed = new Sequence(this.shifted, bounds, spelling);
    } else {
      const text = new LearnedText(model, table);
      this.words = new Sequence(text, bounds, spelling, WORDS);
      this.mixed = new Sequence(text, bounds, spelling, VERBATIM);
    }
    this.shapes = members(SHAPE_COUNT, { weights: SHAPE_WEIGHTS, adaptive }, 'p.string');
    const { delta, recall, repeats } = spelling;
    this.priced = adaptive === undefined && !delta && !recall && !repeats;
  }

  write(enc: Encoder, value: string): void {
    if (plain(value)) {
      this.spell(enc, LOWER, value);
      return;
    }
    const known = value.length <= PICKED_LENGTH ? this.picks.get(value) : undefined;
    if (known !== undefined) {
      this.spell(enc, known[0], known[1]);
      return;
    }
    const shapes = shapesOf(value);
    if (shapes.length === 1) {
      this.spell(enc, shapes[0][0], shapes[0][1]);
      return;
    }
    if (this.priced) {
      const pick = this.cheapest(shapes);
      if (value.length <= PICKED_LENGTH) {
        if (this.picks.size === MAX_PICKS) {
          this.picks.clear();
        }
        this.picks.set(value, pick);
      }
      this.spell(enc, pick[0], pick[1]);
      return;
    }
    const priority = shapes.map((_, i) => i);
    const first = shapes.findIndex(([shape]) => shape === this.last);
    const order = first > 0 ? [first, ...priority.filter((i) => i !== first)] : priority;
    const picked = enc.decide(priority, order, (i) => {
      this.spell(enc, shapes[i][0], shapes[i][1]);
    });
    this.last = shapes[picked][0];
  }

  /**
   * The shape of `shapes` whose writing charges least, and its text, from
   * the static tables, the length prefix priced only where the texts' lengths
   * differ; a tie goes to the earlier shape, as a written try's would.
   */
  private cheapest(shapes: readonly [number, string][]): [number, string] {
    const length = shapes[0][1].length;
    const lengths = shapes.some(([, text]) => text.length !== length);
    let best = 0;
    let least = Infinity;
    for (let i = 0; i < shapes.length; i++) {
      const [shape, text] = shapes[i];
      const cost = lengths ? this.cost(shape, text) : this.price(shape, text);
      if (cost < least) {
        best = i;
        least = cost;
      }
    }
    return shapes[best];
  }

  /**
   * The cost of `text` under `shape` from the static tables, its length
   * aside: what writing it charges, where the shapes are priced.
   */
  price(shape: number, text: string): number {
    return SHAPE_UNITS[shape] + priceText(shape === MIXED ? this.shifted : this.lower, text);
  }

  /** `price` with the length prefix: all that writing `text` under `shape` charges, Infinity where its length is out of bounds. */
  cost(shape: number, text: string): number {
    return this.price(shape, text) + this.words.lengthUnits(text.length);
  }

  /** Writes `shape` and `text`, the text that shape codes the string as. */
  spell(enc: Encoder, shape: number, text: string): void {
    this.shapes.write(enc, shape);
    (shape === MIXED ? this.mixed : this.words).write(enc, text);
  }

  read(dec: Decoder): string {
    const shape = this.shapes.read(dec);
    return shape === MIXED ? this.mixed.read(dec) : restore(shape, this.words.read(dec));
  }
}

export class PString extends PNode<string> {
  readonly _kinds: readonly Kind[] = ['string'];

  private readonly _bounds: SequenceBounds;
  /** Explicit charset; undefined selects the laddered code-point default. */
  private readonly _alphabet?: Alphabet;
  /** Prose model replacing the flat ladder, as given. */
  private readonly _prose?: ProseModel;
  /** The declared methods. */
  private readonly _spelling: SequenceSpelling;
  /**
   * The length and the characters, in the ladder, the prose model or the
   * charset; adaptive without either, in English prose.
   */
  private readonly _text: TextCodec;

  constructor(
    bounds: SequenceBounds = {},
    charset?: Charset,
    prose?: ProseModel,
    spelling: SequenceSpelling = {}
  ) {
    super();
    this._bounds = bounds;
    this._spelling = spelling;
    if (charset !== undefined) {
      if (prose !== undefined) {
        throw new TypeError('p.string cannot combine prose with a charset');
      }
      // The alphabet keeps its own copy of a range, so later caller mutation
      // of the array can't change the node. One character is a legal
      // alphabet: each character then costs nothing.
      this._alphabet = new Alphabet(charset, 1);
      this._text = new Sequence(new CharsetText(this._alphabet), bounds, spelling);
    } else if (prose !== undefined) {
      this._prose = prose;
      this._text = new ProseText(prose, bounds, spelling);
    } else {
      this._text =
        bounds.adaptive === undefined
          ? new Sequence(new Ladder(), bounds, spelling)
          : new ProseText(ProseModels.english, bounds, spelling);
    }
  }

  /** This node with `bounds`, `charset` and `prose`, keeping its methods. */
  private _with(
    bounds: SequenceBounds,
    charset = this._alphabet?.charset,
    prose = this._prose,
    spelling = this._spelling
  ): PString {
    return new PString(bounds, charset, prose, spelling);
  }

  /** A floor on the length; the prefix then counts up from it. */
  min(n: number): PString {
    checkUnset(this._bounds.min, 'p.string', 'min');
    return this._with({ ...this._bounds, min: n });
  }

  max(n: number): PString {
    checkUnset(this._bounds.max, 'p.string', 'max');
    return this._with({ ...this._bounds, max: n });
  }

  /**
   * Fix the exact length, the same as `.min(n).max(n)`. The prefix then costs
   * zero bits on the wire.
   */
  length(n: number): PString {
    checkUnset(this._bounds.min, 'p.string', 'min');
    checkUnset(this._bounds.max, 'p.string', 'max');
    return this._with({ ...this._bounds, min: n, max: n });
  }

  /**
   * Declare a prior over the LENGTH as an integer CDF: `fn(n)` is the
   * cumulative weight of lengths below `n`. Requires a max; a zero-weight
   * length cannot encode.
   */
  cdf(fn: Cdf): PString {
    return this._with({ ...this._bounds, prior: fn });
  }

  /**
   * Declare how likely each length from min (or 0) to max is, lowest first.
   * Same prior as `.cdf()`, given as the histogram instead of its running
   * total.
   */
  weights(w: readonly number[]): PString {
    return this._with({ ...this._bounds, prior: w });
  }

  /**
   * Let the node learn from the message. Each character is priced by the
   * three characters before it, as the message so far has followed them,
   * falling back to a prior over the characters that learns too; a stretch
   * that already occurred in the message is referred back to instead of
   * spelled again; and the length learns, on the magnitude scale from the
   * min when there is no max. Without a charset the text is prose: each
   * string names its shape first, as under `.prose()`, and the prose model
   * (English unless `.prose()` gives another) sets where the characters'
   * odds start, until the message's own counts outweigh it, so ids, hashes
   * and numbers soon cost what their characters do, and a character the
   * model lacks pays for its code point only the first time; a mixed-case
   * string keeps its capitals, and learns its contexts apart from the words
   * of the other shapes. With a charset every character starts out alike. The
   * characters learn together with those of every other adaptive string
   * of the message with the same charset or prose model and the same
   * window, unless `separate`. The declared length weights, or even ones
   * when none are, are where the length's prior starts. `window` is how
   * many observations a prior's counts hold before they halve, so the
   * newest weigh most (1024 when left out, and raised to the number of
   * values they count when smaller). From its second value on, each prior
   * spends one bit to stay static, or a few to name the learning rate
   * that paid off. The length takes weights, not a cdf; part of the wire
   * format, like the weights.
   */
  adaptive(options?: SequenceAdaptiveOptions): PString {
    return this._with({ ...this._bounds, adaptive: options ?? {} });
  }

  charset(c: Charset): PString {
    return this._with(this._bounds, c);
  }

  /**
   * Weight the default encoding for natural-language text: an order-1 model
   * prices each character given its predecessor, so common English costs
   * ~3-4 bits per character instead of the flat 7. The model sees the text
   * lowercase, as words joined by spaces: each string first names its shape
   * — lowercase, Capitalised or CAPS words joined by spaces, `_` or `-`,
   * Title Case, camelCase or PascalCase — so `USER_NOT_FOUND` and
   * `userNotFound` cost about what `user not found` does. A string no shape
   * fits is coded as it is, each capital a shift before its letter, likely
   * opening a word and rare inside one. Still encodes any string — code
   * points outside the model pay an escape on top of their laddered cost.
   * English by default; any other `ProseModel` swaps the matrix. Under
   * `.adaptive()` the model is where the learned odds start, as English is
   * for an adaptive string without `.prose()`.
   */
  prose(model: ProseModel = ProseModels.english): PString {
    return this._with(this._bounds, this._alphabet?.charset, model);
  }

  /**
   * Spell each string after the node's first by the start it shares with
   * the node's previous string: after the length, how many of its leading
   * characters are the previous string's (every count up to the shorter
   * length alike, or learned under `.adaptive()`), then only the characters
   * after them, priced as following that start. Suits sorted keys, paths
   * and URLs. Under `.adaptive()` without it, each string picks the plain
   * spelling or this one by a learned mode.
   */
  delta(): PString {
    const spelling = withMethod(this._spelling, 'delta', 'p.string');
    return this._with(this._bounds, undefined, undefined, spelling);
  }

  /**
   * Spell a string this node already wrote in the message by its place
   * among the distinct strings it wrote, and a new one as an escape and
   * then in full: with n strings seen, a repeat costs log2(n + 1) bits, or
   * under `.adaptive()` less the more often it recurs. The message's first
   * string costs nothing extra.
   */
  recall(): PString {
    const spelling = withMethod(this._spelling, 'recall', 'p.string');
    return this._with(this._bounds, undefined, undefined, spelling);
  }

  /**
   * Copy a stretch of characters this node already wrote in the message
   * instead of spelling it again: each string spends one bit on whether it
   * copies any, and one that does a bit at each position on whether a copy
   * starts there, and for a copy how far back it starts and how long it
   * runs. Under `.adaptive()` the odds learn and strings copy whether or
   * not this is declared.
   */
  repeats(): PString {
    return this._with(this._bounds, undefined, undefined, withRepeats(this._spelling, 'p.string'));
  }

  _write(enc: Encoder, value: string): void {
    this._text.write(enc, value);
  }

  _read(dec: Decoder): string {
    return this._text.read(dec);
  }
}
