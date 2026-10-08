/**
 * The weighted (rANS) packer primitive — round-trip identity, exact f=1
 * equivalence with `compose`, block-boundary behavior under long weighted
 * runs, and corruption rejection. Seeded, so failures reproduce.
 */

import { Encoder, Decoder, CorruptInputError, p } from '../index';

const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(0xa15eed);
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

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

describe('Weighted packer primitive', () => {
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

      const bytes = enc.toUint8Array();
      const dec = new Decoder(bytes);
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

  it('is byte-identical to compose when every frequency is one', () => {
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
      expect(weighted.toUint8Array()).toEqual(uniform.toUint8Array());

      const dec = new Decoder(uniform.toUint8Array());
      for (const [value, radix] of values) {
        expect(dec.parseWeighted(radix, (r) => [r, r, 1])).toBe(value);
      }
      dec.finalize();
    }
  });

  it('spends fewer bytes on likelier symbols', () => {
    // 1000 draws of the heavy symbol (f=15 of 16) should cost ~93 bits;
    // uniform base-16 slots would cost 4000.
    const heavy = new Encoder();
    const flat = new Encoder();
    for (let i = 0; i < 1000; i++) {
      heavy.composeWeighted(0, 15, 16);
      flat.compose(0, 16);
    }
    expect(heavy.toUint8Array().length).toBeLessThan(20);
    expect(flat.toUint8Array().length).toBeGreaterThan(490);
  });

  it('survives block boundaries under long weighted runs', () => {
    // Enough state to cross several 2048-bit blocks, with freqs that make
    // the true bound and the freq-blind boundary rule diverge.
    const dist = randDistribution(8);
    const enc = new Encoder();
    const symbols: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const symbol = randInt(0, 7);
      enc.composeWeighted(dist.cums[symbol], dist.freqs[symbol], dist.total);
      symbols.push(symbol);
    }
    const bytes = enc.toUint8Array();
    const dec = new Decoder(bytes);
    for (const symbol of symbols) {
      expect(dec.parseWeighted(dist.total, locateIn(dist))).toBe(symbol);
    }
    dec.finalize();
  });

  it('rejects corruption, truncation and padding on weighted payloads', () => {
    const dist = randDistribution(16);
    for (let run = 0; run < 100; run++) {
      const enc = new Encoder();
      const symbols = Array.from({ length: randInt(5, 200) }, () => randInt(0, 15));
      for (const s of symbols) {
        enc.composeWeighted(dist.cums[s], dist.freqs[s], dist.total);
      }
      const bytes = enc.toUint8Array();

      const decodeAll = (input: Uint8Array): number[] => {
        const dec = new Decoder(input);
        const out = symbols.map(() => dec.parseWeighted(dist.total, locateIn(dist)));
        dec.finalize();
        return out;
      };

      // Tampered: one byte substituted. Either it throws, or what it decodes
      // to must re-encode to exactly the mutated bytes (canonical closure).
      const at = randInt(0, bytes.length - 1);
      const mutated = Uint8Array.from(bytes);
      mutated[at] = (mutated[at] + randInt(1, 255)) % 256;
      let decoded: number[] | undefined;
      try {
        decoded = decodeAll(mutated);
      } catch (e) {
        expect(e).toBeInstanceOf(CorruptInputError);
      }
      if (decoded !== undefined) {
        const re = new Encoder();
        for (const s of decoded) {
          re.composeWeighted(dist.cums[s], dist.freqs[s], dist.total);
        }
        expect(re.toUint8Array()).toEqual(mutated);
      }

      if (bytes.length > 0) {
        expect(() => decodeAll(bytes.slice(0, bytes.length - 1))).toThrow(CorruptInputError);
      }
      expect(() => decodeAll(Uint8Array.of(...bytes, 0))).toThrow(CorruptInputError);
    }
  });

  it('pays the freq-blind slack once per block, not once per symbol', () => {
    // A run of the likely symbol (f = 99 of 100) shares log2(100/99) bits
    // per draw. The digit count is that sum plus the slack of the one
    // candidate with the most of it, under log2(2·total), however long the
    // run: the run of 1000 costs 14.5 bits of shares, the run of 10 none
    // to speak of, so they sit within log2(200) + 1 of their shares.
    const bits = (n: number): number => {
      const enc = new Encoder();
      for (let i = 0; i < n; i++) {
        enc.composeWeighted(1, 99, 100, 1, 2);
      }
      return enc.toString('01').length;
    };
    const share = (n: number): number => n * Math.log2(100 / 99);
    for (const n of [2, 10, 100, 1000]) {
      expect(bits(n)).toBeLessThanOrEqual(Math.ceil(share(n) + Math.log2(200)) + 1);
    }
    expect(bits(1000) - bits(10)).toBeLessThanOrEqual(Math.ceil(share(1000) - share(10)) + 1);
  });

  it('rejects a likely run padded to the digits its per-symbol slack would need', () => {
    const node = p.array(p.bool().weights([1, 99])).length(100);
    const text = node.encodeString(Array(100).fill(true), '01');
    expect(text).toHaveLength(9);
    expect(node.decodeString(text, '01')).toEqual(Array(100).fill(true));
    for (const padding of ['0', '000000']) {
      expect(() => node.decodeString(text + padding, '01')).toThrow(CorruptInputError);
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
});

describe('Indexed last symbol', () => {
  // Four members, weight k each: a bucket needs log2(4k) bits of state, the
  // index two. Nothing follows the message's last symbol to fill the rest.
  const four = (k: number) => ({ cums: [0, k, 2 * k, 3 * k], freqs: [k, k, k, k], total: 4 * k });
  const atIndexIn = (d: Distribution) => (i: number) => [i, d.cums[i], d.freqs[i]] as const;

  it('writes a lone weighted value as its index, whatever the total', () => {
    for (const k of [1, 1000, 1e6, 1e12]) {
      const dist = four(k);
      for (let s = 0; s < 4; s++) {
        const enc = new Encoder();
        enc.compose(5, 7);
        enc.composeWeighted(dist.cums[s], dist.freqs[s], dist.total, s, 4);
        const bytes = enc.toUint8Array();
        expect(bytes.length).toBe(1);
        const dec = new Decoder(bytes);
        expect(dec.parse(7)).toBe(5);
        expect(dec.parseWeighted(dist.total, locateIn(dist), 4, atIndexIn(dist))).toBe(s);
        dec.finalize();
      }
    }
  });

  it('keeps the bucket form when the digits hold it anyway', () => {
    // Base 65536: both forms fit one digit, so the bytes equal the plain call.
    const dist = four(1000);
    const plain = new Encoder();
    plain.composeWeighted(dist.cums[2], dist.freqs[2], dist.total);
    const indexed = new Encoder();
    indexed.composeWeighted(dist.cums[2], dist.freqs[2], dist.total, 2, 4);
    expect(indexed.toString([0, 65535])).toBe(plain.toString([0, 65535]));
  });

  it('is unchanged when the member count reaches the total', () => {
    for (let run = 0; run < 50; run++) {
      const dist = randDistribution(randInt(2, 8));
      const plain = new Encoder();
      const counted = new Encoder();
      for (let i = 0; i < randInt(1, 30); i++) {
        const s = randInt(0, dist.cums.length - 1);
        plain.composeWeighted(dist.cums[s], dist.freqs[s], dist.total);
        counted.composeWeighted(dist.cums[s], dist.freqs[s], dist.total, s, dist.total + run);
      }
      expect(counted.toUint8Array()).toEqual(plain.toUint8Array());
    }
  });

  it('rejects padding, truncation and reading past an indexed tail', () => {
    const dist = four(1e12);
    const enc = new Encoder();
    for (let i = 0; i < 20; i++) {
      enc.compose(i % 3, 3);
    }
    enc.composeWeighted(dist.cums[3], dist.freqs[3], dist.total, 3, 4);
    const bytes = enc.toUint8Array();
    expect(bytes.length).toBe(5);

    const readAll = (input: Uint8Array, extra = false) => {
      const dec = new Decoder(input);
      for (let i = 0; i < 20; i++) {
        dec.parse(3);
      }
      dec.parseWeighted(dist.total, locateIn(dist), 4, atIndexIn(dist));
      if (extra) {
        dec.parse(2);
      }
      dec.finalize();
    };
    readAll(bytes);
    expect(() => readAll(bytes, true)).toThrow(CorruptInputError);
    expect(() => readAll(bytes.subarray(0, 4))).toThrow(CorruptInputError);
    expect(() => readAll(Uint8Array.of(...bytes, 0))).toThrow(CorruptInputError);
    // Padded to where the bucket form fits: the digit count gives it away.
    expect(() => readAll(Uint8Array.of(...bytes, 0, 0))).toThrow(CorruptInputError);
  });

  it('reads a single-value tail that opens a block of its own', () => {
    // A full block of 256 bytes, then a value with one member: its index
    // takes no digits, so the new block it opens is empty.
    const node = p.object({
      a: p.array(p.int().min(0).max(255)).length(256),
      b: p.int().min(7).max(7).weights([5]),
    });
    const value = { a: Array.from({ length: 256 }, (_, i) => i), b: 7 };
    const bytes = node.encode(value);
    expect(bytes.length).toBe(256);
    expect(node.decode(bytes)).toEqual(value);
    expect(() => node.decode(Uint8Array.of(...bytes, 0))).toThrow(CorruptInputError);
  });

  it('keeps the index form when a constant field ends the message', () => {
    const shape = { a: p.int().min(0).max(1000), flag: p.bool().weights([1, 99]) };
    const bits = p.object(shape).encodeString({ a: 500, flag: true }, '01').length;
    const node = p.object({ ...shape, c: p.enum(['v1']) });
    const value = { a: 500, flag: true, c: 'v1' as const };
    const text = node.encodeString(value, '01');
    expect(text.length).toBe(bits);
    expect(node.decodeString(text, '01')).toEqual(value);
  });

  it('rejects an index that points at a value with no weight', () => {
    // Weights 500, 0, 1 over 0..2: the total needs two bytes as a bucket,
    // so a lone value goes out as its index in one.
    const cdf = (v: number) => [0, 500, 500, 501][v];
    const node = p.int().min(0).max(2).cdf(cdf);
    expect(node.encode(2)).toEqual(Uint8Array.of(2));
    expect(node.decode(Uint8Array.of(2))).toBe(2);
    expect(() => node.decode(Uint8Array.of(1))).toThrow(CorruptInputError);
  });
});
