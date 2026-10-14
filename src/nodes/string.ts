/**
 * Text. The default encoding spends one laddered slot per code point — about
 * 7 bits for ASCII, 18 to 27 for everything else — and round-trips any JS
 * string bit-exact, lone surrogates included. `.prose()` swaps the ladder
 * for the order-1 frequency model; an explicit charset trades generality for
 * density over a known alphabet. `p.string`.
 */
import { Encoder, Decoder, CorruptInputError, Alphabet } from '../packer';
import type { Charset } from '../packer';
import { PNode } from './base';
import { describe } from './path';
import { IndexRange, checkUnset, lengthRange, type LengthBounds } from './lattice';
import type { Cdf } from './weights';
import { AdaptivePrior, checkAdaptation, type AdaptiveOptions } from './adaptive';
import type { Kind } from './guards';
import { TEXT_FIRST_RADIX, composeCodePoint, parseCodePoint } from './codepoint';
import {
  ProseModels,
  compileProse,
  composeProsePoint,
  parseProsePoint,
  proseContext,
  type ProseModel,
  type ProseTable,
} from './prose';

export class PString extends PNode<string> {
  readonly _kinds: readonly Kind[] = ['string'];

  private readonly _bounds: LengthBounds;
  private readonly _length: IndexRange;
  /** Explicit charset; undefined selects the laddered code-point default. */
  private readonly _alphabet?: Alphabet;
  /** Prose model replacing the flat ladder, as given and compiled. */
  private readonly _prose?: ProseModel;
  private readonly _table?: ProseTable;
  /**
   * Set under `.adaptive()`: the prior the characters learn, over the prose
   * model's symbols in a row per context, the charset's characters, or the
   * ladder's first slot.
   */
  private readonly _chars?: AdaptivePrior;

  constructor(bounds: LengthBounds = {}, charset?: Charset, prose?: ProseModel) {
    super();
    this._bounds = bounds;
    // Without a max the length has no range to learn over; the characters
    // learn alone.
    const { adaptive, ...fixed } = bounds;
    this._length = lengthRange(bounds.max === undefined ? fixed : bounds, 'p.string', 'length');
    if (prose !== undefined) {
      this._prose = prose;
      this._table = compileProse(prose);
    }
    if (charset !== undefined) {
      if (prose !== undefined) {
        throw new TypeError('p.string cannot combine prose with a charset');
      }
      // The alphabet keeps its own copy of a range, so later caller mutation
      // of the array can't change the node. One character is a legal
      // alphabet: each character then costs nothing.
      this._alphabet = new Alphabet(charset, 1);
    }
    if (adaptive !== undefined) {
      const { window } = checkAdaptation(adaptive, 'p.string');
      if (prose !== undefined) {
        const { escape } = compileProse(prose);
        this._chars = new AdaptivePrior(prose.weights, escape + 1, window, 'p.string');
      } else {
        const size = this._alphabet?.size ?? TEXT_FIRST_RADIX;
        this._chars = new AdaptivePrior(
          [new Array<number>(size).fill(1)],
          size,
          window,
          'p.string'
        );
      }
    }
  }

  /** A floor on the length; the prefix then counts up from it. */
  min(n: number): PString {
    checkUnset(this._bounds.min, 'p.string', 'min');
    return new PString({ ...this._bounds, min: n }, this._alphabet?.charset, this._prose);
  }

  max(n: number): PString {
    checkUnset(this._bounds.max, 'p.string', 'max');
    return new PString({ ...this._bounds, max: n }, this._alphabet?.charset, this._prose);
  }

  /**
   * Fix the exact length, the same as `.min(n).max(n)`. The prefix then costs
   * zero bits on the wire.
   */
  length(n: number): PString {
    checkUnset(this._bounds.min, 'p.string', 'min');
    checkUnset(this._bounds.max, 'p.string', 'max');
    return new PString({ ...this._bounds, min: n, max: n }, this._alphabet?.charset, this._prose);
  }

  /**
   * Declare a prior over the LENGTH as an integer CDF: `fn(n)` is the
   * cumulative weight of lengths below `n`. Requires a max; a zero-weight
   * length cannot encode.
   */
  cdf(fn: Cdf): PString {
    return new PString({ ...this._bounds, prior: fn }, this._alphabet?.charset, this._prose);
  }

  /**
   * Declare how likely each length from min (or 0) to max is, lowest first.
   * Same prior as `.cdf()`, given as the histogram instead of its running
   * total.
   */
  weights(w: readonly number[]): PString {
    return new PString({ ...this._bounds, prior: w }, this._alphabet?.charset, this._prose);
  }

