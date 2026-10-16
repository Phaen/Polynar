/**
 * Digit fields and positions over a toy alphabet, read from hand-built
 * input that no encoder writes.
 */

import { Encoder, Decoder, CorruptInputError } from '../../index';
import { DigitFields, Positional, type FieldHost } from '../../nodes/fields';
import type { Symbols } from '../../nodes/sequence';

/**
 * Ten digits (items 0 to 9), then `a` (10), a zero-unit `^` (11) and a
 * two-unit `W` (12), each its own symbol.
 */
const toy: Symbols<number[]> = {
  who: 'toy',
  pool: 'toy',
  size: 13,
  start: 0,
  noun: 'length',
  item: 'toy item',
  tailless: true,
  count: (value) => value.length,
  span: (count) => count,
  items: (value) => value,
  units: (item) => (item === 11 ? 0 : item === 12 ? 2 : 1),
  symbol: (item) => item,
  tail: () => {},
  tails: () => 1,
  untail: (_dec, symbol) => symbol,
  row: () => 0,
  build: (items) => items,
  subject: (value) => `Toy length ${value.length}`,
  digit: (item) => (item < 10 ? item : -1),
  digitItem: (digit) => digit,
};

/** A host of `span`, after `prev`, whose plain spelling reads `body` and writes nothing. */
const host = (span: number, prev?: number[], body: number[] = []): FieldHost => ({
  symbols: toy as Symbols<unknown>,
  span: () => span,
  prev: () => prev,
  writeBody: () => {},
  readBody: () => body,
});

/** A decoder over the digits `write` composes. */
const input = (write: (enc: Encoder) => void): Decoder => {
  const enc = new Encoder();
  write(enc);
  return new Decoder(enc.output());
};

describe('DigitFields', () => {
  it('learns nothing at fixed odds', () => {
    // 'a12' after 'a7': the frame flagged, then the field uniform.
    const fields = new DigitFields(host(3, [10, 7]), false, false);
    const spell = (learn: boolean): Uint8Array => {
      const enc = new Encoder();
      if (learn) {
        fields.learn(enc, [10, 3, 4]);
      }
      fields.write(enc, [10, 1, 2]);
      return enc.output();
    };
    expect(spell(true)).toEqual(spell(false));
  });

  it('refuses a frame flagged as the previous one that leaves its fields too few digits', () => {
    // 'a1a' before, its frame two units: a span of 2 leaves the field none.
    const fields = new DigitFields(host(2, [10, 1, 10]), false, false);
    const dec = input((enc) => enc.compose(1, 2));
    expect(() => fields.read(dec)).toThrow(
      new CorruptInputError('Digit fields do not fit the frame')
    );
  });

  it('refuses a frame flagged as the previous one that leaves its fields too many digits', () => {
    const fields = new DigitFields(host(40, [10, 1, 10]), false, false);
    const dec = input((enc) => enc.compose(1, 2));
    expect(() => fields.read(dec)).toThrow(
      new CorruptInputError('Digit fields do not fit the frame')
    );
  });

  it('refuses a spelled frame with another number of fields than declared', () => {
    // One field of one digit in a span of 2, the frame spelled without its placeholder.
    const fields = new DigitFields(host(2, undefined, [10, 10]), false, false);
    const dec = input((enc) => {
      enc.compose(1, 3);
      enc.compose(0, 2);
    });
    expect(() => fields.read(dec)).toThrow(
      new CorruptInputError('A frame holds the wrong number of fields')
    );
  });
});

describe('Positional', () => {
  /** Positions of span 1 that met `a`, on a decoder over what `write` composes. */
  const after = (write: (enc: Encoder) => void): [Positional, Decoder] => {
    const positions = new Positional(host(1), false, 1);
    const dec = input(write);
    positions.see(dec, [10]);
    return [positions, dec];
  };

  it('refuses more items than twice the span', () => {
    // A new item at the first place, past `a`, then at two places no
    // string reached: each the zero-unit item, which fills nothing.
    const [positions, dec] = after((enc) => {
      enc.compose(0, 2);
      enc.compose(10, 12);
      enc.compose(11, 13);
      enc.compose(11, 13);
    });
    expect(() => positions.read(dec)).toThrow(
      new CorruptInputError('More items than twice the length 1')
    );
  });

  it('reads every place as new at a length it never met', () => {
    // Corrupt input alone reaches this: a length positions never met.
    const positions = new Positional(host(2), false, 1);
    const dec = input((enc) => {
      enc.compose(10, 13);
      enc.compose(3, 13);
    });
    expect(positions.read(dec)).toEqual([10, 3]);
  });

  it('meets a length once it saw values of it often enough', () => {
    const positions = new Positional(host(1), false, 2);
    const enc = new Encoder();
    expect(positions.met(enc)).toBe(false);
    positions.see(enc, [10]);
    expect(positions.met(enc)).toBe(false);
    positions.see(enc, [11]);
    expect(positions.met(enc)).toBe(true);
  });

  it('refuses an item that overruns the span', () => {
    const [positions, dec] = after((enc) => {
      enc.compose(0, 2);
      enc.compose(11, 12);
    });
    expect(() => positions.read(dec)).toThrow(new CorruptInputError('Items overrun the length 1'));
  });
});
