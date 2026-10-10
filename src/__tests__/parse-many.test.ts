/**
 * `parseMany` reads a run of same-radix digits in chunks. Every case here
 * reads the same input twice, once digit by digit with `parse` and once with
 * `parseMany`, and expects the same digits or the same error, and the same
 * outcome from whatever is read after the run.
 */

import { Encoder, Decoder, CorruptInputError, PNode, p } from '../index';
import type { CodecOptions, OutputType } from '../index';
import { trip } from './support';

let seed = 1;
const random = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
};
const below = (n: number): number => Math.floor(random() * n);

/** Three weighted members out of four states, the middle one twice as likely. */
const BUCKETS: readonly (readonly [number, number, number])[] = [
  [0, 0, 1],
  [1, 1, 2],
  [2, 3, 1],
];
const locate = (r: number): readonly [number, number, number] => BUCKETS[r < 1 ? 0 : r < 3 ? 1 : 2];
const position = { count: 3, at: (i: number) => BUCKETS[i] };

type Options = CodecOptions<OutputType>;
type Input = Uint8Array | string;

/** What a read sequence returned, or the error it threw. */
type Outcome = { values: unknown[] } | { error: [string, string] };

function run(read: (dec: Decoder, values: unknown[]) => void, input: Input, o: Options): Outcome {
  const values: unknown[] = [];
  try {
    const dec = new Decoder(input, o);
    read(dec, values);
    dec.finalize();
    return { values };
  } catch (error) {
    const e = error as Error;
    return { error: [e.constructor.name, e.message] };
  }
}

/**
 * Reads `before`, then `count` radix digits, then `after`, both ways, and
 * expects one outcome. Returns it.
 */
function agree(
  input: Input,
  o: Options,
  radix: number,
  count: number,
  before: (dec: Decoder, values: unknown[]) => void = () => {},
  after: (dec: Decoder, values: unknown[]) => void = () => {}
): Outcome {
  const single = run(
    (dec, values) => {
      before(dec, values);
      for (let i = 0; i < count; i++) {
        values.push(dec.parse(radix));
      }
      after(dec, values);
    },
    input,
    o
  );
  const many = run(
    (dec, values) => {
      before(dec, values);
      values.push(...dec.parseMany(radix, count));
      after(dec, values);
    },
    input,
    o
  );
  expect(many).toEqual(single);
  return single;
}

const RADICES = [2, 3, 7, 10, 16, 64, 100, 255, 256, 257, 1000, 65536, 99991, 2 ** 31, 2 ** 40 + 1];
const LAYOUTS: Options[] = [
  {},
  { blockBits: 128 },
  { type: 'text' },
  { type: 'text', charset: '0123456789ABCDEF', blockBits: 128 },
  { charset: [0, 1] },
  { type: 'text', charset: '0123456789' },
];

function message(radix: number, digits: number[], o: Options, tail?: (enc: Encoder) => void) {
  const enc = new Encoder();
  for (const digit of digits) {
    enc.compose(digit, radix);
  }
  tail?.(enc);
  return enc.output(o);
}

const digitsIn = (radix: number, count: number): number[] =>
  Array.from({ length: count }, () => (random() < 0.1 ? radix - 1 : below(radix)));

