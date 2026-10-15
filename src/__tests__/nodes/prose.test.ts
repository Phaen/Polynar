/**
 * The prose model internals behind `p.string().prose()`: the English weight
 * rules, the compiled table and model building.
 */

import { ProseModels, buildProseModel } from '../../index';
import {
  baseWeight,
  contextMultiplier,
  englishWeights,
  compileProse,
  proseContext,
} from '../../nodes/prose';

const english = compileProse(ProseModels.english);

describe('baseWeight', () => {
  it.each([
    [' ', 1600],
    ['e', 999],
    ['E', 1],
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
    // Capitals are not modeled.
    ['T', 'H', 1],
    // Word-initial: the first-letter rate over the running rate.
    [' ', 't', 1600 / 742],
    [' ', 'T', 1],
    ['\n', ' ', 1 / 8],
    ['a', 'B', 1],
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
