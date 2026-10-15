/**
 * Words in adaptive text: where a run of letters opens, the engine spells
 * it by its letters after the word model's escape or by its token, and
 * mixes the two where both can write it. Round trips over prose whose words
 * and phrases recur, so words end in literals, matches and the value's end
 * under either spelling, and over words a mixture cannot hold.
 */

import { p, Encoder } from '../../index';
import { WordModel } from '../../nodes/words';
import { mulberry32 } from '../support';

const VOCABULARY = (
  'the of and to a in that it was he for on are as with his they at be this from have ' +
  'or by one had not but what all were when we there can an your which their said if do ' +
  'will each about how up out them then she many some so these would other into has more'
).split(' ');

/**
 * Seeded prose: words of the vocabulary, skewed toward its front, now and
 * then a fresh word, a capital, punctuation, or a phrase said before.
 */
const prose = (seed: number, words: number): string => {
  const random = mulberry32(seed);
  const said: string[] = [];
  let text = '';
  for (let i = 0; i < words; i++) {
    const roll = random();
    if (roll < 0.06 && said.length > 0) {
      text += said[Math.floor(random() * said.length)];
      continue;
    }
    let word =
      roll < 0.12
        ? Math.floor(random() * 2 ** 20).toString(36)
        : VOCABULARY[Math.floor(VOCABULARY.length * random() ** 2)];
    if (random() < 0.08) {
      word = word.charAt(0).toUpperCase() + word.slice(1);
    }
    const end = random();
    const piece = word + (end < 0.08 ? ', ' : end < 0.12 ? '. ' : end < 0.14 ? '\n' : ' ');
    if (random() < 0.05) {
      said.push(text.slice(-24) + piece);
    }
    text += piece;
  }
  return text;
};

/** The ids the decoder's word model read while `run` ran: -1 for each escape. */
const tokensRead = (run: () => void): number[] => {
  const read = jest.spyOn(WordModel.prototype, 'read');
  try {
    run();
    return read.mock.results.map(({ value }) => value as number);
  } finally {
    read.mockRestore();
  }
};

describe('p.string adaptive words', () => {
  it('round-trips prose, reading both spellings of words both can write', () => {
    const node = p.string().adaptive();
    const text = prose(1, 3000);
    const priced = jest.spyOn(Encoder.prototype, 'composePriced');
    const bytes = node.encode(text);
    expect(priced.mock.calls.length).toBeGreaterThan(500);
    priced.mockRestore();
    let back = '';
    const tokens = tokensRead(() => {
      back = node.decode(bytes);
    });
    expect(back).toBe(text);
    expect(tokens.filter((id) => id >= 0).length).toBeGreaterThan(100);
    expect(tokens.filter((id) => id < 0).length).toBeGreaterThan(100);
  });

  it.each([
    ['in an array', p.array(p.string().adaptive())],
    ['in sorted unique strings', p.array(p.string().adaptive()).unique().unordered()],
    ['under p.any', p.any().adaptive()],
  ])('round-trips words %s', (_name, node) => {
    const random = mulberry32(3);
    const values = Array.from({ length: 80 }, (_, i) =>
      prose(10 + i, 3 + Math.floor(random() * 12)).trim()
    );
    const unique = [...new Set(values)];
    const back = node.decode(node.encode(unique as never)) as string[];
    expect([...back].sort()).toEqual([...unique].sort());
  });

  it('spells a known word by its letters where one of them, or what ends it, falls to the prior', () => {
    const node = p.string().adaptive();
    const warm = prose(4, 40);
    // Each 'zyx' after the first is known; the '#' before one is new, as are
    // the 'é' and the '%' after the others, the 'é' with a tail.
    const text = `${warm} zyx and zyx #zyx zyxé zyx% zyx zyx.`;
    const priced = jest.spyOn(Encoder.prototype, 'composePriced');
    const bytes = node.encode(text);
    const thrown = priced.mock.results.filter(({ type }) => type === 'throw').length;
    priced.mockRestore();
    expect(thrown).toBeGreaterThanOrEqual(3);
    expect(node.decode(bytes)).toBe(text);
  });

  it('round-trips words a match ends, and words the value ends, under either spelling', () => {
    const node = p.string().adaptive();
    const base = prose(5, 400);
    // Phrases that recur from the middle of a word on, and values ending in a word.
    const text = `${base}${base.slice(7, 300)}abc${base.slice(40, 200)}xyz`;
    for (const value of [text, `${text} the`, `${prose(6, 200)} and`]) {
      expect(node.decode(node.encode(value))).toBe(value);
    }
  });

  it('leaves short values as they were before words learn', () => {
    // The contexts do not price until 64 characters in, and neither do words.
    const node = p.string().adaptive();
    const spy = jest.spyOn(WordModel.prototype, 'write');
    node.encode('The quick brown fox jumps over the lazy dog.');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
