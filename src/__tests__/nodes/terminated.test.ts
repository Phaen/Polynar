/**
 * `.terminated()` and the learned choice of it: no length prefix, the end
 * of a value one more symbol after its items instead, under every spelling
 * of text and buffers, within the bounds.
 */

import { p, CorruptInputError } from '../../index';
import type { AnyValue, PNode } from '../../index';
import { EndChoice } from '../../nodes/sequence';
import { mulberry32, trip } from '../support';

const rand = mulberry32(0xe4d);
const below = (n: number): number => Math.floor(rand() * n);

const WORDS = ['the', 'cat', 'sat', 'on', 'mat', 'issues', 'com', 'x', 'Zeta', 'éü', '😀'];
const JOINS = [' ', '/', '.', '-', '', ', '];

/** A string of a few words and joins, `.com/` ones among them. */
const text = (): string => {
  let s = '';
  for (let n = below(6); n > 0; n--) {
    s += WORDS[below(WORDS.length)] + JOINS[below(JOINS.length)];
  }
  return s;
};

const texts = (n: number): string[] => Array.from({ length: n }, text);

/** URLs of varying length that end alike, with a number in each. */
const urls = (n: number): string[] =>
  Array.from(
    { length: n },
    (_, i) => `https://api.example.com/${WORDS[i % 6]}/${(i * 7919) % 100000}/comments`
  );

describe('terminated', () => {
  it.each([
    ['p.string()', p.string().terminated(), texts(30)],
    [
      'a charset',
      p.string().charset('abcdefghijklmnopqrstuvwxyz ').terminated(),
      ['', 'ab', 'a b c'],
    ],
    ['prose', p.string().prose().terminated(), ['Hello World', 'USER_NOT_FOUND', 'x', '']],
    ['repeats', p.string().repeats().terminated(), ['abcabcabcabc', 'abcabcabcabcabc', '']],
    ['recall', p.string().recall().terminated(), ['a', 'bb', 'a', '']],
    ['adaptive', p.string().adaptive().terminated(), texts(60)],
    ['adaptive urls', p.string().adaptive().terminated(), urls(120)],
    ['adaptive delta', p.string().adaptive().delta().terminated(), urls(40)],
    [
      'adaptive bounds',
      p.string().min(2).max(12).adaptive().terminated(),
      ['ab', 'abcdefghijkl', 'abc', 'abcdefghijkl', 'abcdefghijkl'],
    ],
    ['bounds', p.string().min(1).max(3).terminated(), ['a', 'abc', 'ab', '😀a']],
  ])('round-trips under %s', (_name, node: PNode<string>, values: string[]) => {
    const many = p.array(node);
    expect(trip(many, values)).toEqual(values);
  });

  it('round-trips buffers, ending only after a whole element', () => {
    const words = [new Uint16Array([1, 2, 515]), new Uint16Array([]), new Uint16Array([7])];
    expect(trip(p.array(p.binary(Uint16Array).terminated()), words)).toEqual(words);
    const bytes = texts(30).map((s) => new Uint8Array(Buffer.from(s)));
    expect(trip(p.array(p.binary().adaptive().terminated()), bytes)).toEqual(bytes);
  });

  it('writes nothing for a fixed length', () => {
    const fixed = p.string().length(5);
    expect(fixed.terminated().encode('abcde')).toEqual(fixed.encode('abcde'));
  });

  it('holds the bounds', () => {
    expect(() => p.string().max(3).terminated().encode('abcd')).toThrow(
      new RangeError('String length 4 is above the maximum 3')
    );
    expect(() => p.string().min(2).terminated().encode('a')).toThrow(
      new RangeError('String length 1 is below the minimum 2')
    );
  });

  it('refuses what reads the length, and a second declaration', () => {
    expect(() => p.string().digits().terminated()).toThrow(
      new TypeError(
        'p.string terminated cannot combine with digits or positional, which read the length'
      )
    );
    expect(() => p.string().terminated().positional()).toThrow(TypeError);
    expect(() => p.string().max(3).weights([1, 1, 1, 1]).terminated()).toThrow(
      new TypeError('p.string terminated has no length for a cdf or weights to weigh')
    );
    expect(() =>
      p
        .binary()
        .max(2)
        .terminated()
        .cdf((n) => n)
    ).toThrow(TypeError);
    expect(() => p.string().terminated().terminated()).toThrow(
      new TypeError('p.string terminated is already set')
    );
    expect(() => p.binary().terminated().terminated()).toThrow(
      new TypeError('p.binary terminated is already set')
    );
  });
});

describe('the learned end', () => {
  it('spells the end where it costs less than the lengths', () => {
    const open = jest.spyOn(EndChoice.prototype, 'open');
    try {
      const values = urls(80);
      expect(trip(p.array(p.string().adaptive()), values)).toEqual(values);
      expect(open.mock.results.some(({ value }) => value === true)).toBe(true);
    } finally {
      open.mockRestore();
    }
  });

  it('round-trips the spellings that write the length while the end would be spelled', () => {
    // Fixed-width ids, numbered URLs and words: positions, digit fields and
    // the plain spelling, beside the spelled end.
    const value = Array.from({ length: 120 }, (_, i) => ({
      id: (i * 2654435761).toString(16).padStart(8, '0').slice(-8),
      url: urls(120)[i],
      note: i % 3 === 0 ? texts(1)[0] : `item ${i}`,
      tag: i % 5 === 0 ? 'abcdefghij'.slice(0, 2 + (i % 7)) : WORDS[i % WORDS.length],
    }));
    expect(trip(p.any().adaptive(), value as AnyValue)).toEqual(value);
    const fixed = p.array(p.string().adaptive());
    const ids = Array.from({ length: 60 }, (_, i) =>
      i % 9 === 0 ? `id-${i}` : (i * 40503).toString(36).padStart(6, 'q')
    );
    expect(trip(fixed, ids)).toEqual(ids);
    const hex = (i: number): string => ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');
    const mixed = urls(80).map((url, i) => (i % 2 ? hex(i) + hex(i + 1).slice(4) : url));
    expect(trip(fixed, mixed)).toEqual(mixed);
  });

  it('ends a value soon once the input runs out, so a cut message fails or finishes fast', () => {
    // Past its input a decode reads zeros, which escape every context and
    // land on the end, rather than a symbol a context keeps predicting.
    const lines = Array.from({ length: 60 }, () => texts(3).join(' '));
    for (const [node, value] of [
      [p.string().adaptive(), lines.join('\n')],
      [p.array(p.string().adaptive()), lines],
    ] as [PNode<AnyValue>, AnyValue][]) {
      const bytes = node.encode(value);
      for (const cut of [0.25, 0.5, 0.75, 0.95]) {
        const start = performance.now();
        try {
          node.decode(bytes.subarray(0, Math.floor(bytes.length * cut)));
        } catch (error) {
          expect(error).toBeInstanceOf(CorruptInputError);
        }
        expect(performance.now() - start).toBeLessThan(250);
      }
    }
  });
});
