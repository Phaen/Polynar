/**
 * Text. The default encoding spends one laddered slot per code point — about
 * 7 bits for ASCII, 18 to 27 for everything else — and round-trips any JS
 * string bit-exact, lone surrogates included. `.prose()` swaps the ladder
 * for the order-1 frequency model; an explicit charset trades generality for
 * density over a known alphabet. `p.string`.
 */
import { Encoder, Decoder, Alphabet } from '../packer';
import type { Charset } from '../packer';
import { PNode } from './base';
import { describe } from './path';
import { checkUnset } from './lattice';
import type { Cdf } from './weights';
import type { SequenceAdaptiveOptions } from './adaptive';
import type { Kind } from './guards';
import {
  TEXT_FIRST_RADIX,
  codePointSymbol,
  codePointTailRadix,
  composeCodePoint,
  composeCodePointTail,
  parseCodePoint,
  parseCodePointTail,
} from './codepoint';
import { ProseModels, compileProse, proseContext, type ProseModel, type ProseTable } from './prose';
import { withMethod } from './methods';
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
    for (const code of codes) {
      value += String.fromCodePoint(code);
    }
    return value;
  }
}

/** The laddered default: the first slot is the symbol, the band offset its tail. */
class Ladder extends CodePoints implements Symbols<string> {
  readonly pool = 'ladder';
  readonly size = TEXT_FIRST_RADIX;
  readonly order = 0;

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
 * symbol on the ladder.
 */
class Prose extends CodePoints implements Symbols<string> {
  /** The rows are keyed by the previous symbol. */
  readonly order = 1;
  /** The model: the same model compiles to the same table. */
  readonly pool: ProseModel;
  readonly size: number;
  readonly rows: readonly (readonly number[])[];
  override readonly start: number;

  constructor(
    model: ProseModel,
    private readonly table: ProseTable
  ) {
    super();
    this.pool = model;
    this.size = table.escape + 1;
    this.rows = model.weights;
    this.start = table.start;
  }

  symbol(code: number): number {
    return this.table.index.get(code) ?? this.table.escape;
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
    return symbol === this.table.escape ? parseCodePoint(dec) : this.table.codes[symbol];
  }

  row(code: number): number {
    return proseContext(this.table, code);
  }
}

/** An explicit charset: each character is its digit in the alphabet. */
class CharsetText extends Text implements Symbols<string> {
  readonly item = 'character';
  readonly tailless = true;
  readonly order = 0;
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

export class PString extends PNode<string> {
  readonly _kinds: readonly Kind[] = ['string'];

  private readonly _bounds: SequenceBounds;
  /** Explicit charset; undefined selects the laddered code-point default. */
  private readonly _alphabet?: Alphabet;
  /** Prose model replacing the flat ladder, as given. */
  private readonly _prose?: ProseModel;
  /** The declared methods. */
  private readonly _spelling: SequenceSpelling;
  /** The length and the characters, in the ladder, the prose model or the charset. */
  private readonly _sequence: Sequence<string>;

  constructor(
    bounds: SequenceBounds = {},
    charset?: Charset,
    prose?: ProseModel,
    spelling: SequenceSpelling = {}
  ) {
    super();
    this._bounds = bounds;
    this._spelling = spelling;
    let symbols: Symbols<string> = new Ladder();
    if (prose !== undefined) {
      this._prose = prose;
      symbols = new Prose(prose, compileProse(prose));
    }
    if (charset !== undefined) {
      if (prose !== undefined) {
        throw new TypeError('p.string cannot combine prose with a charset');
      }
      // The alphabet keeps its own copy of a range, so later caller mutation
      // of the array can't change the node. One character is a legal
      // alphabet: each character then costs nothing.
      this._alphabet = new Alphabet(charset, 1);
      symbols = new CharsetText(this._alphabet);
    }
    this._sequence = new Sequence(symbols, bounds, spelling);
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
   * spelled again; and the length learns when there is a max. The
   * characters learn together with those of every other adaptive string
   * of the message with the same charset, prose model or ladder and the same
   * window, unless `separate`. The declared
   * weights, or even ones when none are, are where the priors start (the
   * prose model's rows for `.prose()`). `window` is how many observations a
   * prior's counts hold before they halve, so the newest weigh most (1024
   * when left out, and raised to the number of values they count when
   * smaller). From its second value on, each prior spends one bit to stay
   * static, or a few to name the learning rate that paid off. The length
   * takes weights, not a cdf; part of the wire format, like the weights.
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
   * ~3-4 bits per character instead of the flat 7. Still encodes any string
   * — code points outside the model pay an escape on top of their laddered
   * cost. English by default; any other `ProseModel` swaps the matrix.
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
    this._sequence.write(enc, value);
  }

  _read(dec: Decoder): string {
    return this._sequence.read(dec);
  }
}