describe('Decoder.parseMany', () => {
  it('reads what repeated parse reads, across radices, layouts and block boundaries', () => {
    for (const o of LAYOUTS) {
      for (const radix of RADICES) {
        for (const count of [0, 1, 2, 5, 31, 200, 1000]) {
          const digits = digitsIn(radix, count);
          const outcome = agree(message(radix, digits, o), o, radix, count);
          expect(outcome).toEqual({ values: digits });
        }
      }
    }
  });

  it('reads the largest radix, power of two or not', () => {
    for (const radix of [2 ** 53 - 1, 2 ** 52, 2 ** 53 - 111]) {
      const digits = [0, radix - 1, 12345, radix - 2, 1, 7];
      const o = { blockBits: 128 };
      expect(agree(message(radix, digits, o), o, radix, digits.length)).toEqual({
        values: digits,
      });
    }
  });

  it('splits a run between reads of other radices', () => {
    const o = { blockBits: 128 };
    const digits = digitsIn(10, 300);
    const enc = new Encoder();
    enc.compose(5, 7);
    for (const d of digits) {
      enc.compose(d, 10);
    }
    enc.compose(2, 3);
    const outcome = agree(
      enc.output(o),
      o,
      10,
      300,
      (dec, values) => values.push(dec.parse(7)),
      (dec, values) => values.push(dec.parse(3))
    );
    expect(outcome).toEqual({ values: [5, ...digits, 2] });
  });

  it('returns zeros for radix 1 without reading', () => {
    const o = {};
    const input = message(5, [3], o);
    expect(agree(input, o, 1, 4, undefined, (dec, values) => values.push(dec.parse(5)))).toEqual({
      values: [0, 0, 0, 0, 3],
    });
  });

  it('continues after weighted symbols', () => {
    for (const o of [{}, { blockBits: 128 }, { charset: [0, 1] as [number, number] }]) {
      for (const radix of [2, 10, 256, 1000]) {
        const weighted = Array.from({ length: 40 }, () => below(3));
        const digits = digitsIn(radix, 500);
        const enc = new Encoder();
        for (const s of weighted) {
          enc.composeWeighted(BUCKETS[s][1], BUCKETS[s][2], 4);
        }
        for (const d of digits) {
          enc.compose(d, radix);
        }
        const outcome = agree(enc.output(o), o, radix, digits.length, (dec, values) => {
          for (let i = 0; i < weighted.length; i++) {
            values.push(dec.parseWeighted(4, locate));
          }
        });
        expect(outcome).toEqual({ values: [...weighted, ...digits] });
      }
    }
  });

  it('interleaves with weighted symbols inside one block', () => {
    const o = {};
    const enc = new Encoder();
    const expected: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      const s = below(3);
      enc.composeWeighted(BUCKETS[s][1], BUCKETS[s][2], 4);
      expected.push(s);
      const d = below(100);
      enc.compose(d, 100);
      expected.push(d);
    }
    const read = (many: boolean) =>
      run(
        (dec, values) => {
          for (let i = 0; i < 30; i++) {
            values.push(dec.parseWeighted(4, locate));
            values.push(...(many ? dec.parseMany(100, 1) : [dec.parse(100)]));
          }
        },
        enc.output(o),
        o
      );
    expect(read(true)).toEqual(read(false));
    expect(read(true)).toEqual({ values: expected });
  });

  it('stops right before an indexed last symbol', () => {
    for (const o of [
      {},
      { blockBits: 128 },
      { type: 'text' as const, charset: '0123456789ABCDEF' },
    ]) {
      for (const count of [0, 1, 17, 100, 333]) {
        for (const last of [0, 1, 2]) {
          const digits = digitsIn(256, count);
          const input = message(256, digits, o, (enc) =>
            enc.composeWeighted(BUCKETS[last][1], BUCKETS[last][2], 4, { index: last, count: 3 })
          );
          const outcome = agree(input, o, 256, count, undefined, (dec, values) =>
            values.push(dec.parseWeighted(4, locate, position))
          );
          expect(outcome).toEqual({ values: [...digits, last] });
        }
      }
    }
  });

  it('fails like repeated parse on truncated, padded and corrupted input', () => {
    for (const o of LAYOUTS) {
      for (const radix of [2, 10, 256, 1000, 2 ** 31]) {
        const count = 150;
        const input = message(radix, digitsIn(radix, count), o);
        const variants: Input[] = [];
        for (const cut of [1, 2, 5, 17]) {
          variants.push(input.slice(0, Math.max(0, input.length - cut)));
        }
        if (typeof input === 'string') {
          variants.push(input + input[0]);
          for (let k = 0; k < 6; k++) {
            const at = below(input.length);
            const chars =
              o.charset === '0123456789ABCDEF'
                ? '0123456789ABCDEF'
                : o.charset === '0123456789'
                  ? '0123456789'
                  : 'AZaz09+/';
            variants.push(input.slice(0, at) + chars[below(chars.length)] + input.slice(at + 1));
          }
          variants.push(input.slice(0, 3) + '!' + input.slice(4));
        } else {
          const padded = new Uint8Array(input.length + 1);
          padded.set(input);
          variants.push(padded);
          for (let k = 0; k < 6; k++) {
            const flipped = input.slice();
            const top = o.charset === undefined ? 256 : 2;
            flipped[below(flipped.length)] = below(top);
            variants.push(flipped);
          }
        }
        for (const variant of variants) {
          agree(variant, o, radix, count);
          agree(variant, o, radix, count + 3);
        }
      }
    }
  });

  it('reports truncation like repeated parse when the run outlasts the input', () => {
    const o = {};
    const outcome = agree(message(10, digitsIn(10, 50), o), o, 10, 5000);
    expect(outcome).toEqual({
      error: ['CorruptInputError', 'Unexpected end of input while parsing: truncated or corrupted'],
    });
  });

  it('reads long runs', () => {
    for (const radix of [256, 100, 2]) {
      const digits = digitsIn(radix, 100_000);
      const o = {};
      const dec = new Decoder(message(radix, digits, o), o);
      expect(dec.parseMany(radix, digits.length)).toEqual(digits);
      dec.finalize();
    }
  });
});

