/**
 * The word model: the weights of two spellings of a word, the token that
 * names a learned word or the escape, round trips of seeded streams with
 * both sides learning alike, the prices `units` reports against what
 * `write` charges and the weights `mixture` gives from them, the halving of the counts and the caps on the words, the
 * recent counts favouring a word used lately, the clamped share of the
 * tokens, and the journal taking a transaction's learning back.
 */

import { Decoder, Encoder } from '../../packer';
import { mixWeights, WordModel } from '../../nodes/words';
import { mulberry32 } from '../support';

const UNITS = 2 ** 20;

describe('mixWeights', () => {
  it('weighs equal costs equally', () => {
    expect(mixWeights(0, 0)).toEqual([65536, 65536]);
  });

  it('halves the dearer weight per bit of difference, whichever is dearer', () => {
    expect(mixWeights(0, UNITS)).toEqual([65536, 32768]);
    expect(mixWeights(UNITS, 0)).toEqual([32768, 65536]);
  });

  it('resolves a fraction of a bit', () => {
    expect(mixWeights(0, UNITS / 2)).toEqual([65536, Math.round(2 ** (16 - 0.5))]);
  });

  it('keeps the dearer weight at 1 at the least, however large the difference', () => {
    expect(mixWeights(0, 2 ** 40)).toEqual([65536, 1]);
    expect(mixWeights(2 ** 40, 0)).toEqual([1, 65536]);
  });
});

/** A learned run, as the item before it and its letters. */
type Pair = readonly [prev: number, word: string];

const VOCABULARY = ['', 'a', 'bb', 'the', 'quick', 'fox', 'jumps', 'over', 'lazy', 'dog'];

/** A seeded stream of pairs: skewed toward the first words, now and then a fresh one. */
const stream = (seed: number, length: number): Pair[] => {
  const random = mulberry32(seed);
  const prevs = [-1, 0, 1, 2, 5];
  return Array.from({ length }, (_, i) => {
    const prev = prevs[Math.floor(random() * prevs.length)];
    const word =
      random() < 0.1 ? `new${i}` : VOCABULARY[Math.floor(random() ** 2 * VOCABULARY.length)];
    return [prev, word] as const;
  });
};

/** What both sides learn after a token: no weights, or a pair favouring either spelling. */
const weightsFor = (random: () => number): readonly [number, number] | undefined => {
  const mode = random();
  const w = 1 + Math.floor(random() * 65536);
  return mode < 0.4 ? undefined : mode < 0.7 ? [65536, w] : [w, 65536];
};

/** Writes each pair's token, checks its price, and learns the pair. */
const writeAll = (model: WordModel, enc: Encoder, pairs: readonly Pair[], seed: number): void => {
  const random = mulberry32(seed);
  for (const [prev, word] of pairs) {
    const id = model.id(enc, word);
    const token = word === '' ? -1 : id;
    const units = model.units(enc, prev, token);
    if (id !== -1) {
      expect(model.mixture(enc, prev, 12345, id)).toEqual(
        mixWeights(model.units(enc, prev, -1) + 12345, units)
      );
    }
    const mark = enc.mark();
    model.write(enc, prev, token);
    expect(Math.round(enc.bitsSince(mark) * UNITS)).toBe(units);
    enc.commit(mark);
    model.learn(enc, prev, word, id === -1 ? undefined : weightsFor(random));
  }
};

/** Reads each pair's token back, expects it, and learns the pair as `writeAll` did. */
const readAll = (model: WordModel, dec: Decoder, pairs: readonly Pair[], seed: number): void => {
  const random = mulberry32(seed);
  for (const [prev, word] of pairs) {
    const id = model.read(dec, prev);
    const known = model.id(dec, word);
    expect(id).toBe(word === '' ? -1 : known);
    if (id !== -1) {
      expect(model.word(dec, id)).toBe(word);
    }
    model.learn(dec, prev, word, known === -1 ? undefined : weightsFor(random));
  }
};

/** Both sides learn `before`, then `after` goes through as tokens and comes back. */
const roundTrip = (before: readonly Pair[], after: readonly Pair[]): void => {
  const model = new WordModel();
  const enc = new Encoder();
  for (const [prev, word] of before) {
    model.learn(enc, prev, word);
  }
  writeAll(model, enc, after, 7);
  const dec = new Decoder(enc.output());
  for (const [prev, word] of before) {
    model.learn(dec, prev, word);
  }
  readAll(model, dec, after, 7);
  dec.finalize();
};

