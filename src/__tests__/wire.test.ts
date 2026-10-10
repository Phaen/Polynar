/**
 * Pinned wire vectors: fixed values and the exact output the current format
 * gives them, bytes as hex and text as the literal string. Every row checks
 * both directions, so a change to the wire format fails here. These change
 * only on purpose, together with the format.
 */

import { p, CharSets, buildProseModel, PNode } from '../index';
import type { CodecOptions } from '../index';

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));

/** Output too long to pin as hex: its length and FNV-1a hash. */
interface Digest {
  length: number;
  fnv1a: number;
}

const fnv1a = (bytes: Uint8Array): number => {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h = Math.imul(h ^ b, 0x01000193) >>> 0;
  }
  return h;
};

const Tree: PNode<unknown> = p.object({
  v: p.int().min(0).max(9),
  kids: p.array(p.lazy(() => Tree)).max(3),
});

/** [description, node, value, options, expected output, decoded value when it differs] */
type Vector = [
  string,
  PNode<any>,
  unknown,
  CodecOptions | undefined,
  Uint8Array | string | Digest,
  unknown?,
];

const vectors: Vector[] = [
  ['int bounded', p.int().min(-10).max(10), 7, undefined, hex('11')],
  ['int bounded at max', p.int().min(0).max(255), 255, undefined, hex('ff')],
  ['int one-sided min', p.int().min(100), 1234, undefined, hex('2a3600')],
  ['int one-sided max', p.int().max(0), -77, undefined, hex('3901')],
  ['int unbounded positive', p.int(), 42, undefined, hex('b001')],
  ['int unbounded negative', p.int(), -123456, undefined, hex('87c78600')],
  ['int unbounded -0', p.int(), -0, undefined, hex('00'), 0],
  ['int huge', p.int().min(0), 2 ** 60, undefined, hex('bd000000000000000000')],
  ['int max safe', p.int(), Number.MAX_SAFE_INTEGER, undefined, hex('0afeffffffffff3b')],
  ['decimal unbounded', p.decimal(0.01), -12.34, undefined, hex('a77100')],
  ['decimal bounded', p.decimal(0.01).min(0).max(100), 99.99, undefined, hex('0f27')],
  ['decimal one-sided', p.decimal(0.5).min(-2), 7.5, undefined, hex('4300')],
  ['float short decimal', p.float(), 0.1, undefined, hex('2205')],
  ['float fraction', p.float(), 1 / 3, undefined, hex('d62b')],
  ['float scientific', p.float(), 6.02e23, undefined, hex('6eb76b111121')],
  ['float noise', p.float(), Math.PI, undefined, hex('4623f57fcfed4704')],
  ['float zero', p.float(), 0, undefined, hex('289c00000000000000')],
  ['float -0', p.float(), -0, undefined, hex('299c00000000000000')],
  ['float subnormal', p.float(), Number.MIN_VALUE, undefined, hex('281c03000000000000')],
  ['float max', p.float(), Number.MAX_VALUE, undefined, hex('2e1cf9ffffffffff77')],
  ['bool true', p.bool(), true, undefined, hex('01')],
  ['bool false', p.bool(), false, undefined, hex('00')],
  ['bool weighted', p.bool().weights([9, 1]), false, undefined, hex('09')],
  ['enum', p.enum(['red', 'green', 'blue']), 'blue', undefined, hex('02')],
  ['enum mixed members', p.enum(['a', 1, true, null]), null, undefined, hex('03')],
  ['null', p.null(), null, undefined, hex('')],
  ['string empty', p.string(), '', undefined, hex('00')],
  ['string ascii', p.string(), 'hello, world', undefined, hex('33cd399ebe2b34d418e75314')],
  ['string astral', p.string(), 'a\u{1F600}b', undefined, hex('3cc8685b6380')],
  ['string lone surrogate', p.string(), 'x\uD800y\uDC00', undefined, hex('7cc637d64c509a6604')],
  ['string bounded', p.string().min(2).max(8), 'abcd', undefined, hex('e40c835e')],
  [
    'string prose',
    p.string().prose(),
    'the quick brown fox',
    undefined,
    hex('03e7b42dc7efc3905513117b1b'),
  ],
  [
    'string prose custom model',
    p.string().prose(buildProseModel('abba abab baba', { minCount: 1 })),
    'abba?',
    undefined,
    hex('bd911d'),
  ],
  [
    'string charset alphabet',
    p.string().charset(CharSets.hex),
    'DEADBEEF',
    undefined,
    hex('226ab4a94f'),
  ],
  [
    'string charset range',
    p.string().charset([0x61, 0x7a]),
    'polynar',
    undefined,
    hex('41fbcdef61'),
  ],
  ['binary', p.binary(), Uint8Array.of(0, 1, 2, 254, 255), undefined, hex('0d50a060ff4f')],
  [
    'binary fixed length',
    p.binary().length(4),
    Uint8Array.of(0xde, 0xad, 0xbe, 0xef),
    undefined,
    hex('deadbeef'),
  ],
  [
    'binary Float64Array',
    p.binary(Float64Array).max(8),
    Float64Array.of(-0, NaN, Infinity, -Infinity, 5e-324),
    undefined,
    hex('0500000000000080040000000000b87f040000000000707f04000000000070ff110000000000000000'),
  ],
  [
    'binary Int16Array',
    p.binary(Int16Array),
    Int16Array.of(-32768, -1, 0, 32767),
    undefined,
    hex('0c00d8ff4f00b0ff27'),
  ],
  ['date ms', p.date(), new Date(1700000000123), undefined, hex('064d61ef61a700')],
  ['date before epoch', p.date(), new Date(-86400001), undefined, hex('1723495608')],
  [
    'date precision day',
    p.date().precision('day'),
    new Date(Date.UTC(2024, 1, 29, 13, 45)),
    undefined,
    hex('245817'),
    new Date(Date.UTC(2024, 1, 29)),
  ],
  [
    'date precision quarter bounded',
    p.date().precision('month', 3).min(Date.UTC(2000, 0)).max(Date.UTC(2100, 0)),
    new Date(Date.UTC(2024, 3)),
    undefined,
    hex('6100'),
  ],
  ['array unbounded', p.array(p.int().min(0).max(9)), [3, 1, 4, 1, 5], undefined, hex('9dc23e')],
  ['array empty', p.array(p.string()), [], undefined, hex('00')],
  ['array bounded', p.array(p.bool()).min(1).max(4), [true, false, true], undefined, hex('16')],
  ['array fixed length', p.array(p.int().min(0).max(3)).length(3), [0, 3, 2], undefined, hex('2c')],
  [
    'array weighted count',
    p.array(p.bool()).max(3).weights([1, 8, 4, 1]),
    [true],
    undefined,
    hex('02'),
  ],
  [
    'array cdf count',
    p
      .array(p.bool())
      .max(4)
      .cdf((n) => n * n),
    [false, false, true, true],
    undefined,
    hex('2c'),
  ],
  [
    'object optional and nullable present',
    p.object({ id: p.int().min(0), name: p.optional(p.string()), note: p.nullable(p.string()) }),
    { id: 5, name: 'ann', note: 'hi' },
    undefined,
    hex('3d3d177175ac38'),
  ],
  [
    'object optional absent, nullable null',
    p.object({ id: p.int().min(0), name: p.optional(p.string()), note: p.nullable(p.string()) }),
    { id: 5, note: null },
    undefined,
    hex('ad00'),
  ],
  [
    'optional weighted',
    p.optional(p.int().min(0).max(3)).weights([1, 7]),
    undefined,
    undefined,
    hex('01'),
  ],
  ['union number', p.union([p.int(), p.string(), p.array(p.bool())]), -3, undefined, hex('4500')],
  ['union array', p.union([p.int(), p.string(), p.array(p.bool())]), [true], undefined, hex('44')],
  ['union weighted', p.union([p.null(), p.string()]).weights([1, 3]), 's', undefined, hex('fe0b')],
  [
    'tagged',
    p.tagged('kind', {
      circle: p.object({ r: p.int().min(0).max(100) }),
      square: p.object({ side: p.int().min(0) }),
    }),
    { kind: 'square', side: 9 },
    undefined,
    hex('5d00'),
  ],
  [
    'tagged weighted',
    p.tagged('kind', { a: p.object({}), b: p.object({ x: p.bool() }) }).weights([5, 1]),
    { kind: 'b', x: true },
    undefined,
    hex('0b'),
  ],
  ['versioned first', p.versioned(p.int().min(0).max(9)), 4, undefined, hex('14')],
  [
    'versioned newest',
    p.versioned(p.int().min(0).max(9), [p.string(), (n) => String(n)]),
    'four',
    undefined,
    hex('72dade3960'),
  ],
  ['any scalar', p.any(), 3.5, undefined, hex('8a2404')],
  [
    'any nested',
    p.any(),
    { a: [1, 'two', null, true], b: { c: new Date(0), d: undefined }, e: -1.25 },
    undefined,
    hex('8b48268b6deb35ad2846ca45961f965850a70700'),
  ],
  [
    'lazy recursion',
    Tree,
    {
      v: 1,
      kids: [
        { v: 2, kids: [] },
        { v: 3, kids: [{ v: 4, kids: [] }] },
      ],
    },
    undefined,
    hex('a53904'),
  ],
  ['int weights first', p.int().min(0).max(3).weights([5, 1, 1, 1]), 0, undefined, hex('00')],
  ['int weights last value', p.int().min(0).max(3).weights([5, 1, 1, 1]), 3, undefined, hex('07')],
  [
    'int cdf',
    p
      .int()
      .min(0)
      .max(99)
      .cdf((v) => v * v),
    50,
    undefined,
    hex('32'),
  ],
  [
    'int cdf last value',
    p
      .int()
      .min(0)
      .max(99)
      .cdf((v) => v * v),
    99,
    undefined,
    hex('63'),
  ],
  [
    'enum weights last value',
    p.enum(['x', 'y', 'z']).weights([10, 3, 1]),
    'z',
    undefined,
    hex('0d'),
  ],
  [
    'decimal cdf',
    p
      .decimal(0.5)
      .min(0)
      .max(10)
      .cdf((k) => 3 * k),
    2.5,
    undefined,
    hex('0f'),
  ],
  [
    'date cdf',
    p
      .date()
      .precision('day')
      .min(0)
      .max(Date.UTC(1970, 0, 31))
      .cdf((b) => b * b),
    new Date(Date.UTC(1970, 0, 11)),
    undefined,
    hex('0a'),
  ],
  [
    'zero-information fields',
    p.object({
      one: p.int().min(7).max(7),
      nil: p.null(),
      only: p.enum([42]),
      empty: p.array(p.bool()).length(0),
    }),
    { one: 7, nil: null, only: 42, empty: [] },
    undefined,
    hex(''),
  ],
  [
    'zero-information beside a bit',
    p.object({ one: p.int().min(7).max(7), flag: p.bool() }),
    { one: 7, flag: true },
    undefined,
    hex('01'),
  ],
  [
    'multi-block message',
    p.array(p.int().min(0).max(999)),
    Array.from({ length: 1000 }, (_, i) => (i * 7919) % 1000),
    undefined,
    { length: 1251, fnv1a: 0x87380554 },
  ],
  ['text Base64', p.string(), 'polynar', { type: 'text' }, 'BjQe23s0kC'],
  ['text urlSafe', p.int().min(0), 1e9, { type: 'text', charset: CharSets.urlSafe }, 'ZtYt74D'],
  [
    'text digit',
    p.int().min(0).max(999999),
    123456,
    { type: 'text', charset: CharSets.digit },
    '654321',
  ],
  [
    'text range charset',
    p.string(),
    'braille',
    { type: 'text', charset: [0x2800, 0x28ff] },
    '⡡⡐⢧⣒⡄⡅⢒',
  ],
  [
    'binary printable charset',
    p.string(),
    'bytes',
    { charset: CharSets.printable },
    hex('5f424b3c516323'),
  ],
  ['binary range charset', p.int().min(0), 65535, { charset: [0, 127] }, hex('347e3d01')],
  [
    'blockBits 128',
    p.array(p.int().min(0).max(999)).length(20),
    Array.from({ length: 20 }, (_, i) => i * 37),
    { blockBits: 128 },
    hex('080dffb3a761369045ee677ae8744e0024d470c4d7442cd80195'),
  ],
  [
    'blockBits 128 text',
    p.string(),
    'block size',
    { type: 'text', blockBits: 128 },
    'vA2MI7dmGHzeOB',
  ],
];

const decode = (node: PNode<any>, input: Uint8Array | string, options?: CodecOptions): unknown =>
  typeof input === 'string'
    ? node.decode(input, options as CodecOptions<'text'>)
    : node.decode(input, options as CodecOptions<'binary'>);

describe('Wire format', () => {
  it.each(vectors)('%s', (_, node, value, options, expected, ...rest) => {
    const decoded = rest.length > 0 ? rest[0] : value;
    const output = node.encode(value, options);
    if (typeof expected === 'string' || expected instanceof Uint8Array) {
      expect(output).toEqual(expected);
    } else {
      expect(output).toBeInstanceOf(Uint8Array);
      expect({ length: output.length, fnv1a: fnv1a(output as Uint8Array) }).toEqual(expected);
    }
    expect(decode(node, output, options)).toStrictEqual(decoded);
  });

  it('an older version decodes and migrates', () => {
    const later = p.versioned(p.int().min(0).max(9), [p.string(), (n) => String(n)]);
    expect(later.decode(hex('14'))).toBe('4');
  });
});
