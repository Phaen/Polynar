/**
 * A value with two spellings, each a choice under a prior of 1/2 and the
 * value under that choice's model, mixed by `composeMixture` with the
 * posterior as its weights: the message costs −log2 of the sum of the
 * spellings' probabilities per value, where spelling the likelier one
 * costs −log2 of the larger. Seeded, so the figures reproduce.
 */

import { Decoder, Encoder } from '../packer';
import { mulberry32 } from './support';

const SYMBOLS = 256;
/** The scale the posterior is rounded to. */
const SCALE = 2 ** 20;

/** A model of the symbols: integer freqs, their cums and total. */
interface Model {
  readonly freqs: readonly number[];
  readonly cums: readonly number[];
  readonly total: number;
}

const modelOf = (weight: (s: number) => number): Model => {
  const freqs = Array.from({ length: SYMBOLS }, (_, s) => Math.max(1, Math.round(weight(s))));
  const cums: number[] = [];
  let total = 0;
  for (const freq of freqs) {
    cums.push(total);
    total += freq;
  }
  return { freqs, cums, total };
};

const locate =
  ({ freqs, cums }: Model) =>
  (residual: number): readonly [number, number, number] => {
    let lo = 0;
    let hi = SYMBOLS - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cums[mid] + freqs[mid] > residual) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return [lo, cums[lo], freqs[lo]];
  };

/** Low symbols likely under one model, high under the other, so most values are likely under both. */
const MODELS = [
  modelOf((s) => 1000 * Math.exp(-s / 200)),
  modelOf((s) => 1000 * Math.exp(-(SYMBOLS - 1 - s) / 200)),
];

/** The probability of spelling `value` as choice j: 1/2 for the choice, then the value under its model. */
const spellingProbability = (j: number, value: number): number =>
  MODELS[j].freqs[value] / MODELS[j].total / 2;

/** The posterior over the choices given `value`, rounded to integer weights. */
const posterior = (value: number): number[] => {
  const p = [spellingProbability(0, value), spellingProbability(1, value)];
  const sum = p[0] + p[1];
  return p.map((q) => Math.max(1, Math.round((q / sum) * SCALE)));
};

/** Values drawn from the half-and-half mixture of the models. */
const draw = (count: number, seed: number): number[] => {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => {
    const model = MODELS[rand() < 0.5 ? 0 : 1];
    return locate(model)(Math.floor(rand() * model.total))[0];
  });
};

const writeValue = (enc: Encoder, value: number): void => {
  enc.composeMixture(posterior(value), (j) => {
    enc.composeWeighted(j, 1, 2);
    enc.composeWeighted(MODELS[j].cums[value], MODELS[j].freqs[value], MODELS[j].total);
  });
};

const readValue = (dec: Decoder): number => {
  const j = dec.parseWeighted(2, (r) => [r, r, 1]);
  const value = dec.parseWeighted(MODELS[j].total, locate(MODELS[j]));
  dec.parseMixture(posterior(value), j);
  return value;
};

/** The bits `values` take mixed, ideally, and spelled by the likelier choice. */
const measure = (values: readonly number[]) => {
  const enc = new Encoder();
  values.forEach((value) => writeValue(enc, value));
  const bytes = enc.output();
  const dec = new Decoder(bytes);
  expect(values.map(() => readValue(dec))).toEqual(values);
  dec.finalize();
  let ideal = 0;
  let likelier = 0;
  for (const value of values) {
    const p = [spellingProbability(0, value), spellingProbability(1, value)];
    ideal -= Math.log2(p[0] + p[1]);
    likelier -= Math.log2(Math.max(p[0], p[1]));
  }
  return { realised: bytes.length * 8, ideal, likelier };
};

describe('a value mixed over two spellings', () => {
  it('costs −log2 of the sum of their probabilities, not of the larger', () => {
    const { realised, ideal, likelier } = measure(draw(20000, 0x5eed));
    // About half a bit per value apart.
    expect(likelier - ideal).toBeGreaterThan(0.4 * 20000);
    // Within a byte of padding and a few bits per thousand values of the ideal.
    expect(realised - ideal).toBeLessThan(0.002 * ideal + 8);
    expect(realised - ideal).toBeGreaterThan(-8);
  });

  it('gives back at most the bits on the state at the end of a short message', () => {
    for (const count of [1, 2, 4, 16, 64]) {
      const { realised, ideal, likelier } = measure(draw(count, count));
      // The fold starts from an empty state, so the last values get little
      // back; never more than spelling every value by the likelier choice.
      expect(realised).toBeLessThanOrEqual(Math.ceil(likelier / 8) * 8 + 8);
      expect(realised).toBeGreaterThanOrEqual(Math.floor(ideal / 8) * 8 - 8);
    }
  });
});
