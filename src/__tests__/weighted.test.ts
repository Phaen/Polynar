/**
 * The weighted (rANS) packer primitive — round-trip identity, exact f=1
 * equivalence with `compose`, block-boundary behavior under long weighted
 * runs, and corruption rejection. Seeded, so failures reproduce.
 */

import { Encoder, Decoder, CorruptInputError } from '../index';

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

  it('rejects tampering, truncation and padding on weighted payloads', () => {
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

  it('rejects invalid buckets at the source', () => {
    const enc = new Encoder();
    expect(() => enc.composeWeighted(0, 0, 4)).toThrow(TypeError);
    expect(() => enc.composeWeighted(-1, 2, 4)).toThrow(RangeError);
    expect(() => enc.composeWeighted(3, 2, 4)).toThrow(RangeError);
    expect(() => enc.composeWeighted(0, 1, 0)).toThrow(TypeError);
    expect(() => enc.composeWeighted(0, 1, 2 ** 54)).toThrow(TypeError);
  });
});
