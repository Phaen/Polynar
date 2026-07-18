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
import { composeCodePoint, parseCodePoint } from './codepoint';
import { composeProsePoint, parseProsePoint, proseContext } from './prose';

/** The context of the imaginary character before the first: a space. */
const PROSE_START = 32;

export class PString extends PNode<string> {
  private readonly _max?: number;
  /** Explicit charset; undefined selects the laddered code-point default. */
  private readonly _charset?: Charset;
  /** Symbol count of a range charset; undefined for string charsets. */
  private readonly _size?: number;
  /** Prose-weighted slots instead of the flat ladder. */
  private readonly _prose: boolean;

  constructor(max?: number, charset?: Charset, prose = false) {
    super();
    // Round the cap INWARD (floor) so a fractional cap never admits a longer
    // string than declared.
    this._max = max == null ? undefined : Math.floor(max);
    if (this._max !== undefined && (!Number.isInteger(this._max) || this._max < 0)) {
      throw new RangeError('p.string max must be a non-negative length');
    }
    this._prose = prose;
    if (charset !== undefined) {
      if (prose) {
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

  max(n: number): PString {
    return new PString(n, this._charset, this._prose);
  }

  charset(c: Charset): PString {
    if (this._prose) {
      throw new TypeError('p.string cannot combine prose with a charset');
    }
    return new PString(this._max, c);
  }

  /**
   * Weight the default encoding for natural-language text: an order-1 model
   * prices each character given its predecessor, so common English costs
   * ~3-4 bits per character instead of the flat 7. Still encodes any string
   * — code points outside the model pay an escape on top of their laddered
   * cost.
   */
  prose(): PString {
    if (this._charset !== undefined) {
      throw new TypeError('p.string cannot combine prose with a charset');
    }
    return new PString(this._max, undefined, true);
  }

  _write(enc: Encoder, value: string): void {
    if (typeof value !== 'string') {
      throw new TypeError(`p.string expected a string, got ${String(value)}`);
    }

    // The length prefix counts UTF-16 code units (`.length`), not code
    // points, so `.max()` keeps plain JS string semantics.
    if (this._max === undefined) {
      enc.composeTerm(value.length);
    } else if (value.length > this._max) {
      throw new RangeError(`String '${value}' exceeds max length`);
    } else {
      enc.compose(value.length, this._max + 1);
    }

    if (this._charset === undefined) {
      // Code-point iteration merges every adjacent lead+trail pair, so the
      // split spelling the decoder rejects as non-canonical is unreachable
      // here; lone surrogates fall through as their own code points.
      let ctx = proseContext(PROSE_START);
      for (let i = 0; i < value.length; ) {
        const code = value.codePointAt(i)!;
        if (this._prose) {
          composeProsePoint(enc, code, ctx);
          ctx = proseContext(code);
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
    const length = this._max === undefined ? dec.parseTerm() : dec.parse(this._max + 1);
    let value = '';

    if (this._charset === undefined) {
      let units = 0;
      let lead = false;
      let ctx = proseContext(PROSE_START);
      while (units < length) {
        const code = this._prose ? parseProsePoint(dec, ctx) : parseCodePoint(dec);
        if (this._prose) {
          ctx = proseContext(code);
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
}
