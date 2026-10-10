/**
 * The prose model internals behind `p.string().prose()`: the English weight
 * rules, context rows and the per-code-point coding.
 */

import { Encoder, Decoder, ProseModels, buildProseModel } from '../../index';
import {
  baseWeight,
  contextMultiplier,
  englishWeights,
  compileProse,
  proseContext,
  contextRow,
  composeProsePoint,
  parseProsePoint,
} from '../../nodes/prose';

const english = compileProse(ProseModels.english);

describe('baseWeight', () => {
  it.each([
    [' ', 1600],
    ['e', 999],
    ['E', 33],
    ['Z', 1],
    ['9', 3],
    ['~', 1],
    ['é', 1],
    ['İ', 1],
  ])('weighs %j as %p', (ch, weight) => {
    expect(baseWeight(ch)).toBe(weight);
  });

  it.each(['', 'th', 'constructor', '👋'])('rejects %j', (ch) => {
    expect(() => baseWeight(ch)).toThrow(
      new RangeError(`baseWeight expected a single character, got ${JSON.stringify(ch)}`)
    );
  });
});

describe('contextMultiplier', () => {
  it.each([
    ['q', 'u', 400],
    ['t', 'h', 12],
    ['T', 'H', 12 / 8],
    // Word-initial: the first-letter rate over the running rate, sentence case.
    [' ', 't', 1600 / 742],
    [' ', 'T', (1600 / 742) * 15],
    ['\n', ' ', 1 / 8],
    // A capital inside a word, after a vowel.
    ['a', 'B', 1.7 / 8],
    ['b', 'c', 1 / 3],
    ['.', ' ', 12],
    [',', 'a', 1 / 3],
    ['1', '2', 10],
    ['1', 'x', 1 / 3],
    ['q', 'a', 1.7 / 20],
    ['~', '~', 1],
  ])('rates %j then %j at %p', (prev, next, m) => {
    expect(contextMultiplier(prev, next)).toBeCloseTo(m, 12);
  });

  it.each([
    ['', 'a'],
    ['a', ''],
    ['ab', 'c'],
    ['a', '__proto__'],
  ])('rejects %j then %j', (prev, next) => {
    expect(() => contextMultiplier(prev, next)).toThrow(
      new RangeError(
        `contextMultiplier expected single characters, got ${JSON.stringify(prev)} and ${JSON.stringify(next)}`
      )
    );
  });
});

describe('englishWeights', () => {
  it('builds a frozen square of positive integers with the escape column last', () => {
    const rows = englishWeights();
    const size = ProseModels.english.alphabet.length;
    expect(rows).toHaveLength(size + 1);
    for (const row of rows) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(row).toHaveLength(size + 1);
      expect(row.every((w) => Number.isInteger(w) && w >= 1)).toBe(true);
    }
    expect(rows.map((row) => row[size])).toEqual([...Array(size).fill(30), 1200]);
    expect(rows).toEqual(ProseModels.english.weights);
  });
});

describe('proseContext', () => {
  it('maps a modeled code point to its row and anything else to the escape row', () => {
    expect(proseContext(english, 'e'.codePointAt(0)!)).toBe(
      ProseModels.english.alphabet.indexOf('e')
    );
    for (const code of [0x10ffff, 0xe9, -1, 0.5, NaN, Infinity]) {
      expect(proseContext(english, code)).toBe(english.escape);
    }
  });
});

describe('contextRow', () => {
  it('returns the first and last rows', () => {
    expect(contextRow(english, 0)).toBe(english.rows[0]);
    expect(contextRow(english, english.escape)).toBe(english.rows[english.escape]);
  });

  it.each([-1, 0.5, NaN, Infinity, 98, 99])('rejects the context %p', (ctx) => {
    expect(() => contextRow(english, ctx)).toThrow(
      new RangeError(`Prose context ${ctx} is not a row of the model (0–${english.escape})`)
    );
  });
});

describe('composeProsePoint', () => {
  it('round-trips modeled and escaped code points in any row', () => {
    const codes = ['e', ' ', '~', 'é', '👋', '\ud800'].map((ch) => ch.codePointAt(0)!);
    const enc = new Encoder();
    let ctx = english.start;
    for (const code of codes) {
      composeProsePoint(enc, english, code, ctx);
      ctx = proseContext(english, code);
    }
    composeProsePoint(enc, english, 0x10ffff, english.escape);
    const dec = new Decoder(enc.output());
    ctx = english.start;
    for (const code of codes) {
      expect(parseProsePoint(dec, english, ctx)).toBe(code);
      ctx = proseContext(english, code);
    }
    expect(parseProsePoint(dec, english, english.escape)).toBe(0x10ffff);
  });

  it.each([-1, 0.5, NaN, english.escape + 1])('rejects the context %p', (ctx) => {
    const message = `Prose context ${ctx} is not a row of the model (0–${english.escape})`;
    expect(() => composeProsePoint(new Encoder(), english, 101, ctx)).toThrow(
      new RangeError(message)
    );
    expect(() => parseProsePoint(new Decoder(new Uint8Array([1])), english, ctx)).toThrow(
      new RangeError(message)
    );
  });

  it.each([0x110000, -1])('rejects the code point %p', (code) => {
    expect(() => composeProsePoint(new Encoder(), english, code, english.start)).toThrow(
      new RangeError(`Code point ${code} is outside 0–0x10FFFF`)
    );
  });
});

describe('buildProseModel', () => {
  it('rejects an alphabet with a repeated character', () => {
    expect(() => buildProseModel('abc', { alphabet: 'aba' })).toThrow(
      new RangeError('buildProseModel alphabet must be free of duplicates')
    );
  });

  it.each([NaN, Infinity, 1.5, -1])('rejects the minCount %p', (minCount) => {
    expect(() => buildProseModel('aa', { minCount })).toThrow(
      new RangeError(`buildProseModel minCount must be a positive integer, got ${minCount}`)
    );
  });

  it('builds a model from an empty corpus with an explicit alphabet', () => {
    expect(buildProseModel('', { alphabet: 'a' })).toEqual({
      alphabet: 'a',
      weights: [
        [1, 1],
        [1, 1],
      ],
    });
  });
});