describe('runs of single-digit nodes', () => {
  it('marks the nodes that read one plain digit', () => {
    expect(p.bool()._radix).toBe(2);
    expect(p.bool().weights([1, 3])._radix).toBeUndefined();
    expect(p.enum(['a', 'b', 'c'])._radix).toBe(3);
    expect(p.enum(['a', 'b', 'c']).weights([1, 2, 3])._radix).toBeUndefined();
    expect(p.int().min(-5).max(5)._radix).toBe(11);
    expect(p.int().min(0)._radix).toBeUndefined();
    expect(p.int().max(0)._radix).toBeUndefined();
    expect(p.int()._radix).toBeUndefined();
    expect(p.int().min(0).max(3).weights([1, 2, 3, 4])._radix).toBeUndefined();
    expect(p.decimal(0.25).min(-1).max(1)._radix).toBe(9);
    expect(p.decimal(0.25).min(-1)._radix).toBeUndefined();
    expect(p.date().min(0).max(86_400_000).precision('hour')._radix).toBe(25);
    expect(p.date().min(0)._radix).toBeUndefined();
    expect(p.optional(p.bool())._radix).toBeUndefined();
    expect(p.lazy(() => p.bool())._radix).toBeUndefined();
  });

  it('leaves a date range alone when a bucket at its edge starts outside the Date range', () => {
    const edge = p.date().min(-8.64e15).max(-8.6e15).precision('week');
    expect(edge._radix).toBeUndefined();
    const late = p.date().min(8.6e15).max(9e15).precision('day');
    expect(late._radix).toBeUndefined();
    const values = [new Date(-8.63e15), new Date(-8.61e15)];
    const node = p.array(edge);
    const back = node.decode(node.encode(values));
    expect(back.map((d) => edge.encode(d))).toEqual(values.map((d) => edge.encode(d)));
  });

  const D0 = Date.UTC(2020, 0, 1);
  const cases: [string, PNode<any>, () => unknown][] = [
    ['bool', p.bool(), () => random() < 0.5],
    ['enum', p.enum(['x', 'y', 'z', 7, null]), () => ['x', 'y', 'z', 7, null][below(5)]],
    ['int 0..255', p.int().min(0).max(255), () => below(256)],
    ['int -1e12..1e12', p.int().min(-1e12).max(1e12), () => below(2e12 + 1) - 1e12],
    ['decimal', p.decimal(0.01).min(-10).max(10), () => (below(2001) - 1000) / 100],
    [
      'date',
      p
        .date()
        .min(D0)
        .max(D0 + 365 * 86_400_000)
        .precision('day'),
      () => new Date(D0 + below(366) * 86_400_000),
    ],
    ['one-member enum', p.enum(['only']), () => 'only'],
  ];

  it.each(cases)('round-trips arrays of %s', (_, item, make) => {
    for (const count of [0, 1, 3, 250, 5000]) {
      const value = Array.from({ length: count }, make);
      for (const o of [{}, { blockBits: 128 }]) {
        const node = p.array(item);
        expect(node.decode(node.encode(value, o), o)).toEqual(value);
        const text = node.encode(value, { ...o, type: 'text' });
        expect(node.decode(text, o)).toEqual(value);
      }
    }
  });

  it('round-trips arrays of single-digit items inside other structures', () => {
    const node = p.object({
      flags: p.array(p.bool()),
      level: p
        .int()
        .min(1)
        .max(99)
        .weights(Array.from({ length: 99 }, (_, i) => i + 1)),
      bytes: p.array(p.int().min(0).max(255)).length(40),
      tag: p.enum(['a', 'b']).weights([3, 1]),
    });
    const value = {
      flags: Array.from({ length: 77 }, () => random() < 0.3),
      level: 42,
      bytes: Array.from({ length: 40 }, () => below(256)),
      tag: 'b' as const,
    };
    expect(node.decode(node.encode(value))).toEqual(value);
  });

  it('round-trips binary of every element width', () => {
    const bytes = Uint8Array.from({ length: 65536 }, () => below(256));
    const shorts = new Int16Array(bytes.buffer.slice(0, 2000));
    expect(trip(p.binary(Int16Array), shorts)).toEqual(shorts);
    const doubles = new Float64Array(bytes.buffer.slice(0, 8000));
    expect(trip(p.binary(Float64Array), doubles)).toEqual(doubles);
    const longs = new BigInt64Array(bytes.buffer.slice(0, 8000));
    expect(trip(p.binary(BigInt64Array), longs)).toEqual(longs);
    const node = p.binary();
    expect(node.decode(node.encode(bytes), {})).toEqual(bytes);
  });

  it('round-trips charset strings', () => {
    const hex = Array.from({ length: 20_000 }, () => '0123456789abcdef'[below(16)]).join('');
    const node = p.string().charset('0123456789abcdef');
    expect(node.decode(node.encode(hex))).toBe(hex);
    const range = p.string().charset([0x400, 0x4ff]);
    const cyrillic = String.fromCharCode(...Array.from({ length: 3000 }, () => 0x400 + below(256)));
    expect(range.decode(range.encode(cyrillic))).toBe(cyrillic);
    const single = p.string().charset('a');
    expect(single.decode(single.encode('aaaa'))).toBe('aaaa');
  });

  it('fails on truncated arrays like a per-item read', () => {
    const node = p.array(p.int().min(0).max(999)).length(500);
    const bytes = node.encode(Array.from({ length: 500 }, () => below(1000)));
    expect(() => node.decode(bytes.slice(0, bytes.length - 3))).toThrow(
      new CorruptInputError('Unexpected end of input while parsing: truncated or corrupted')
    );
  });
});
