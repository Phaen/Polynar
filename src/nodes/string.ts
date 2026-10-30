/**
 * Text. The default encoding spends one laddered slot per code point — about
 * 7 bits for ASCII, 18 to 27 for everything else — and round-trips any JS
 * string bit-exact, lone surrogates included. `.prose()` swaps the ladder
 * for the order-1 frequency model over lowercase text, its casing and
 * separators carried by a shape. An explicit charset trades generality for
 * density over a known alphabet. `.adaptive()` hands the code points to the
 * similarity predictor. `p.string`.
 */
import { Encoder, Decoder, Alphabet, CorruptInputError, costUnits } from '../packer';
import type { Charset } from '../packer';
import { checkAdaptive, resolve } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import { STRUCT, type AdaptiveOptions } from '../predictor/types';
import { PNode, type Run } from './base';
import { describe } from './path';
import { checkUnset, type LengthBounds } from './lattice';
import type { Cdf } from './weights';
import type { Kind } from './guards';
import {
  TEXT_DIRECT_MAX,
  TEXT_FIRST_RADIX,
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
import { members, type Members } from './members';
import { LOWER, MIXED, SHAPE_COUNT, SHAPE_WEIGHTS, plain, restore, shapesOf } from './shape';
import { Learned, PlainText, type Ascent, type Symbols } from './text';

const STR_MARKERS: ReadonlySet<number> = new Set([STRUCT.STR]);

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

  /**
   * The first slot keeps the order of the code points, ASCII one apiece;
   * a string above another that holds an astral code point where they
   * differ may hold any code unit above its lead surrogate there.
   */
  above(code: number): number {
    return code <= TEXT_DIRECT_MAX ? code + 1 : codePointSymbol(Math.min(code, 0xd800));
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
  /** The model, or its shifted table: the same model compiles to the same tables, which the costs are kept by. */
  readonly key: object;
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
      this.key = model;
      this.size = table.escape + 1;
      this.rows = model.weights;
      this.start = table.start;
      this.shift = -1;
    } else {
      this.key = shifted;
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

/** An explicit charset: each character is its digit in the alphabet. */
class CharsetText extends Text implements Symbols<string> {
  readonly item = 'character';
  readonly tailless = true;
  readonly size: number;

  /** Whether the digits follow the characters' code units: a range, or a charset listed ascending. */
  private readonly ascending: boolean;

  constructor(private readonly alphabet: Alphabet) {
    super();
    this.size = alphabet.size;
    const charset = alphabet.charset;
    let ascending = true;
    if (typeof charset === 'string') {
      for (let i = 1; i < charset.length; i++) {
        ascending &&= charset.charCodeAt(i) > charset.charCodeAt(i - 1);
      }
    }
    this.ascending = ascending;
  }

  above(digit: number): number | undefined {
    return this.ascending ? digit + 1 : undefined;
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

  /** The code unit of each digit, in digit order. */
  codes(): Int32Array {
    const alphabet = this.alphabet;
    return Int32Array.from({ length: alphabet.size }, (_, d) => alphabet.charAt(d).charCodeAt(0));
  }
}

/** How a plain node codes its strings: one spelling, or the cheapest of several. */
interface TextCodec {
  write(enc: Encoder, value: string): void;
  read(dec: Decoder): string;
  /** A run of strings, each after the start it shares with the one before. */
  run(ascent: Ascent): Run<string>;
}

/** The cost, in `COST_UNITS`, of each symbol in each row of a prose model's static tables, row by row. */
const unitTables = new WeakMap<object, Int32Array>();

/** The longest string whose priced shape a node keeps, and how many it keeps before starting over. */
const PICKED_LENGTH = 64;
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
  const { size, key, rows } = prose;
  let units = unitTables.get(key);
  if (units === undefined) {
    units = new Int32Array(rows.length * size);
    rows.forEach((row, r) => {
      const { freqs, total } = buildWeights(row, size, 'p.string prose');
      freqs.forEach((freq, sym) => {
        (units as Int32Array)[r * size + sym] = costUnits(freq, total);
      });
    });
    unitTables.set(key, units);
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
 * restores it exactly, priced from the static tables.
 */
export class ProseText implements TextCodec {
  private readonly lower: Prose;
  private readonly shifted: Prose;
  /** The text of every shape but `mixed`, which has no capitals. */
  private readonly words: PlainText<string>;
  /** The text of `mixed`, its capitals shifted. */
  private readonly mixed: PlainText<string>;
  private readonly shapes: Members;
  /** The shape and text priced for each short string with a choice of them, until there are too many. */
  private readonly picks = new Map<string, [number, string]>();

  constructor(model: ProseModel, bounds: LengthBounds) {
    const table = compileProse(model);
    this.lower = new Prose(model, table);
    this.shifted = new Prose(model, table, shiftedTable(model));
    this.words = new PlainText(this.lower, bounds);
    this.mixed = new PlainText(this.shifted, bounds);
    this.shapes = members(SHAPE_COUNT, { weights: SHAPE_WEIGHTS }, 'p.string');
  }

  write(enc: Encoder, value: string): void {
    this.shape(value, (shape, text) => this.spell(enc, shape, text));
  }

  /** Writes `value` by `spell` of the cheapest shape that restores it and its text, and returns those. */
  private shape(
    value: string,
    spell: (shape: number, text: string) => void
  ): readonly [number, string] {
    if (plain(value)) {
      spell(LOWER, value);
      return [LOWER, value];
    }
    const known = value.length <= PICKED_LENGTH ? this.picks.get(value) : undefined;
    if (known !== undefined) {
      spell(known[0], known[1]);
      return known;
    }
    const shapes = shapesOf(value);
    if (shapes.length === 1) {
      spell(shapes[0][0], shapes[0][1]);
      return shapes[0];
    }
    const pick = this.cheapest(shapes);
    if (value.length <= PICKED_LENGTH) {
      if (this.picks.size === MAX_PICKS) {
        this.picks.clear();
      }
      this.picks.set(value, pick);
    }
    spell(pick[0], pick[1]);
    return pick;
  }

  /**
   * A run of strings, each a shape and its text, the text after the start
   * it shares with the text of the run's previous string spelled by the same
   * codec. The order of the strings says nothing of the order of their
   * texts, so the run of texts is one of `any` ascent.
   */
  run(): Run<string> {
    const prev = new Map<PlainText<string>, number[]>();
    const codec = (shape: number): PlainText<string> => (shape === MIXED ? this.mixed : this.words);
    return {
      write: (enc, value) => {
        const [shape, text] = this.shape(value, (s, t) => {
          this.shapes.write(enc, s);
          codec(s).writeNext(enc, t, prev.get(codec(s)), 'any');
        });
        const spelled = codec(shape);
        prev.set(spelled, spelled.items(text));
      },
      read: (dec) => {
        const shape = this.shapes.read(dec);
        const spelled = codec(shape);
        const [text, items] = spelled.readNext(dec, prev.get(spelled), 'any');
        prev.set(spelled, items);
        return shape === MIXED ? text : restore(shape, text);
      },
    };
  }

  /**
   * The shape of `shapes` whose writing charges least, and its text, from
   * the static tables, the length prefix priced only where the texts' lengths
   * differ; a tie goes to the earlier shape.
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

  /** The cost of `text` under `shape` from the static tables, its length aside. */
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

  private readonly _bounds: LengthBounds;
  /** Explicit charset; undefined selects the laddered code-point default. */
  private readonly _alphabet?: Alphabet;
  /** Prose model replacing the flat ladder, as given. */
  private readonly _prose?: ProseModel;
  /** The options `.adaptive()` set, which hand the code points to the predictor. */
  readonly _adaptive?: AdaptiveOptions;
  /** The length and the characters, in the ladder, the prose model or the charset. */
  private readonly _text: TextCodec;
  /** The characters through the predictor, under `.adaptive()`. */
  private readonly _learned?: Learned<string>;

  constructor(
    bounds: LengthBounds = {},
    charset?: Charset,
    prose?: ProseModel,
    adaptive?: AdaptiveOptions
  ) {
    super();
    this._bounds = bounds;
    this._adaptive = adaptive;
    let charsetText: CharsetText | undefined;
    if (charset !== undefined) {
      if (prose !== undefined) {
        throw new TypeError('p.string cannot combine prose with a charset');
      }
      // The alphabet keeps its own copy of a range, so later caller mutation
      // of the array can't change the node. One character is a legal
      // alphabet: each character then costs nothing.
      this._alphabet = new Alphabet(charset, 1);
      charsetText = new CharsetText(this._alphabet);
      this._text = new PlainText(charsetText, bounds);
    } else if (prose !== undefined) {
      this._prose = prose;
      this._text = new ProseText(prose, bounds);
    } else {
      this._text = new PlainText(new Ladder(), bounds);
    }
    if (adaptive === undefined) {
      return;
    }
    if (prose !== undefined && prose !== ProseModels.english) {
      throw new TypeError(
        'p.string adaptive cannot take a prose model: its text model is the prior it learns from'
      );
    }
    if (bounds.prior !== undefined) {
      throw new TypeError(
        'p.string adaptive cannot weigh the length: an adaptive string ends with a symbol'
      );
    }
    const options = resolve(adaptive, loadedPriors.text, 'p.string');
    this._learned =
      charsetText === undefined
        ? new Learned(new Ladder(), this, options, 'text', bounds)
        : new Learned(charsetText, this, options, 'text', bounds, charsetText.codes());
  }

  /** This node with `bounds`, `charset` and `prose`, keeping its adaptive options. */
  private _with(
    bounds: LengthBounds,
    charset = this._alphabet?.charset,
    prose = this._prose
  ): PString {
    return new PString(bounds, charset, prose, this._adaptive);
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
   * length cannot encode. Not with `.adaptive()`.
   */
  cdf(fn: Cdf): PString {
    checkUnset(this._bounds.prior, 'p.string', 'prior');
    return this._with({ ...this._bounds, prior: fn });
  }

  /**
   * Declare how likely each length from min (or 0) to max is, lowest first.
   * Same prior as `.cdf()`, given as the histogram instead of its running
   * total. Not with `.adaptive()`.
   */
  weights(w: readonly number[]): PString {
    checkUnset(this._bounds.prior, 'p.string', 'prior');
    return this._with({ ...this._bounds, prior: w });
  }

  _adapted(options: AdaptiveOptions): PString {
    return this._adaptive !== undefined ? this : this.adaptive(options);
  }

  _marker(): number {
    return STRUCT.STR;
  }

  _markers(): ReadonlySet<number> {
    return STR_MARKERS;
  }

  /**
   * Code the strings through the similarity predictor: each code point is
   * predicted from what came before it in the message, the node's own past
   * strings and the prior, and the string ends with a symbol of its own
   * instead of a length. A string the node already wrote costs a few bits.
   * The bounds still hold. A charset closes the alphabet to its characters;
   * `.prose()` adds nothing, and a prose model of its own is refused. Set
   * once.
   */
  adaptive(options?: AdaptiveOptions): PString {
    if (this._adaptive !== undefined) {
      throw new TypeError('p.string adaptive is already set');
    }
    return new PString(
      this._bounds,
      this._alphabet?.charset,
      this._prose,
      checkAdaptive(options, 'p.string')
    );
  }

  charset(c: Charset): PString {
    checkUnset(this._alphabet?.charset, 'p.string', 'charset');
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
   * English by default; any other `ProseModel` swaps the matrix.
   */
  prose(model: ProseModel = ProseModels.english): PString {
    checkUnset(this._prose, 'p.string', 'prose');
    return this._with(this._bounds, this._alphabet?.charset, model);
  }

  _write(enc: Encoder, value: string): void {
    if (this._learned === undefined) {
      this._text.write(enc, value);
    } else {
      this._learned.write(enc, value);
    }
  }

  /**
   * A run of strings ascending by UTF-16 code units: each value after the
   * start it shares with the one before it, spelled as the node spells its
   * strings. Never asked of an adaptive node, whose runs `./runs` codes one
   * value at a time.
   */
  _run(unique: boolean): Run<string> {
    return this._text.run(unique ? 'unique' : 'sorted');
  }

  _read(dec: Decoder): string {
    return this._learned === undefined ? this._text.read(dec) : this._learned.read(dec);
  }
}
