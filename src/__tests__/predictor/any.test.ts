/**
 * The `p.any().compress()` stream: input the encoder never writes, forged through the stream
 * with the node's own coding.
 */

import { p, Decoder, Encoder, CorruptInputError, type PAny } from '../../index';
import { readAny, walkAny, type AnyCoding } from '../../predictor/any';
import { session } from '../../predictor/session';
import { STRUCT } from '../../predictor/types';

/** The coding a `p.any().compress()` node hands its stream. */
const codingOf = (node: PAny): AnyCoding => (node as unknown as { _coding: AnyCoding })._coding;

/** The message `walkAny` writes for `value` under `coding` with its symbols and bodies swapped. */
function forge(coding: AnyCoding, value: unknown, overrides: Partial<AnyCoding>): Uint8Array {
  const enc = new Encoder();
  walkAny(session(enc), enc, { ...coding, ...overrides }, value);
  return enc.output();
}

describe('p.any().compress() stream', () => {
  it.each(['1.0', '01', '1e3', '+1', '1.', '-'])(
    'rejects number text %j, which is no number spelled shortest',
    (text) => {
      const node = p.any().compress();
      const bytes = forge(codingOf(node), text, { symbol: () => STRUCT.NUM });
      expect(() => node.decode(bytes)).toThrow(
        new CorruptInputError(`p.any read ${JSON.stringify(text)} where a number belongs`)
      );
    }
  );

  it('refuses to write number text outside the symbols a number can hold', () => {
    const node = p.any().compress();
    expect(() => forge(codingOf(node), '0x10', { symbol: () => STRUCT.NUM })).toThrow(RangeError);
  });

  it('rejects a safe integer spelled as number text, which travels as INT', () => {
    const node = p.any().compress();
    const bytes = forge(codingOf(node), '5', { symbol: () => STRUCT.NUM });
    expect(() => node.decode(bytes)).toThrow(
      new CorruptInputError('p.any read "5" where a number belongs')
    );
  });

  it('reads the number text of -0, NaN and Infinity forged as text', () => {
    const node = p.any().compress();
    for (const text of ['-0', 'NaN', '-Infinity', '1e+21', '0.1']) {
      const bytes = forge(codingOf(node), text, { symbol: () => STRUCT.NUM });
      expect(node.decode(bytes)).toBe(Number(text));
    }
  });

  it('refuses a structure symbol no value starts with at every step a value starts', () => {
    const node = p.any().compress();
    const coding = codingOf(node);
    for (const value of [0, [0], { a: 0 }, new Map([[0, 0]]), new Set([0])]) {
      expect(() =>
        forge(coding, value, {
          symbol: (enc, v) => (typeof v === 'number' ? STRUCT.KEY : coding.symbol(enc, v)),
          bodies: new Map([[STRUCT.KEY, { write: () => undefined, read: () => undefined }]]),
        })
      ).toThrow(`symbol ${STRUCT.KEY} is not in the structure alphabet`);
    }
  });

  it('rejects a structure symbol no value starts with, handed on by a parent step', () => {
    const coding = codingOf(p.any().compress());
    const dec = new Decoder(new Uint8Array(0));
    const s = session(dec);
    s.give(STRUCT.KEY, coding.node);
    expect(() => readAny(s, dec, coding)).toThrow(
      new CorruptInputError(`p.any read structure symbol ${STRUCT.KEY} where a value belongs`)
    );
  });

  it('locates a decode error at an object key, an array index and a map entry', () => {
    const node = p.any().compress();
    const coding = codingOf(node);
    const text = (value: unknown) => typeof value === 'string';
    const forged = (value: unknown) =>
      forge(coding, value, {
        symbol: (enc, v) => (text(v) ? STRUCT.NUM : coding.symbol(enc, v)),
      });
    expect(() => node.decode(forged({ a: [1, '1.0'] }))).toThrow(
      'a[1]: p.any read "1.0" where a number belongs'
    );
    expect(() =>
      node.decode(
        forged(
          new Map<unknown, unknown>([
            [1, 2],
            [3, '1.0'],
          ])
        )
      )
    ).toThrow('[1]: p.any read "1.0" where a number belongs');
  });
});

describe('p.any().compress() without Float16Array', () => {
  it('reads a Float16Array tag as missing', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'Float16Array');
    delete (globalThis as { Float16Array?: unknown }).Float16Array;
    try {
      jest.isolateModules(() => {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const index = require('../../index') as typeof import('../../index');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const node = index.p.any().compress();
        const tag = STRUCT.TYPED_0 + 11;
        const bytes = forge(codingOf(node), 0, {
          symbol: () => tag,
          bodies: new Map([[tag, { write: () => undefined, read: () => undefined }]]),
        });
        expect(() => node.decode(bytes)).toThrow(
          new TypeError('p.any read a Float16Array, which this environment lacks')
        );
      });
    } finally {
      if (saved !== undefined) Object.defineProperty(globalThis, 'Float16Array', saved);
    }
  });
});