  /**
   * Let every prior the node has learn from the message: the length's when it
   * has a max, and the characters' always. The declared weights, or even ones
   * when none are, are the starting point (the prose model's rows for
   * `.prose()`), and each length or character coded counts as one observation,
   * so one that keeps recurring gets cheaper as the message goes on. `window`
   * is how many observations the counts hold before they halve, so the newest
   * weigh most (1024 when left out, and raised to the number of values they
   * count when smaller). From its second value on, each prior spends one bit to
   * stay static, or a few to name the learning rate that paid off. The length
   * takes weights, not a cdf; part of the wire format, like the weights.
   */
  adaptive(options?: AdaptiveOptions): PString {
    return new PString(
      { ...this._bounds, adaptive: options ?? {} },
      this._alphabet?.charset,
      this._prose
    );
  }

  charset(c: Charset): PString {
    return new PString(this._bounds, c, this._prose);
  }

  /**
   * Weight the default encoding for natural-language text: an order-1 model
   * prices each character given its predecessor, so common English costs
   * ~3-4 bits per character instead of the flat 7. Still encodes any string
   * — code points outside the model pay an escape on top of their laddered
   * cost. English by default; any other `ProseModel` swaps the matrix.
   */
  prose(model: ProseModel = ProseModels.english): PString {
    return new PString(this._bounds, this._alphabet?.charset, model);
  }

  _write(enc: Encoder, value: string): void {
    // The length prefix counts UTF-16 code units (`.length`), not code
    // points, so `.max()` keeps plain JS string semantics.
    this._length.write(enc, value.length, () => `String length ${value.length}`);

    const alphabet = this._alphabet;
    if (alphabet === undefined) {
      // Every adjacent lead+trail pair merges into one code point; lone
      // surrogates fall through as their own code points. The
      // pairing reads code units: V8's optimized `codePointAt` merges a
      // sliced string's final lead with the trail beyond the slice.
      const table = this._table;
      const chars = this._chars;
      const writeFirst =
        chars === undefined ? undefined : (symbol: number) => chars.write(enc, symbol);
      let ctx = table?.start ?? 0;
      for (let i = 0; i < value.length; ) {
        const unit = value.charCodeAt(i);
        const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
        const code =
          unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
            ? (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000
            : unit;
        if (table === undefined) {
          composeCodePoint(enc, code, writeFirst);
        } else if (chars === undefined) {
          composeProsePoint(enc, table, code, ctx);
        } else {
          const sym = table.index.get(code) ?? table.escape;
          chars.write(enc, sym, ctx);
          if (sym === table.escape) {
            composeCodePoint(enc, code);
          }
        }
        if (table !== undefined) {
          ctx = proseContext(table, code);
        }
        i += code > 0xffff ? 2 : 1;
      }
      return;
    }

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
      if (this._chars === undefined) {
        enc.compose(digit, alphabet.size);
      } else {
        this._chars.write(enc, digit);
      }
    }
  }

  _read(dec: Decoder): string {
    const length = this._length.read(dec);
    let value = '';

    const alphabet = this._alphabet;
    if (alphabet === undefined) {
      let units = 0;
      const table = this._table;
      const chars = this._chars;
      const readFirst = chars === undefined ? undefined : () => chars.read(dec);
      let ctx = table?.start ?? 0;
      while (units < length) {
        let code: number;
        if (table === undefined) {
          code = parseCodePoint(dec, readFirst);
        } else if (chars === undefined) {
          code = parseProsePoint(dec, table, ctx);
        } else {
          const sym = chars.read(dec, ctx);
          code = sym === table.escape ? parseCodePoint(dec) : table.codes[sym];
        }
        if (table !== undefined) {
          ctx = proseContext(table, code);
        }
        value += String.fromCodePoint(code);
        units += code > 0xffff ? 2 : 1;
      }
      // An astral code point in the final slot can overshoot the unit count;
      // no string encodes that way.
      if (units > length) {
        throw new CorruptInputError('Code points overrun the length prefix');
      }
      return value;
    }

    const chars = this._chars;
    if (chars !== undefined) {
      for (let i = 0; i < length; i++) {
        value += alphabet.charAt(chars.read(dec));
      }
      return value;
    }
    for (const digit of dec.parseMany(alphabet.size, length)) {
      value += alphabet.charAt(digit);
    }
    return value;
  }
}
