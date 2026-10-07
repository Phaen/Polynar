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
import { writeIndex, readIndex } from './lattice';
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

interface StringBounds {
  min?: number;
  max?: number;
  length?: number;
}

export class PString extends PNode<string> {
  readonly _kinds: readonly Kind[] = ['string'];

  private readonly _min?: number;
  private readonly _max?: number;
  private readonly _length?: number;
  /** Explicit charset; undefined selects the laddered code-point default. */
  private readonly _charset?: Charset;
  /** Symbol count of a range charset; undefined for string charsets. */
  private readonly _size?: number;
  /** Prose model replacing the flat ladder, as given and compiled. */
  private readonly _prose?: ProseModel;
  private readonly _table?: ProseTable;

  constructor(bounds: StringBounds = {}, charset?: Charset, prose?: ProseModel) {
    super();
    // A fixed length IS both bounds; combining the two spellings is a
    // contradiction, so it throws instead of silently merging.
    if (bounds.length != null && (bounds.min != null || bounds.max != null)) {
      throw new TypeError('p.string length cannot be combined with min or max');
    }
    if (bounds.length != null) {
      // No inward rounding here: no length satisfies a fractional one, so
      // either rounding direction would invent a contract never declared.
      if (!Number.isInteger(bounds.length) || bounds.length < 0) {
        throw new RangeError('p.string length must be a non-negative integer');
      }
      this._length = bounds.length;
    }
    // Round each bound INWARD (ceil the min, floor the max) so a fractional
    // bound never admits a length beyond itself.
    this._min = bounds.min == null ? undefined : Math.ceil(bounds.min);
    if (this._min !== undefined && (!Number.isInteger(this._min) || this._min < 0)) {
      throw new RangeError('p.string min must be a non-negative length');
    }
    this._max = bounds.max == null ? undefined : Math.floor(bounds.max);
    if (this._max !== undefined && (!Number.isInteger(this._max) || this._max < 0)) {
      throw new RangeError('p.string max must be a non-negative length');
    }
    if (this._min !== undefined && this._max !== undefined && this._min > this._max) {
      throw new RangeError('p.string range is empty: min exceeds max');
    }
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
    return new PString({ ...this._bounds(), min: n }, this._charset, this._prose);
  }

  max(n: number): PString {
    return new PString({ ...this._bounds(), max: n }, this._charset, this._prose);
  }

  /** Fix the exact length. The prefix then costs zero bits on the wire. */
  length(n: number): PString {
    return new PString({ ...this._bounds(), length: n }, this._charset, this._prose);
  }

  charset(c: Charset): PString {
    return new PString(this._bounds(), c, this._prose);
  }

  /**
   * Weight the default encoding for natural-language text: an order-1 model
   * prices each character given its predecessor, so common English costs
   * ~3-4 bits per character instead of the flat 7. Still encodes any string
   * — code points outside the model pay an escape on top of their laddered
   * cost. English by default; any other `ProseModel` swaps the matrix.
   */
  prose(model: ProseModel = ProseModels.english): PString {
    return new PString(this._bounds(), this._charset, model);
  }

  _write(enc: Encoder, value: string): void {
    // The length prefix counts UTF-16 code units (`.length`), not code
    // points, so `.max()` keeps plain JS string semantics.
    if (this._length !== undefined && value.length !== this._length) {
      throw new RangeError(`String '${value}' differs from the fixed length`);
    }
    if (this._min !== undefined && value.length < this._min) {
      throw new RangeError(`String '${value}' is below min length`);
    }
    if (this._max !== undefined && value.length > this._max) {
      throw new RangeError(`String '${value}' exceeds max length`);
    }
    writeIndex(enc, value.length, this._lengthMin(), this._lengthMax());

    if (this._charset === undefined) {
      // Code-point iteration merges every adjacent lead+trail pair, so the
      // split spelling the decoder rejects as non-canonical is unreachable
      // here; lone surrogates fall through as their own code points.
      const table = this._table;
      let ctx = table?.start ?? 0;
      for (let i = 0; i < value.length; ) {
        const code = value.codePointAt(i)!;
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
          throw new Error('String not compliant with character set');
        }
        enc.compose(pos, this._charset.length);
      } else {
        const code = value.charCodeAt(i);
        if (code < this._charset[0] || code > this._charset[1]) {
          throw new Error('String not compliant with character set');
        }
        enc.compose(code - this._charset[0], this._size!);
      }
    }
  }

  _read(dec: Decoder): string {
    const length = readIndex(dec, this._lengthMin(), this._lengthMax());
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
        // only appears in tampered input.
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

  private _bounds(): StringBounds {
    return { min: this._min, max: this._max, length: this._length };
  }

  /** A length is never negative, so the lattice floor defaults to 0. */
  private _lengthMin(): number {
    return this._length ?? this._min ?? 0;
  }

  private _lengthMax(): number | undefined {
    return this._length ?? this._max;
  }
}
