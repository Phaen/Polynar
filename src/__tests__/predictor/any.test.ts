/**
 * The `p.any().adaptive()` stream: input the encoder never writes, forged through the stream
 * with the node's own coding.
 */

import { p, Encoder, CorruptInputError, type PAny } from '../../index';
import { walkAny, type AnyCoding } from '../../predictor/any';
import { session } from '../../predictor/session';
import { STRUCT } from '../../predictor/types';

/** The coding a `p.any().adaptive()` node hands its stream. */
const codingOf = (node: PAny): AnyCoding => (node as unknown as { _coding: AnyCoding })._coding;

/** The message `walkAny` writes for `value` under `coding` with its symbols and bodies swapped. */
function forge(coding: AnyCoding, value: unknown, overrides: Partial<AnyCoding>): Uint8Array {
  const enc = new Encoder();
  walkAny(session(enc), enc, { ...coding, ...overrides }, value);
  return enc.output();
}

describe('p.any().adaptive() stream', () => {
  it.each(['1.0', '0x10', '1e3', '+1', ' 1'])(
    'rejects number text %j, which is no number spelled shortest',
    (text) => {
      const node = p.any().adaptive();
      const bytes = forge(codingOf(node), text, { symbol: () => STRUCT.NUM });
      expect(() => node.decode(bytes)).toThrow(
        new CorruptInputError(`p.any read ${JSON.stringify(text)} where a number belongs`)
      );
    }
  );

  it('rejects a safe integer spelled as number text, which travels as INT', () => {
    const node = p.any().adaptive();
    const bytes = forge(codingOf(node), '5', { symbol: () => STRUCT.NUM });
    expect(() => node.decode(bytes)).toThrow(
      new CorruptInputError('p.any read "5" where a number belongs')
    );
  });

  it('reads the number text of -0, NaN and Infinity forged as text', () => {
    const node = p.any().adaptive();
    for (const text of ['-0', 'NaN', '-Infinity', '1e+21', '0.1']) {
      const bytes = forge(codingOf(node), text, { symbol: () => STRUCT.NUM });
      expect(node.decode(bytes)).toBe(Number(text));
    }
  });

  it('rejects a structure symbol no value starts with', () => {
    const node = p.any().adaptive();
    const coding = codingOf(node);
    const bytes = forge(coding, 0, {
      symbol: () => STRUCT.KEY,
      bodies: new Map([[STRUCT.KEY, { write: () => undefined, read: () => undefined }]]),
    });
    expect(() => node.decode(bytes)).toThrow(
      new CorruptInputError(`p.any read structure symbol ${STRUCT.KEY} where a value belongs`)
    );
  });

  it('rejects a structure symbol other than a key or the end inside an object', () => {
    const node = p.any().adaptive();
    const { o } = codingOf(node);
    const enc = new Encoder();
    const s = session(enc);
    s.marker('', o).write(enc, STRUCT.OBJ_START);
    s.enterScope('', o);
    s.enterRecord();
    s.marker('', o).write(enc, STRUCT.TRUE, undefined, { end: STRUCT.OBJ_END, allow: true });
    s.leaveRecord();
    s.leaveScope();
    expect(() => node.decode(enc.output())).toThrow(
      new CorruptInputError(`p.any read structure symbol ${STRUCT.TRUE} where a key belongs`)
    );
  });

  it('locates a decode error at an object key, an array index and a map entry', () => {
    const node = p.any().adaptive();
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

describe('p.any().adaptive() without Float16Array', () => {
  it('reads a Float16Array tag as missing', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'Float16Array');
    delete (globalThis as { Float16Array?: unknown }).Float16Array;
    try {
      jest.isolateModules(() => {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const index = require('../../index') as typeof import('../../index');
        const sessions =
          require('../../predictor/session') as typeof import('../../predictor/session');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const node = index.p.any().adaptive();
        const { o } = codingOf(node);
        const enc = new index.Encoder();
        sessions
          .session(enc)
          .marker('', o)
          .write(enc, STRUCT.TYPED_0 + 11);
        expect(() => node.decode(enc.output())).toThrow(
          new TypeError('p.any read a Float16Array, which this environment lacks')
        );
      });
    } finally {
      if (saved !== undefined) Object.defineProperty(globalThis, 'Float16Array', saved);
    }
  });
});
