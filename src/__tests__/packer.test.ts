/**
 * The Encoder/Decoder API that every node builds on: uniform digits and
 * `parseMany` runs, terms, weighted symbols, the checksum, and the
 * corruption checks that cost nothing. The streaming coder underneath lives
 * in stream.test.ts; output options (charsets, text or bytes) in
 * transport.test.ts. Seeded, so failures reproduce.
 */

import { Encoder, Decoder, CorruptInputError, p } from '../index';
import * as root from '../index';
import type { CodecOptions, OutputType } from '../index';
import { MessageState, SlotCache } from '../packer/state';
import * as packer from '../packer';
import type { Bucket } from '../packer';
import { members } from '../nodes/members';
import { buildWeights, writeTable } from '../nodes/weights';
import { mulberry32 } from './support';

const rand = mulberry32(0xa15eed);
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

/** Push `values` as base-1001 slots, the compact stand-in for real payloads. */
const composeAll = (encoder: Encoder, values: number[]): void => {
  for (const value of values) {
    encoder.compose(value, 1001);
  }
};

const parseAll = (decoder: Decoder, count: number): number[] =>
  Array.from({ length: count }, () => decoder.parse(1001));

describe('Public entrypoint', () => {
  it('exposes a non-empty, fully-defined surface', () => {
    // Every export is accessed so each lazy re-export getter runs.
    const keys = Object.keys(root);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect((root as Record<string, unknown>)[key]).toBeDefined();
    }
  });

  it('re-exports the working implementations', () => {
    expect(root.Encoder).toBe(Encoder);
    expect(root.Decoder).toBe(Decoder);
    expect(root.p).toBe(p);
    expect(root.members).toBe(members);
  });
});

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
 * Reads `before`, then `count` radix digits, then `after`, once digit by
 * digit with `parse` and once with `parseMany`, and expects one outcome.
 * Returns it.
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

/** Three weighted members out of four states, the middle one twice as likely. */
const BUCKETS: readonly (readonly [number, number, number])[] = [
  [0, 0, 1],
  [1, 1, 2],
  [2, 3, 1],
];
const locate = (r: number): readonly [number, number, number] => BUCKETS[r < 1 ? 0 : r < 3 ? 1 : 2];