describe('WordModel', () => {
  it('round-trips seeded streams, one model serving both sides', () => {
    for (const seed of [1, 2, 3]) {
      roundTrip([], stream(seed, 400));
    }
  });

  it('writes and reads nothing, and prices nothing, before a word is learned', () => {
    const model = new WordModel();
    const enc = new Encoder();
    model.write(enc, 0, -1);
    expect(enc.events().totals).toHaveLength(0);
    expect(model.units(enc, 0, -1)).toBe(0);
    expect(model.units(enc, 0, 0)).toBe(0);
    expect(model.mixture(enc, 0, 7, 0)).toEqual(mixWeights(7, 0));
    expect(model.id(enc, 'a')).toBe(-1);
    const dec = new Decoder(new Encoder().output());
    expect(model.read(dec, 0)).toBe(-1);
  });

  describe('halving and caps', () => {
    it('keeps coding after a context passes its limit', () => {
      const before: Pair[] = Array.from({ length: 5000 }, () => [0, 'a'] as const);
      roundTrip(before, [
        [0, 'a'],
        [0, ''],
        [0, 'b'],
        [0, 'a'],
      ]);
      const model = new WordModel();
      const enc = new Encoder();
      before.forEach(([prev, word]) => model.learn(enc, prev, word));
      const units = model.units(enc, 0, 0);
      expect(Number.isFinite(units)).toBe(true);
      expect(units).toBeGreaterThan(0);
    });

    it('keeps coding after the word counts pass their limit', () => {
      const words = Array.from({ length: 50 }, (_, i) => `w${i}`);
      const before: Pair[] = Array.from({ length: 70000 }, (_, i) => [0, words[i % 50]] as const);
      roundTrip(before, [
        [0, 'w3'],
        [0, 'w49'],
        [1, 'fresh'],
        [0, 'w0'],
      ]);
    });

    it('halves a run cell, so a long run of empty words stays cheap to escape', () => {
      const model = new WordModel();
      const enc = new Encoder();
      model.learn(enc, 0, 'a');
      for (let i = 0; i < 300; i++) {
        model.learn(enc, 7, '');
      }
      expect(model.units(enc, 7, -1)).toBeLessThan(model.units(enc, 8, -1));
    });

    it('learns no more than 65536 distinct words', () => {
      const model = new WordModel();
      const enc = new Encoder();
      const word = (i: number): string => `w${i.toString(36)}`;
      for (let i = 0; i <= 1 << 16; i++) {
        model.learn(enc, 0, word(i));
      }
      expect(model.id(enc, word(0))).toBe(0);
      expect(model.id(enc, word((1 << 16) - 1))).toBe((1 << 16) - 1);
      expect(model.id(enc, word(1 << 16))).toBe(-1);
    });
  });

  describe('the recent counts', () => {
    /** Learns `word` then 'z', `times` over. */
    const pairs = (model: WordModel, enc: Encoder, word: string, times: number): void => {
      for (let i = 0; i < times; i++) {
        model.learn(enc, 0, word);
        model.learn(enc, 0, 'z');
      }
    };

    it('prices a word used lately below one used as often long before', () => {
      const model = new WordModel();
      const enc = new Encoder();
      pairs(model, enc, 'x', 20);
      for (let i = 0; i < 600; i++) {
        model.learn(enc, 0, i % 2 === 0 ? 'f' : 'g');
      }
      // 'x' and 'y' each occurred 20 times, 19 of them after 'z', the last word.
      pairs(model, enc, 'y', 20);
      const x = model.id(enc, 'x');
      const y = model.id(enc, 'y');
      expect(model.units(enc, 0, y)).toBeLessThan(model.units(enc, 0, x));
    });
  });

  describe('the share of the tokens', () => {
    /** A model that learned 'a' twice, then `weights` `times` over. */
    const shared = (weights: readonly [number, number], times: number) => {
      const model = new WordModel();
      const enc = new Encoder();
      model.learn(enc, 0, 'a');
      model.learn(enc, 0, 'a');
      for (let i = 0; i < times; i++) {
        model.learn(enc, 0, 'a', weights);
      }
      return { model, enc };
    };

    /** The escape's cost after one more learn of 'a', with `weights` or without. */
    const next = (
      state: ReturnType<typeof shared>,
      weights?: readonly [number, number]
    ): number => {
      state.model.learn(state.enc, 0, 'a', weights);
      return state.model.units(state.enc, 0, -1);
    };

    it('stops rising under weights favouring the token once it reaches its maximum', () => {
      expect(next(shared([1, 65536], 5), [1, 65536])).not.toBe(next(shared([1, 65536], 5)));
      expect(next(shared([1, 65536], 200), [1, 65536])).toBe(next(shared([1, 65536], 200)));
    });

    it('stops falling under weights favouring the letters once it reaches its minimum', () => {
      expect(next(shared([65536, 1], 5), [65536, 1])).not.toBe(next(shared([65536, 1], 5)));
      expect(next(shared([65536, 1], 200), [65536, 1])).toBe(next(shared([65536, 1], 200)));
    });

    it('leaves the escape dearer at the maximum share than at the minimum', () => {
      const high = shared([1, 65536], 200);
      const low = shared([65536, 1], 200);
      expect(high.model.units(high.enc, 0, -1)).toBeGreaterThan(low.model.units(low.enc, 0, -1));
    });
  });

  describe('journal', () => {
    it('takes back what a transaction learned', () => {
      const model = new WordModel();
      const enc = new Encoder();
      // The context of 'a' holds 4096, its limit; the cell of item 3 sums to 256, its limit.
      model.learn(enc, 0, 'b');
      for (let i = 0; i < 4097; i++) {
        model.learn(enc, 0, 'a');
      }
      for (let i = 0; i < 127; i++) {
        model.learn(enc, 3, '');
      }
      const probes: [number, number][] = [];
      for (const prev of [0, 3, 9]) {
        for (const id of [-1, 0, 1]) {
          probes.push([prev, id]);
        }
      }
      const read = () => ({
        units: probes.map(([prev, id]) => model.units(enc, prev, id)),
        ids: ['b', 'a', 'c', 'd'].map((word) => model.id(enc, word)),
      });
      const before = read();
      const mark = enc.mark();
      model.learn(enc, 0, 'a');
      model.learn(enc, 0, 'a');
      model.learn(enc, 0, 'c');
      model.learn(enc, 3, '');
      model.learn(enc, 11, 'd', [1, 65536]);
      model.learn(enc, 11, 'a', [65536, 1]);
      expect(model.id(enc, 'c')).toBe(2);
      expect(read()).not.toEqual(before);
      enc.rollback(mark);
      expect(read()).toEqual(before);
      expect(model.id(enc, 'c')).toBe(-1);
    });
  });
});
