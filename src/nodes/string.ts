/**
 * Text. The default encoding spends one laddered slot per code point — about
 * 7 bits for ASCII, 18 to 27 for everything else — and round-trips any JS
 * string bit-exact, lone surrogates included. `.prose()` swaps the ladder
 * for the order-1 frequency model; an explicit charset trades generality for
 * density over a known alphabet. `p.string`.
 */
import { Encoder, Decoder, CorruptInputError } from '../packer';
import type { Charset } from '../packer';
import { validateCharset } from '../packer/utils';
import { PNode } from './base';
import { LengthPrefix, type LengthBounds } from './lattice';
import type { Kind } from './guards';
import { composeCodePoint, parseCodePoint } from './codepoint';
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

  private readonly _length: LengthPrefix;
  /** Explicit charset; undefined selects the laddered code-point default. */
  private readonly _charset?: Charset;
  /** Symbol count of a range charset; undefined for string charsets. */
  private readonly _size?: number;
  /** Prose model replacing the flat ladder, as given and compiled. */
  private readonly _prose?: ProseModel;
  private readonly _table?: ProseTable;

  constructor(bounds: LengthBounds = {}, charset?: Charset, prose?: ProseModel) {
    super();
    this._length = new LengthPrefix(bounds, 'p.string');
    if (prose !== undefined) {
      this._prose = prose;
      this._table = compileProse(prose);
    }
    if (charset !== undefined) {
      if (prose !== undefined) {
        throw new TypeError('p.string cannot combine prose with a charset');
      }
      // validateCharset returns a normalized copy, so later caller mutation of
      // a range array can't change the node.
      this._charset = validateCharset(charset);
      if (typeof this._charset !== 'string') {
        this._size = this._charset[1] - this._charset[0] + 1;
      }
    }
  }

  /** A floor on the length; the prefix then counts up from it. */
  min(n: number): PString {
    return new PString({ ...this._length.bounds, min: n }, this._charset, this._prose);
  }

  max(n: number): PString {
    return new PString({ ...this._length.bounds, max: n }, this._charset, this._prose);
  }

  /** Fix the exact length. The prefix then costs zero bits on the wire. */
  length(n: number): PString {
    return new PString({ ...this._length.bounds, length: n }, this._charset, this._prose);
  }

  charset(c: Charset): PString {
    return new PString(this._length.bounds, c, this._prose);
  }

  /**
   * Weight the default encoding for natural-language text: an order-1 model
   * prices each character given its predecessor, so common English costs
   * ~3-4 bits per character instead of the flat 7. Still encodes any string
   * — code points outside the model pay an escape on top of their laddered
   * cost. English by default; any other `ProseModel` swaps the matrix.
   */
  prose(model: ProseModel = ProseModels.english): PString {
    return new PString(this._length.bounds, this._charset, model);
  }

  _write(enc: Encoder, value: string): void {
    // The length prefix counts UTF-16 code units (`.length`), not code
    // points, so `.max()` keeps plain JS string semantics.
    this._length.write(enc, value.length, 'String');

    if (this._charset === undefined) {
      // Every adjacent lead+trail pair merges into one code point, so the
      // split spelling the decoder rejects as non-canonical is unreachable
      // here; lone surrogates fall through as their own code points. The
      // pairing reads code units: V8's optimized `codePointAt` merges a
      // sliced string's final lead with the trail beyond the slice.
      const table = this._table;
      let ctx = table?.start ?? 0;
      for (let i = 0; i < value.length; ) {
        const unit = value.charCodeAt(i);
        const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
        const code =
          unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
            ? (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000
            : unit;
        if (table !== undefined) {
          composeProsePoint(enc, table, code, ctx);
          ctx = proseContext(table, code);
        } else {
          composeCodePoint(enc, code);
        }
        i += code > 0xffff ? 2 : 1;
      }
      return;
    }

    for (let i = 0; i < value.length; i++) {
      if (typeof this._charset === 'string') {
        const pos = this._charset.indexOf(value.charAt(i));
        if (pos === -1) {
          throw new RangeError(
            `Character '${value.charAt(i)}' at ${i} is not in the character set`
          );
        }
        enc.compose(pos, this._charset.length);
      } else {
        const code = value.charCodeAt(i);
        if (code < this._charset[0] || code > this._charset[1]) {
          throw new RangeError(
            `Character '${value.charAt(i)}' (code ${code}) at ${i} is outside the range ${this._charset[0]}–${this._charset[1]}`
          );
        }
        enc.compose(code - this._charset[0], this._size!);
      }
    }
  }

  _read(dec: Decoder): string {
    const length = this._length.read(dec);
    let value = '';

    if (this._charset === undefined) {
      let units = 0;
      let lead = false;
      const table = this._table;
      let ctx = table?.start ?? 0;
      while (units < length) {
        const code = table !== undefined ? parseProsePoint(dec, table, ctx) : parseCodePoint(dec);
        if (table !== undefined) {
          ctx = proseContext(table, code);
        }
        // A trail directly after a lone lead spells a surrogate pair as two
        // code points; the encoder always merges the pair, so the split form
        // only appears in corrupt input.
        if (lead && code >= 0xdc00 && code <= 0xdfff) {
          throw new CorruptInputError('Non-canonical split surrogate pair');
        }
        lead = code >= 0xd800 && code <= 0xdbff;
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

    for (let i = 0; i < length; i++) {
      if (typeof this._charset === 'string') {
        value += this._charset.charAt(dec.parse(this._charset.length));
      } else {
        value += String.fromCharCode(dec.parse(this._size!) + this._charset[0]);
      }
    }
    return value;
  }
}