const RADICES = [2, 3, 7, 10, 16, 64, 100, 255, 256, 257, 1000, 65536, 99991, 2 ** 31, 2 ** 40 + 1];
const LAYOUTS: Options[] = [
  {},
  { type: 'text' },
  { type: 'text', charset: '0123456789ABCDEF' },
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
  Array.from({ length: count }, () => (rand() < 0.1 ? radix - 1 : randInt(0, radix - 1)));

describe('Decoder digits', () => {
  it("counts the input's digits: bytes, or characters of text", () => {
    const enc = new Encoder();
    enc.compose(1234, 100000);
    const bytes = enc.output();
    expect(new Decoder(bytes).digits).toBe(bytes.length);
    expect(new Decoder('').digits).toBe(0);
    expect(new Decoder('AbCd', { type: 'text' }).digits).toBe(4);
  });
});

describe('compose / parse / parseMany', () => {
  it('folds radices whose product rounds to exactly 2^53 as doubles', () => {
    // 3002399751580331 · 3 = 2^53 + 1, which a double rounds to 2^53.
    const radices = [3002399751580331, 3, 2 ** 52];
    const enc = new Encoder();
    for (const radix of radices) {
      enc.compose(1, radix);
    }
    const dec = new Decoder(enc.output());
    expect(radices.map((radix) => dec.parse(radix))).toEqual([1, 1, 1]);
    dec.finalize();
  });

  it('rejects a digit outside its radix', () => {
    const encoder = new Encoder();
    expect(() => encoder.compose(10, 10)).toThrow(new RangeError('Digit 10 is outside [0, 10)'));
    expect(() => encoder.compose(-1, 10)).toThrow(RangeError);
    expect(() => encoder.compose(1.5, 10)).toThrow(
      new TypeError('Digit must be an integer, got 1.5')
    );
  });

  it('rejects an invalid radix', () => {
    const encoder = new Encoder();
    expect(() => encoder.compose(0, 0)).toThrow(
      new RangeError('Radix 0 is not a positive safe integer')
    );
    expect(() => encoder.compose(0, 2.5)).toThrow(
      new TypeError('Radix must be an integer, got 2.5')
    );
  });

  it('parse and parseMany reject an invalid radix like compose', () => {
    const decoder = new Decoder(new Uint8Array(0));
    for (const read of [(r: number) => decoder.parse(r), (r: number) => decoder.parseMany(r, 1)]) {
      expect(() => read(0)).toThrow(new RangeError('Radix 0 is not a positive safe integer'));
      expect(() => read(-1)).toThrow(RangeError);
      expect(() => read(2 ** 53)).toThrow(RangeError);
      expect(() => read(2.5)).toThrow(new TypeError('Radix must be an integer, got 2.5'));
      expect(() => read(NaN)).toThrow(TypeError);
      expect(() => read(Infinity)).toThrow(TypeError);
    }
  });

  it('parseMany rejects a count that is no non-negative integer', () => {
    const decoder = new Decoder(new Uint8Array(0));
    expect(() => decoder.parseMany(2, -1)).toThrow(new RangeError('Count -1 is negative'));
    expect(() => decoder.parseMany(2, 1.5)).toThrow(
      new TypeError('Count must be an integer, got 1.5')
    );
    expect(() => decoder.parseMany(2, NaN)).toThrow(TypeError);
    expect(() => decoder.parseMany(1, Infinity)).toThrow(TypeError);
    expect(() => decoder.parseMany(1, 2 ** 32)).toThrow(
      new RangeError('Count 4294967296 exceeds the longest array, 4294967295')
    );
    expect(decoder.parseMany(2, 0)).toEqual([]);
    expect(decoder.parseMany(1, 3)).toEqual([0, 0, 0]);
    decoder.finalize();
  });

  it('reads the edges of the radix domain', () => {
    const enc = new Encoder();
    enc.compose(0, 1);
    enc.compose(1, 2);
    enc.compose(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER);
    const bytes = enc.output();
    const dec = new Decoder(bytes);
    expect(dec.parse(1)).toBe(0);
    expect(dec.parse(2)).toBe(1);
    expect(dec.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER - 1);
    dec.finalize();
    const many = new Decoder(bytes);
    expect(many.parseMany(2, 1)).toEqual([1]);
    expect(many.parseMany(Number.MAX_SAFE_INTEGER, 1)).toEqual([Number.MAX_SAFE_INTEGER - 1]);
    many.finalize();
  });

  it('packs to the information-theoretic minimum length', () => {
    // Four base-1001 slots span 1001^4 ≈ 1.004e12 states. The largest needs 5
    // bytes (256^5 ≈ 1.100e12) and 7 Base64 chars (64^7 ≈ 4.398e12; 6 are too
    // few); a smaller value needs only its own digits.
    const encoder = new Encoder();
    composeAll(encoder, [1000, 1000, 1000, 1000]);
    expect(encoder.output().length).toBe(5);
    expect(encoder.output({ type: 'text' }).length).toBe(7);
    expect(parseAll(new Decoder(encoder.output()), 4)).toEqual([1000, 1000, 1000, 1000]);
    const small = new Encoder();
    composeAll(small, [1000, 0, 999, 1]);
    // 1000 + 999·1001² + 1001³ < 256^4
    expect(small.output().length).toBe(4);
    expect(parseAll(new Decoder(small.output()), 4)).toEqual([1000, 0, 999, 1]);
  });

  it('packs 40 booleans into exactly 40 bits', () => {
    // No byte boundary rounds a partially-filled slot up on its own; only the
    // whole message rounds, once, to 5 bytes.
    const encoder = new Encoder();
    for (let i = 0; i < 40; i++) {
      encoder.compose(i % 3 === 0 ? 1 : 0, 2);
    }
    expect(encoder.output().length).toBe(5);
  });

  it('parseMany reads what repeated parse reads, across radices and layouts', () => {
    for (const o of LAYOUTS) {
      for (const radix of RADICES) {
        for (const count of [0, 1, 2, 5, 31, 200, 1000]) {
          const digits = digitsIn(radix, count);
          expect(agree(message(radix, digits, o), o, radix, count)).toEqual({ values: digits });
        }
      }
    }
  });

  it('parseMany reads the largest radix, power of two or not', () => {
    for (const radix of [2 ** 53 - 1, 2 ** 52, 2 ** 53 - 111]) {
      const digits = [0, radix - 1, 12345, radix - 2, 1, 7];
      const o = {};
      expect(agree(message(radix, digits, o), o, radix, digits.length)).toEqual({
        values: digits,
      });
    }
  });

  it('parseMany splits a run between reads of other radices', () => {
    const o = {};
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

  it('parseMany returns zeros for radix 1 without reading', () => {
    const o = {};
    const input = message(5, [3], o);
    expect(agree(input, o, 1, 4, undefined, (dec, values) => values.push(dec.parse(5)))).toEqual({
      values: [0, 0, 0, 0, 3],
    });
  });

  it('parseMany continues after weighted symbols', () => {
    for (const o of [{}, { charset: [0, 1] as [number, number] }]) {
      for (const radix of [2, 10, 256, 1000]) {
        const weighted = Array.from({ length: 40 }, () => randInt(0, 2));
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

  it('parseMany interleaves with weighted symbols', () => {
    const enc = new Encoder();
    const expected: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      const s = randInt(0, 2);
      enc.composeWeighted(BUCKETS[s][1], BUCKETS[s][2], 4);
      expected.push(s);
      const d = randInt(0, 99);
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
        enc.output(),
        {}
      );
    expect(read(true)).toEqual(read(false));
    expect(read(true)).toEqual({ values: expected });
  });

  it('parseMany stops right before a weighted last symbol', () => {
    for (const o of [{}, { type: 'text' as const, charset: '0123456789ABCDEF' }]) {
      for (const count of [0, 1, 17, 100, 333]) {
        for (const last of [0, 1, 2]) {
          const digits = digitsIn(256, count);
          const input = message(256, digits, o, (enc) =>
            enc.composeWeighted(BUCKETS[last][1], BUCKETS[last][2], 4)
          );
          const outcome = agree(input, o, 256, count, undefined, (dec, values) =>
            values.push(dec.parseWeighted(4, locate))
          );
          expect(outcome).toEqual({ values: [...digits, last] });
        }
      }
    }
  });

  it('parseMany reads truncated, padded and corrupted input like repeated parse', () => {
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
          const chars = typeof o.charset === 'string' ? o.charset : 'AZaz09+/';
          for (let k = 0; k < 6; k++) {
            const at = randInt(0, input.length - 1);
            variants.push(
              input.slice(0, at) + chars[randInt(0, chars.length - 1)] + input.slice(at + 1)
            );
          }
          variants.push(input.slice(0, 3) + '!' + input.slice(4));
        } else {
          variants.push(Uint8Array.of(...input, 0));
          for (let k = 0; k < 6; k++) {
            const flipped = input.slice();
            flipped[randInt(0, flipped.length - 1)] = randInt(0, o.charset === undefined ? 255 : 1);
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

  it('parseMany reads zeros like repeated parse when the run outlasts the input', () => {
    const digits = digitsIn(10, 50);
    expect(agree(message(10, digits, {}), {}, 10, 5000)).toEqual({
      values: [...digits, ...Array<number>(4950).fill(0)],
    });
  });

  it('parseMany reads long runs', () => {
    for (const radix of [256, 100, 2]) {
      const digits = digitsIn(radix, 100_000);
      const dec = new Decoder(message(radix, digits, {}));
      expect(dec.parseMany(radix, digits.length)).toEqual(digits);
      dec.finalize();
    }
  });
});

describe('composeBig / parseBig', () => {
  const MAX = BigInt(Number.MAX_SAFE_INTEGER);

  const trip = (pairs: [bigint, bigint][]): bigint[] => {
    const encoder = new Encoder();
    for (const [index, radix] of pairs) {
      encoder.composeBig(index, radix);
    }
    const decoder = new Decoder(encoder.output());
    const back = pairs.map(([, radix]) => decoder.parseBig(radix));
    decoder.finalize();
    return back;
  };

  it('round-trips indices of safe and unsafe radices', () => {
    const huge = 3n ** 5000n;
    const pairs: [bigint, bigint][] = [
      [0n, 1n],
      [6n, 7n],
      [MAX - 1n, MAX],
      [MAX, MAX + 1n],
      [0n, MAX + 1n],
      [MAX + 1n, MAX + 2n],
      [huge - 1n, huge],
      [huge / 3n + 12345n, huge],
      [0n, huge],
    ];
    expect(trip(pairs)).toEqual(pairs.map(([index]) => index));
  });

  it('writes a safe radix as one compose', () => {
    const big = new Encoder();
    big.composeBig(1000n, 1001n);
    big.composeBig(MAX - 2n, MAX);
    const plain = new Encoder();
    plain.compose(1000, 1001);
    plain.compose(Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER);
    expect(big.output()).toEqual(plain.output());
  });

  it('wastes under a bit on a large radix', () => {
    // 3^5000 spans 7924.8 bits, so 991 bytes.
    const encoder = new Encoder();
    encoder.composeBig(3n ** 5000n - 1n, 3n ** 5000n);
    expect(encoder.output()).toHaveLength(991);
  });

  it('rejects an invalid radix or index', () => {
    const encoder = new Encoder();
    expect(() => encoder.composeBig(0n, 0n)).toThrow(new RangeError('Radix 0 is not positive'));
    expect(() => encoder.composeBig(0n, -5n)).toThrow(RangeError);
    expect(() => encoder.composeBig(10n, 10n)).toThrow(
      new RangeError('Digit 10 is outside [0, 10)')
    );
    expect(() => encoder.composeBig(-1n, MAX + 5n)).toThrow(RangeError);
    expect(() => encoder.composeBig(MAX + 5n, MAX + 5n)).toThrow(RangeError);
    expect(() => new Decoder(new Uint8Array(0)).parseBig(0n)).toThrow(
      new RangeError('Radix 0 is not positive')
    );
  });

  it('rejects an index past the radix as corrupt', () => {
    // Radix 2^53 + 1 tops at 2^32 + 1 over one 2^21 chunk, so the top digit
    // 2^32 with a chunk of 1 assembles 2^53 + 1, and with 0 the largest index.
    const radix = MAX + 2n;
    const encoder = new Encoder();
    encoder.compose(2 ** 32, 2 ** 32 + 1);
    encoder.compose(1, 2 ** 21);
    const decoder = new Decoder(encoder.output());
    expect(() => decoder.parseBig(radix)).toThrow(
      new CorruptInputError('Index is outside its radix')
    );
    const edge = new Encoder();
    edge.compose(2 ** 32, 2 ** 32 + 1);
    edge.compose(0, 2 ** 21);
    expect(new Decoder(edge.output()).parseBig(radix)).toBe(MAX + 1n);
  });
});

describe('composeTerm / parseTerm', () => {
  it('round-trips terms above 2^53 bit-exact', () => {
    // The digits travel through BigInt on both ends; float division here
    // rounds and would land on a neighbouring integer.
    const encoder = new Encoder();
    encoder.composeTerm(18014398509481988);
    encoder.composeTerm(1e300);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    expect(decoder.parseTerm()).toBe(18014398509481988);
    expect(decoder.parseTerm()).toBe(1e300);
  });

  it('round-trips across the inline/escaped boundary', () => {
    // Values below 3^21 ride as inline digit runs; from 3^21 up they escape
    // to the length-prefixed form.
    const edge = 3 ** 21;
    const encoder = new Encoder();
    encoder.composeTerm(edge - 1);
    encoder.composeTerm(edge);
    encoder.composeTerm(edge + 1);
    const decoder = new Decoder(encoder.output({ type: 'text' }));
    expect(decoder.parseTerm()).toBe(edge - 1);
    expect(decoder.parseTerm()).toBe(edge);
    expect(decoder.parseTerm()).toBe(edge + 1);
  });

  it('spends little more than the information content on large terms', () => {
    // 1e300 is ~997 bits of information. The escaped form carries it in
    // ~1016 bits; the pure base-3 run would need ~1260.
    const encoder = new Encoder();
    encoder.composeTerm(1e300);
    expect(encoder.output().length).toBeLessThanOrEqual(128);
  });

  it('rejects a negative or fractional term', () => {
    const encoder = new Encoder();
    expect(() => encoder.composeTerm(-1)).toThrow(new RangeError('Term -1 is negative'));
    expect(() => encoder.composeTerm(1.5)).toThrow(
      new TypeError('Term must be an integer, got 1.5')
    );
  });

  it('reads a run padded with a zero top digit as the same value', () => {
    // Digit symbols are d+1, so symbol 1 is a zero digit; on top of a run it
    // adds nothing but length. The encoder never emits it there, and the
    // decoder reads the value it names.
    const encoder = new Encoder();
    encoder.compose(2, 5); // first slot: digit 1
    encoder.compose(1, 4); // zero digit on top
    encoder.compose(0, 4); // terminator
    expect(new Decoder(encoder.output()).parseTerm()).toBe(1);
  });

  it('rejects a run longer than its maximum', () => {
    // Inline runs hold at most 21 digits (values below 3^21); past that the
    // arithmetic would stop being exact.
    const encoder = new Encoder();
    encoder.compose(2, 5);
    for (let i = 0; i < 21; i++) {
      encoder.compose(2, 4);
    }
    encoder.compose(0, 4);
    expect(() => new Decoder(encoder.output()).parseTerm()).toThrow(
      'Term run is longer than its maximum'
    );
  });

  it('rejects an escaped term no double represents', () => {
    // 2^53 + 1 in 18 base-8 digits: the escape, the count 18 - 12 = 6 as a
    // run (digit 0, digit 2, end), the 17 low digits, then the top one less 1.
    const value = 2n ** 53n + 1n;
    const encoder = new Encoder();
    encoder.compose(4, 5);
    encoder.compose(1, 4);
    encoder.compose(3, 4);
    encoder.compose(0, 4);
    for (let i = 0n; i < 17n; i++) {
      encoder.compose(Number((value >> (3n * i)) & 7n), 8);
    }
    encoder.compose(Number(value >> 51n) - 1, 7);
    expect(() => new Decoder(encoder.output()).parseTerm()).toThrow(
      new CorruptInputError('Escaped term is not an exactly representable integer')
    );
  });

  it('reads an escaped term inside the inline range as its value', () => {
    // The encoder escapes only values >= 3^21; a smaller value behind the
    // escape still names that value.
    const encoder = new Encoder();
    encoder.compose(4, 5); // escape symbol
    encoder.compose(0, 4); // digit count: the minimum, 12
    for (let i = 0; i < 11; i++) {
      encoder.compose(0, 8);
    }
    encoder.compose(0, 7); // top digit 1 -> value 8^11, below 3^21
    expect(new Decoder(encoder.output()).parseTerm()).toBe(8 ** 11);
  });
});

/** A random integer distribution: `symbols` buckets covering [0, total). */
interface Distribution {
  cums: number[];
  freqs: number[];
  total: number;
}

const randDistribution = (symbols: number): Distribution => {
  const freqs = Array.from({ length: symbols }, () => randInt(1, 1000));
  const cums: number[] = [];
  let total = 0;
  for (const f of freqs) {
    cums.push(total);
    total += f;
  }
  return { cums, freqs, total };
};

const locateIn =
  (dist: Distribution) =>
  (residual: number): readonly [number, number, number] => {
    let symbol = dist.cums.length - 1;
    while (dist.cums[symbol] > residual) {
      symbol--;
    }
    return [symbol, dist.cums[symbol], dist.freqs[symbol]];
  };

describe('composeWeighted / parseWeighted', () => {
  it('round-trips random weighted sequences mixed with uniform and term slots', () => {
    for (let run = 0; run < 200; run++) {
      const dist = randDistribution(randInt(2, 40));
      const enc = new Encoder();
      const script: Array<['w' | 'u' | 't', number]> = [];

      for (let i = randInt(1, 60); i > 0; i--) {
        const kind = rand() < 0.6 ? 'w' : rand() < 0.5 ? 'u' : 't';
        if (kind === 'w') {
          const symbol = randInt(0, dist.freqs.length - 1);
          enc.composeWeighted(dist.cums[symbol], dist.freqs[symbol], dist.total);
          script.push(['w', symbol]);
        } else if (kind === 'u') {
          const value = randInt(0, 999);
          enc.compose(value, 1000);
          script.push(['u', value]);
        } else {
          const value = randInt(0, 2 ** 40);
          enc.composeTerm(value);
          script.push(['t', value]);
        }
      }

      const dec = new Decoder(enc.output());
      for (const [kind, expected] of script) {
        if (kind === 'w') {
          expect(dec.parseWeighted(dist.total, locateIn(dist))).toBe(expected);
        } else if (kind === 'u') {
          expect(dec.parse(1000)).toBe(expected);
        } else {
          expect(dec.parseTerm()).toBe(expected);
        }
      }
      dec.finalize();
    }
  });

  it('is byte-identical to compose when every frequency is one, before a uniform end', () => {
    // A symbol folded onto a state below its frequency takes the spread map,
    // so only a nonzero uniform slot at the end makes the spellings meet.
    for (let run = 0; run < 50; run++) {
      const uniform = new Encoder();
      const weighted = new Encoder();
      const values: Array<[number, number]> = [];
      for (let i = randInt(1, 40); i > 0; i--) {
        const radix = randInt(2, 100000);
        const value = randInt(0, radix - 1);
        uniform.compose(value, radix);
        weighted.composeWeighted(value, 1, radix);
        values.push([value, radix]);
      }
      uniform.compose(1, 2);
      weighted.compose(1, 2);
      expect(weighted.output()).toEqual(uniform.output());

      const dec = new Decoder(uniform.output());
      for (const [value, radix] of values) {
        expect(dec.parseWeighted(radix, (r) => [r, r, 1])).toBe(value);
      }
      expect(dec.parse(2)).toBe(1);
      dec.finalize();
    }
  });

  it('spends fewer bytes on likelier symbols', () => {
    // 1000 draws of the heavy symbol (f=15 of 16) cost ~93 bits; nonzero
    // uniform base-16 slots cost 4000.
    const heavy = new Encoder();
    const flat = new Encoder();
    for (let i = 0; i < 1000; i++) {
      heavy.composeWeighted(0, 15, 16);
      flat.compose(1, 16);
    }
    expect(heavy.output().length).toBeLessThan(20);
    expect(flat.output().length).toBeGreaterThan(490);
  });

  it('round-trips long weighted runs', () => {
    const dist = randDistribution(8);
    const enc = new Encoder();
    const symbols: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const symbol = randInt(0, 7);
      enc.composeWeighted(dist.cums[symbol], dist.freqs[symbol], dist.total);
      symbols.push(symbol);
    }
    const dec = new Decoder(enc.output());
    for (const symbol of symbols) {
      expect(dec.parseWeighted(dist.total, locateIn(dist))).toBe(symbol);
    }
    dec.finalize();
  });

  it('spends the information content on a likely run, plus at most its ending', () => {
    // A run of the likely symbol (f = 99 of 100) shares log2(100/99) bits per
    // draw. The last draws fold onto states below 99, which costs at most
    // log2(100) bits however long the run, and the message rounds once.
    const bits = (n: number): number => {
      const enc = new Encoder();
      for (let i = 0; i < n; i++) {
        enc.composeWeighted(1, 99, 100);
      }
      return enc.output({ type: 'text', charset: '01' }).length;
    };
    const share = (n: number): number => n * Math.log2(100 / 99);
    for (const n of [2, 10, 100, 1000]) {
      expect(bits(n)).toBeLessThanOrEqual(Math.ceil(share(n) + Math.log2(100)) + 1);
    }
  });

  it('rejects invalid buckets at the source', () => {
    const enc = new Encoder();
    expect(() => enc.composeWeighted(0, 0, 4)).toThrow(
      new RangeError('Frequency 0 is not positive')
    );
    expect(() => enc.composeWeighted(-1, 2, 4)).toThrow(RangeError);
    expect(() => enc.composeWeighted(3, 2, 4)).toThrow(
      new RangeError('Bucket [3, 5) is outside [0, 4)')
    );
    expect(() => enc.composeWeighted(0, 1, 0)).toThrow(
      new RangeError('Total 0 is not a positive safe integer')
    );
    expect(() => enc.composeWeighted(0, 1, 2 ** 54)).toThrow(RangeError);
    expect(() => enc.composeWeighted(0, 1.5, 4)).toThrow(
      new TypeError('Bucket must be integers, got cum 0, freq 1.5, total 4')
    );
    expect(() => enc.composeWeighted(0.5, 1, 4)).toThrow(TypeError);
    expect(() => enc.composeWeighted(0, 1, 4.5)).toThrow(TypeError);
  });

  it('parseWeighted rejects an invalid total like composeWeighted', () => {
    const dec = new Decoder(new Uint8Array(0));
    const locate = () => [0, 0, 1] as const;
    expect(() => dec.parseWeighted(0, locate)).toThrow(
      new RangeError('Total 0 is not a positive safe integer')
    );
    expect(() => dec.parseWeighted(2 ** 53, locate)).toThrow(RangeError);
    expect(() => dec.parseWeighted(2.5, locate)).toThrow(
      new TypeError('Total must be an integer, got 2.5')
    );
    expect(() => dec.parseWeighted(NaN, locate)).toThrow(TypeError);
    expect(dec.parseWeighted(1, () => ['only', 0, 1] as const)).toBe('only');
  });

  it('rejects a locate that misses the residual', () => {
    const encoder = new Encoder();
    encoder.composeWeighted(0, 1, 2);
    const decoder = new Decoder(encoder.output());
    expect(() => decoder.parseWeighted(2, () => [0, 0, 0] as const)).toThrow(
      'locate returned a bucket that does not contain the residual: [0, 0) for 0'
    );
  });
});

describe('composeWeighted / parseWeighted at the end of the message', () => {
  // Four members, weight k each: two bits of information each, however
  // large the total.
  const four = (k: number) => ({ cums: [0, k, 2 * k, 3 * k], freqs: [k, k, k, k], total: 4 * k });

  it('writes a lone weighted value in the bits its weight gives it, whatever the total', () => {
    for (const k of [1, 1000, 1e6, 1e12]) {
      const dist = four(k);
      for (let s = 0; s < 4; s++) {
        const enc = new Encoder();
        enc.compose(5, 7);
        enc.composeWeighted(dist.cums[s], dist.freqs[s], dist.total);
        const bytes = enc.output();
        expect(bytes.length).toBe(1);
        const dec = new Decoder(bytes);
        expect(dec.parse(7)).toBe(5);
        expect(dec.parseWeighted(dist.total, locateIn(dist))).toBe(s);
        dec.finalize();
      }
    }
  });

  it('spends nothing on a constant field that ends the message', () => {
    const shape = { a: p.int().min(0).max(1000), flag: p.bool().weights([99, 1]) };
    const bits = p
      .object(shape)
      .encode({ a: 500, flag: true }, { type: 'text', charset: '01' }).length;
    const node = p.object({ ...shape, c: p.enum(['v1']) });
    const value = { a: 500, flag: true, c: 'v1' as const };
    const text = node.encode(value, { type: 'text', charset: '01' });
    expect(text.length).toBe(bits);
    expect(node.decode(text, { charset: '01' })).toEqual(value);
  });

  it('records nothing for a weighted value that holds every state', () => {
    const shape = { a: p.bool().weights([99, 1]) };
    const bits = p.object(shape).encode({ a: true }, { type: 'text', charset: '01' }).length;
    const node = p.object({ ...shape, b: p.int().min(5).max(5).weights([1]) });
    const text = node.encode({ a: true, b: 5 }, { type: 'text', charset: '01' });
    expect(text.length).toBe(bits);
    expect(node.decode(text, { charset: '01' })).toEqual({ a: true, b: 5 });
  });
});

describe('Corruption detection', () => {
  it('finalize rejects a corrupted digit that oversaturates the input', () => {
    // Two radix-50 values span 2500 of the 4096 states two Base64 chars hold.
    // A top char that lifts the value past 2500 leaves state over once both
    // are read, which is only provably corrupt once the message ends.
    const encoder = new Encoder();
    encoder.compose(10, 50);
    encoder.compose(20, 50);
    const str = encoder.output({ type: 'text' });
    expect(str).toHaveLength(2);
    const decoder = new Decoder('/' + str.slice(1));
    decoder.parse(50);
    decoder.parse(50);
    expect(() => decoder.finalize()).toThrow('Unread or corrupted data at end of input');
  });

  it('finalize throws on a corrupted digit the reads alone cannot see', () => {
    // A boolean spans 2 of the 64 states its single Base64 char holds; bumping
    // the char leaves a remainder invisible to the read (which still returns a
    // valid boolean) but caught by the leftover-value check.
    const encoder = new Encoder();
    encoder.compose(1, 2);
    expect(encoder.output({ type: 'text' })).toBe('B');
    const decoder = new Decoder('D');
    expect(decoder.parse(2)).toBe(1);
    expect(() => decoder.finalize()).toThrow('Unread or corrupted data at end of input');
  });

  it('finalize throws on trailing padding appended to the input', () => {
    const encoder = new Encoder();
    encoder.compose(1, 2);
    const decoder = new Decoder(encoder.output({ type: 'text' }) + 'A');
    decoder.parse(2);
    expect(() => decoder.finalize()).toThrow(CorruptInputError);
  });

  it('finalize throws on input a message without values never reads', () => {
    expect(() => new Decoder('A').finalize()).toThrow('Input is longer than its contents');
  });

  it('reads 0 past the last value', () => {
    // A trailing 0 folds onto state 0 and leaves it there, so writing it
    // gives the same input: a read past the last value is a read of that 0,
    // and nothing tells them apart.
    const short = new Encoder();
    short.compose(1, 2);
    const long = new Encoder();
    long.compose(1, 2);
    long.compose(0, 2);
    long.compose(0, 1001);
    const str = short.output({ type: 'text' });
    expect(long.output({ type: 'text' })).toBe(str);
    const decoder = new Decoder(str);
    expect(decoder.parse(2)).toBe(1);
    expect(decoder.parse(2)).toBe(0);
    expect(decoder.parse(1001)).toBe(0);
    expect(decoder.parseWeighted(4, locate)).toBe(0);
    decoder.finalize();
    expect(new Decoder('').parse(1001)).toBe(0);
  });

  it('finalize throws when values remain unread', () => {
    const encoder = new Encoder();
    encoder.compose(1, 1001);
    encoder.compose(2, 1001);
    const decoder = new Decoder(encoder.output());
    decoder.parse(1001);
    expect(() => decoder.finalize()).toThrow('Unread or corrupted data at end of input');
  });
});

describe('Checksum', () => {
  const User = p.object({
    name: p.string().max(40),
    age: p.int().min(0).max(120),
    active: p.bool(),
  });
  const user = { name: 'Ada Lovelace', age: 36, active: true };
  const layouts: { o: Options; base: number }[] = [
    { o: {}, base: 256 },
    { o: { type: 'text', charset: root.CharSets.urlSafe }, base: 66 },
    { o: { charset: [0, 1] }, base: 2 },
  ];

  it('round-trips at every width, over every layout, for a few digits', () => {
    for (const { o, base } of layouts) {
      const off = User.encode(user, o).length;
      for (const k of [1, 8, 16, 32]) {
        const on = User.encode(user, { ...o, checksum: k } as never);
        expect(User.decode(on, { ...o, checksum: k } as never)).toEqual(user);
        const extra = on.length - off;
        expect(extra).toBeGreaterThanOrEqual(Math.floor(k / Math.log2(base)));
        expect(extra).toBeLessThanOrEqual(Math.ceil(k / Math.log2(base)) + 1);
      }
    }
  });

  it('gives an empty message its checksum digits', () => {
    const Empty = p.object({});
    const bytes = Empty.encode({}, { checksum: 16 });
    expect(bytes).toHaveLength(2);
    expect(Empty.decode(bytes, { checksum: 16 })).toEqual({});
  });

  it('rejects empty input', () => {
    expect(() => User.decode(new Uint8Array(0), { checksum: 8 })).toThrow(CorruptInputError);
    expect(() => User.decode('', { checksum: 8, type: 'text' })).toThrow(CorruptInputError);
  });

  it('rejects one corrupted digit of a 32-bit checksum', () => {
    const bytes = User.encode(user, { checksum: 32 });
    for (const at of [0, bytes.length - 1]) {
      const bad = bytes.slice();
      bad[at] ^= 1;
      expect(() => User.decode(bad, { checksum: 32 })).toThrow(
        new CorruptInputError('Checksum mismatch: corrupted input')
      );
    }
    const text = User.encode(user, { type: 'text', checksum: 32 });
    const swapped = text.slice(0, 3) + (text[3] === 'A' ? 'B' : 'A') + text.slice(4);
    expect(() => User.decode(swapped, { type: 'text', checksum: 32 })).toThrow(CorruptInputError);
  });

  it('rejects a different width than the one encoded', () => {
    const bytes = User.encode(user, { checksum: 16 });
    expect(() => User.decode(bytes, { checksum: 8 })).toThrow(CorruptInputError);
    expect(() => User.decode(bytes, { checksum: 32 })).toThrow(CorruptInputError);
  });

  it('does not decode checksummed output to the value without the option', () => {
    const bytes = User.encode(user, { checksum: 16 });
    let decoded: unknown;
    try {
      decoded = User.decode(bytes);
    } catch (e) {
      expect(e).toBeInstanceOf(CorruptInputError);
      return;
    }
    expect(decoded).not.toEqual(user);
  });

  it('seals a raw Encoder and Decoder', () => {
    const bytes = new Encoder().output({ checksum: 8 }) as Uint8Array;
    expect(bytes).toHaveLength(1);
    new Decoder(bytes, { checksum: 8 }).finalize();
  });

  it('covers every digit of a long message', () => {
    const o = { checksum: 32 };
    const encoder = new Encoder();
    for (let i = 0; i < 3000; i++) {
      encoder.compose(i % 1000, 1000);
    }
    const bytes = encoder.output(o) as Uint8Array;
    const decoder = new Decoder(bytes, o);
    for (let i = 0; i < 3000; i++) {
      expect(decoder.parse(1000)).toBe(i % 1000);
    }
    decoder.finalize();
    for (const at of [0, bytes.length - 1]) {
      const bad = bytes.slice();
      bad[at] ^= 1;
      expect(() => new Decoder(bad, o)).toThrow(CorruptInputError);
    }
  });

  it('seals a state too big for a double', () => {
    const o = { checksum: 32 };
    const encoder = new Encoder();
    for (const v of [5, 77, 1000]) {
      encoder.compose(v, 2 ** 20);
    }
    const decoder = new Decoder(encoder.output(o), o);
    expect([decoder.parse(2 ** 20), decoder.parse(2 ** 20), decoder.parse(2 ** 20)]).toEqual([
      5, 77, 1000,
    ]);
    decoder.finalize();
  });
});

describe('MessageState / state', () => {
  it('keeps one slot per key for the whole message, created once', () => {
    const state = new MessageState();
    const a = {};
    const b = (): void => {};
    let runs = 0;
    const init = () => {
      runs++;
      return { count: runs };
    };
    const slot = state.get(a, init);
    expect(state.get(a, init)).toBe(slot);
    expect(state.get(b, init)).not.toBe(slot);
    expect(state.get(b, init)).toEqual({ count: 2 });
    expect(runs).toBe(2);
    expect(new MessageState().get(a, init)).toEqual({ count: 3 });
  });

  it('gives each Encoder and Decoder slots of its own', () => {
    const key = {};
    for (const make of [() => new Encoder(), () => new Decoder(new Uint8Array(0))]) {
      const first = make();
      const slot = first.state(key, () => [] as number[]);
      slot.push(1);
      expect(first.state(key, () => [] as number[])).toEqual([1]);
      expect(first.state({}, () => [] as number[])).toEqual([]);
      expect(make().state(key, () => [] as number[])).toEqual([]);
    }
  });

  it('counts the slots it drops', () => {
    const state = new MessageState();
    const key = {};
    const slot = state.get(key, () => ({}));
    expect(state.epoch).toBe(0);
    expect(state.delete(key)).toBe(true);
    expect(state.epoch).toBe(1);
    expect(state.get(key, () => ({}))).not.toBe(slot);
    expect(state.delete({})).toBe(false);
    expect(state.epoch).toBe(2);
  });

  it('drops a slot made in a transaction that rolls back', () => {
    const enc = new Encoder();
    const key = {};
    const mark = enc.mark();
    const slot = enc.state(key, () => ({}));
    expect(enc.stateEpoch).toBe(0);
    enc.rollback(mark);
    expect(enc.stateEpoch).toBe(1);
    expect(enc.state(key, () => ({}))).not.toBe(slot);
    expect(new Decoder(new Uint8Array(0)).stateEpoch).toBe(0);
  });

  it('caches a slot per side until the side drops one', () => {
    const key = {};
    let built = 0;
    const cache = new SlotCache<{ n: number }, Encoder | Decoder>(key, () => ({ n: ++built }));
    const enc = new Encoder();
    const slot = cache.get(enc);
    expect(cache.get(enc)).toBe(slot);
    expect(enc.state(key, () => ({ n: 0 }))).toBe(slot);
    const dec = new Decoder(new Uint8Array(0));
    expect(cache.get(dec)).toEqual({ n: 2 });
    expect(cache.get(enc)).toBe(slot);
    // A slot built inside a transaction is gone after its rollback.
    const fresh = new Encoder();
    const mark = fresh.mark();
    const tried = cache.get(fresh);
    fresh.rollback(mark);
    const after = cache.get(fresh);
    expect(after).not.toBe(tried);
    expect(fresh.state(key, () => ({ n: 0 }))).toBe(after);
    expect(built).toBe(4);
  });

  it('rejects a key that is no object', () => {
    const state = new MessageState();
    const init = () => 0;
    for (const [key, kind] of [
      [null, 'null'],
      [3, 'number'],
      ['x', 'string'],
    ] as const) {
      const error = new TypeError(`State key must be an object, got ${kind}`);
      expect(() => state.get(key as unknown as object, init)).toThrow(error);
      expect(() => new Encoder().state(key as unknown as object, init)).toThrow(error);
      expect(() => new Decoder(new Uint8Array(0)).state(key as unknown as object, init)).toThrow(
        error
      );
    }
  });

  it('is reachable from the packer barrel along with Bucket', () => {
    expect(packer.MessageState).toBe(MessageState);
    const bucket: Bucket = [0, 1, 2];
    expect(bucket).toHaveLength(3);
  });
});

describe('composeSelector / composeAlternatives', () => {
  /** A uniform digit, a group's selector, or one of a group's symbols. */
  type Step =
    | ['u', number, number]
    | ['s', object, readonly Bucket[]]
    | ['a', object, readonly Bucket[], { index: number; count: number }?];

  /** The script written through selectors and alternatives. */
  const adaptive = (script: readonly Step[]): Encoder => {
    const enc = new Encoder();
    for (const step of script) {
      if (step[0] === 'u') {
        enc.compose(step[1], step[2]);
      } else if (step[0] === 's') {
        enc.composeSelector(step[1], step[2]);
      } else {
        enc.composeAlternatives(step[1], step[2]);
      }
    }
    return enc;
  };

  /** The script spelled directly in each group's `chosen` coding. */
  const plain = (script: readonly Step[], chosen: Map<object, number>): Encoder => {
    const enc = new Encoder();
    for (const step of script) {
      if (step[0] === 'u') {
        enc.compose(step[1], step[2]);
      } else if (step[0] === 's') {
        const index = chosen.get(step[1]) ?? 0;
        const [cum, freq, total] = step[2][index];
        enc.composeWeighted(cum, freq, total);
      } else {
        const [cum, freq, total] = step[2][chosen.get(step[1]) ?? 0];
        enc.composeWeighted(cum, freq, total);
      }
    }
    return enc;
  };

  /**
   * Reads the script back: the selector as a weighted symbol over its
   * choices, which partition their total, each symbol in its
   * group's coding. A symbol with a position is read as one of equal-width
   * members.
   */
  const read = (input: Uint8Array | string, script: readonly Step[], o: Options): void => {
    const dec = new Decoder(input, o);
    const chosen = new Map<object, number>();
    for (const step of script) {
      if (step[0] === 'u') {
        expect(dec.parse(step[2])).toBe(step[1]);
      } else if (step[0] === 's') {
        const choices = step[2];
        const at = (i: number) => [i, choices[i][0], choices[i][1]] as const;
        const locate = (r: number) => at(choices.findIndex(([c, f]) => c <= r && r < c + f));
        chosen.set(step[1], dec.parseWeighted(choices[0][2], locate));
      } else {
        const [cum, freq, total] = step[2][chosen.get(step[1]) ?? 0];
        const position = step[3];
        if (position === undefined) {
          const symbol = dec.parseWeighted(total, (r) =>
            r < cum
              ? (['below', 0, cum] as const)
              : r < cum + freq
                ? (['hit', cum, freq] as const)
                : (['above', cum + freq, total - cum - freq] as const)
          );
          expect(symbol).toBe('hit');
        } else {
          const member = (i: number) => [i, i * freq, freq] as const;
          const symbol = dec.parseWeighted(total, (r) => member(Math.floor(r / freq)));
          expect(symbol).toBe(position.index);
        }
      }
    }
    dec.finalize();
  };

  /** Expects the script to equal its plain spelling in `chosen`, byte for byte, in every layout. */
  const check = (script: readonly Step[], chosen: Map<object, number>): void => {
    for (const o of LAYOUTS) {
      const out = adaptive(script).output(o);
      expect(out).toEqual(plain(script, chosen).output(o));
      read(out, script, o);
    }
  };

  const g = {};
  const h = {};

  /** A selector over `count` equally likely codings. */
  const uniform = (count: number): Bucket[] =>
    Array.from({ length: count }, (_, i): Bucket => [i, 1, count]);

  /** The script with `symbols` of group `g` between two uniform digits. */
  const framed = (count: number, symbols: (readonly Bucket[])[]): Step[] => [
    ['u', 3, 10],
    ['s', g, uniform(count)],
    ...symbols.map((buckets): Step => ['a', g, buckets]),
    ['u', 4, 10],
  ];

  it('keeps the coding whose symbols cost the fewest bits', () => {
    // Three bits a symbol under coding 0, under half a bit under coding 1.
    const symbols = [0, 1, 2, 3, 4].map((i): readonly Bucket[] => [
      [i, 1, 8],
      [i % 2, 7, 8],
    ]);
    check(framed(2, symbols), new Map([[g, 1]]));
  });

  it('keeps the lowest coding on a tie', () => {
    const symbols = [0, 1, 2].map((i): readonly Bucket[] => [
      [i, 1, 4],
      [3 - i, 1, 4],
    ]);
    check(framed(2, symbols), new Map([[g, 0]]));
  });

  it('weighs the whole message, not each symbol', () => {
    // Coding 1 wins two symbols of three, yet costs 5.83 bits to coding 0's 5.
    const symbols: (readonly Bucket[])[] = [
      [
        [0, 1, 2],
        [0, 1, 32],
      ],
      [
        [0, 1, 4],
        [0, 3, 4],
      ],
      [
        [1, 1, 4],
        [1, 3, 4],
      ],
    ];
    check(framed(2, symbols), new Map([[g, 0]]));
  });

  it('chooses among three codings', () => {
    const symbols = [0, 1, 2, 3].map((i): readonly Bucket[] => [
      [i, 1, 6],
      [i, 3, 9],
      [i, 2, 7],
    ]);
    check(framed(3, symbols), new Map([[g, 1]]));
  });

  it('tells apart codings a hair apart per symbol over many symbols', () => {
    // 1001 against 1000 of 2000 states: each symbol differs by a factor of
    // 1.001, and 10000 of them by about e^10.
    for (const [freq, choice] of [
      [1001, 1],
      [999, 0],
      [1000, 0],
    ] as const) {
      const symbols = Array.from({ length: 10000 }, (): readonly Bucket[] => [
        [0, 1000, 2000],
        [0, freq, 2000],
      ]);
      const out = adaptive(framed(2, symbols)).output();
      expect(out).toEqual(plain(framed(2, symbols), new Map([[g, choice]])).output());
      read(out, framed(2, symbols), {});
    }
  });

  it('compares ratios past the double range', () => {
    // Per symbol, coding 0 holds one state of 1024; the others `a` and `b`.
    const likelier = (n: number, a: number, b: number): (readonly Bucket[])[] =>
      Array.from({ length: n }, (): readonly Bucket[] => [
        [0, 1, 1024],
        [0, a, 1024],
        [0, b, 1024],
      ]);
    // 1023^120 and 1022^120 both lie in [2^1024, 2^1536): the mantissas decide.
    check(framed(3, likelier(120, 1023, 1022)), new Map([[g, 1]]));
    check(framed(3, likelier(120, 1022, 1023)), new Map([[g, 2]]));
    // 511^53 lies below 2^512 and 1023^53 above it: the exponents decide.
    check(framed(3, likelier(53, 511, 1023)), new Map([[g, 2]]));
    check(framed(3, likelier(53, 1023, 511)), new Map([[g, 1]]));
    // 1/1023^120 lies far below coding 0's 1.
    const unlikelier = likelier(120, 1023, 1023).map((b): readonly Bucket[] => [b[1], b[0], b[0]]);
    check(framed(3, unlikelier), new Map([[g, 0]]));
  });

  it('writes nothing for the selector of a single coding', () => {
    const script = framed(1, [[[2, 3, 10]], [[0, 1, 10]]]);
    check(script, new Map([[g, 0]]));
  });

  it('writes the last symbol as the plain spelling would', () => {
    // The first symbol settles the coding; the last is a quarter of the
    // states under coding 0 and a half under coding 1.
    for (const [first, choice] of [
      [[0, 1, 8], 1],
      [[0, 7, 8], 0],
    ] as const) {
      const opening: readonly Bucket[] = choice === 1 ? [first, [0, 7, 8]] : [first, [0, 1, 8]];
      const last: readonly Bucket[] = [
        [2e12, 1e12, 4e12],
        [8, 4, 16],
      ];
      for (const position of [undefined, { index: 2, count: 4 }, { index: 2, count: 40 }]) {
        const script: Step[] = [
          ['u', 3, 10],
          ['s', g, uniform(2)],
          ['a', g, opening],
          ['a', g, last, position],
        ];
        check(script, new Map([[g, choice]]));
      }
    }
  });

  it('writes a selector that ends the message as coding 0', () => {
    for (const count of [1, 2, 300]) {
      check(
        [
          ['u', 3, 10],
          ['s', g, uniform(count)],
        ],
        new Map()
      );
    }
  });

  it('settles interleaved groups each on their own', () => {
    const script: Step[] = [
      ['s', g, uniform(2)],
      ['s', h, uniform(2)],
      [
        'a',
        g,
        [
          [0, 1, 8],
          [0, 7, 8],
        ],
      ],
      ['u', 5, 7],
      [
        'a',
        h,
        [
          [0, 7, 8],
          [0, 1, 8],
        ],
      ],
      [
        'a',
        g,
        [
          [1, 1, 8],
          [1, 7, 8],
        ],
      ],
      [
        'a',
        h,
        [
          [1, 7, 8],
          [1, 1, 8],
        ],
      ],
    ];
    check(
      script,
      new Map([
        [g, 1],
        [h, 0],
      ])
    );
  });

  it('gives the same bytes when output twice', () => {
    const enc = adaptive(
      framed(2, [
        [
          [0, 1, 8],
          [0, 7, 8],
        ],
      ])
    );
    const first = enc.output();
    expect(enc.output()).toEqual(first);
    expect(enc.output({ type: 'text' })).toBe(
      plain(
        framed(2, [
          [
            [0, 1, 8],
            [0, 7, 8],
          ],
        ]),
        new Map([[g, 1]])
      ).output({ type: 'text' })
    );
  });

  it('weighs the selector with the symbols', () => {
    // The symbols tie, so the selector's own bucket decides.
    const tied = [0, 1].map((i): readonly Bucket[] => [
      [i, 1, 4],
      [i, 1, 4],
    ]);
    const favouring = (choices: Bucket[]): Step[] => [
      ['s', g, choices],
      ...tied.map((b): Step => ['a', g, b]),
    ];
    check(
      favouring([
        [0, 1, 4],
        [1, 3, 4],
      ]),
      new Map([[g, 1]])
    );
    check(
      favouring([
        [0, 3, 4],
        [3, 1, 4],
      ]),
      new Map([[g, 0]])
    );
    // Coding 1 saves two bits over two symbols; its selector costs 1.6 bits
    // more under one table and 2.8 under the other.
    const close = [0, 1].map((i): readonly Bucket[] => [
      [i, 1, 4],
      [i, 1, 2],
    ]);
    const racing = (choices: Bucket[]): Step[] => [
      ['s', g, choices],
      ...close.map((b): Step => ['a', g, b]),
    ];
    check(
      racing([
        [0, 3, 4],
        [3, 1, 4],
      ]),
      new Map([[g, 1]])
    );
    check(
      racing([
        [0, 7, 8],
        [7, 1, 8],
      ]),
      new Map([[g, 0]])
    );
  });

  it('spells a weighted selector as writeTable spells the same table', () => {
    const table = buildWeights([3, 1, 1, 1], 4, 'w');
    const choices = table.cums.map((cum, i): Bucket => [cum, table.freqs[i], table.total]);
    const skewed = [0, 1, 2].map((i): readonly Bucket[] => [
      [i, 1, 8],
      [i, 1, 8],
      [0, 7, 8],
      [i, 2, 8],
    ]);
    const enc = adaptive([['s', g, choices], ...skewed.map((b): Step => ['a', g, b])]);
    const direct = new Encoder();
    writeTable(direct, table, 2);
    for (const [cum, freq, total] of skewed.map((b) => b[2])) {
      direct.composeWeighted(cum, freq, total);
    }
    expect(enc.output()).toEqual(direct.output());
  });

  it('writes a weighted selector that ends the message as coding 0', () => {
    for (const choices of [
      [
        [0, 3, 6],
        [3, 1, 6],
        [4, 2, 6],
      ],
      [[0, 1, 3]],
      [
        [0, 2e12, 3e12],
        [2e12, 1e12, 3e12],
      ],
    ] as Bucket[][]) {
      check(
        [
          ['u', 3, 10],
          ['s', g, choices],
        ],
        new Map()
      );
    }
  });

  it('rejects an invalid selector', () => {
    const enc = new Encoder();
    expect(() => enc.composeSelector(null as unknown as object, uniform(2))).toThrow(
      new TypeError('Group must be an object, got null')
    );
    expect(() => enc.composeSelector(7 as unknown as object, uniform(2))).toThrow(
      new TypeError('Group must be an object, got number')
    );
    expect(() => enc.composeSelector({}, [])).toThrow(
      new RangeError('Selector needs at least one coding')
    );
    expect(() => enc.composeSelector({}, [[0, 1.5, 4]])).toThrow(
      new TypeError('Bucket must be integers, got cum 0, freq 1.5, total 4')
    );
    expect(() => enc.composeSelector({}, [[0, 1, 2 ** 53]])).toThrow(
      new RangeError(`Total ${2 ** 53} is not a positive safe integer`)
    );
    expect(() =>
      enc.composeSelector({}, [
        [0, 1, 4],
        [1, 1, 5],
      ])
    ).toThrow(new RangeError('Selector buckets share one total, got 5 after 4'));
    expect(() =>
      enc.composeSelector({}, [
        [0, 4, 4],
        [0, 1, 4],
      ])
    ).toThrow(new RangeError('Selector bucket [0, 4) holds every state'));
    const group = {};
    enc.composeSelector(group, uniform(2));
    expect(() => enc.composeSelector(group, uniform(2))).toThrow(
      new TypeError('Group already has a selector')
    );
    const single = {};
    enc.composeSelector(single, uniform(1));
    expect(() => enc.composeSelector(single, uniform(1))).toThrow(
      new TypeError('Group already has a selector')
    );
    // A selector that failed its checks leaves the group unopened.
    const failed = {};
    expect(() => enc.composeSelector(failed, [])).toThrow(RangeError);
    expect(() => enc.composeAlternatives(failed, [])).toThrow(
      new TypeError('Group has no selector')
    );
  });

  it('rejects invalid alternatives', () => {
    const error = (name: string, message: string) => expect.objectContaining({ name, message });
    const enc = new Encoder();
    enc.composeSelector(g, uniform(2));
    const ok: Bucket = [0, 1, 4];
    expect(() => enc.composeAlternatives({}, [ok, ok])).toThrow(
      error('TypeError', 'Group has no selector')
    );
    expect(() => enc.composeAlternatives(g, [ok])).toThrow(
      error('TypeError', 'Group has 2 codings, got 1 alternative buckets')
    );
    expect(() => enc.composeAlternatives(g, [ok, ok, ok])).toThrow(
      error('TypeError', 'Group has 2 codings, got 3 alternative buckets')
    );
    for (const [bucket, name, message] of [
      [[0, 1.5, 4], 'TypeError', 'Bucket must be integers, got cum 0, freq 1.5, total 4'],
      [[0, 1, 0], 'RangeError', 'Total 0 is not a positive safe integer'],
      [[0, 1, 2 ** 53], 'RangeError', `Total ${2 ** 53} is not a positive safe integer`],
      [[0, 0, 4], 'RangeError', 'Frequency 0 is not positive'],
      [[3, 2, 4], 'RangeError', 'Bucket [3, 5) is outside [0, 4)'],
      [[-1, 2, 4], 'RangeError', 'Bucket [-1, 1) is outside [0, 4)'],
      [[0, 4, 4], 'RangeError', 'Alternative bucket [0, 4) holds every state'],
    ] as const) {
      expect(() => enc.composeAlternatives(g, [ok, bucket])).toThrow(error(name, message));
      expect(() => enc.composeAlternatives(g, [bucket, ok])).toThrow(error(name, message));
    }
    // Nothing failed was recorded: the message is the selector alone.
    expect(enc.output()).toEqual(plain([['s', g, uniform(2)]], new Map()).output());
  });
});

describe('Decode limit', () => {
  const Digits = p.array(p.int().min(0).max(9));
  /** A length of `count` and nothing after it: every item reads past the input. */
  const claim = (count: number) => p.int().min(0).encode(count);
  const time = (fn: () => unknown): number => {
    const start = performance.now();
    try {
      fn();
    } catch {
      // timed either way
    }
    return performance.now() - start;
  };

  it('reads zeros past the input up to the limit, and no further', () => {
    expect(Digits.decode(claim(5000))).toEqual(Array<number>(5000).fill(0));
    expect(Digits.decode(claim(5000), { limit: Infinity })).toEqual(Array<number>(5000).fill(0));
    expect(() => Digits.decode(claim(5000), { limit: 4999 })).toThrow(
      new CorruptInputError(
        'Input decodes to more values past its end than the decode limit allows'
      )
    );
  });

  it('counts the items a length announced once the input runs out', () => {
    // The length and the first item are read while the input still backs
    // them; the items after them are not, and count as soon as it runs out.
    const Pair = p.object({ n: p.int().min(1).max(9), digits: Digits });
    const bytes = Pair.encode({ n: 7, digits: [] });
    const enc = new Encoder();
    enc.compose(6, 9);
    enc.composeTerm(4000);
    enc.compose(5, 10);
    const input = enc.output();
    const digits = [5, ...Array<number>(3999).fill(0)];
    expect(Pair.decode(input)).toEqual({ n: 7, digits });
    const reads = jest.spyOn(Decoder.prototype as unknown as { read(): void }, 'read');
    expect(() => Pair.decode(input, { limit: 3997 })).toThrow(CorruptInputError);
    // It throws on the first read past the input, not item by item.
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(reads.mock.calls.length).toBeLessThan(20);
    reads.mockRestore();
    // The empty length is a zero read past the input: one value.
    expect(Pair.decode(bytes, { limit: 1 })).toEqual({ n: 7, digits: [] });
    expect(() => Pair.decode(bytes, { limit: 0 })).toThrow(CorruptInputError);
  });

  it('throws at once on a length no input backs', () => {
    expect(time(() => p.binary().decode(claim(2 ** 40)))).toBeLessThan(1000);
    expect(() => p.binary().decode(claim(2 ** 40))).toThrow(CorruptInputError);
    expect(() => p.array(p.null()).decode(claim(2 ** 31))).toThrow(CorruptInputError);
    // Damaged bytes whose prose text runs on past the input.
    const bomb = Uint8Array.of(171, 1, 105, 182, 128, 148, 192, 161, 132, 33, 47);
    const Prose = p.versioned(p.string().prose());
    expect(time(() => Prose.decode(bomb))).toBeLessThan(1000);
    expect(() => Prose.decode(bomb)).toThrow(CorruptInputError);
  });

  it('never limits values the input backs', () => {
    const rand = mulberry32(0x11417);
    const Nonzero = p.array(p.int().min(1).max(9));
    const value = Array.from({ length: 100_000 }, () => 2 + Math.floor(rand() * 8));
    expect(Nonzero.decode(Nonzero.encode(value), { limit: 0 })).toEqual(value);
    const text = 'abcdefghij'.repeat(20_000);
    expect(p.string().decode(p.string().encode(text), { limit: 0 })).toBe(text);
  });

  it('refuses a limit that is no non-negative integer or Infinity', () => {
    expect(() => new Decoder('', { limit: -1 })).toThrow(
      new RangeError('Decode limit -1 is negative')
    );
    expect(() => new Decoder('', { limit: 1.5 })).toThrow(
      new TypeError('Decode limit must be an integer or Infinity, got 1.5')
    );
    expect(() => new Decoder('', { limit: NaN })).toThrow(TypeError);
  });
});
