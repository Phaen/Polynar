/**
 * Restricted runs of strings: arrays, sets and the keys of maps and records
 * with `.sorted()`, `.unique()` or `.unordered()`, written ascending by
 * UTF-16 code units, each after the start it shares with the one before.
 */

import { p, Encoder, CorruptInputError, type PNode } from '../../index';
import { mulberry32, trip } from '../support';
import { randString, useRng } from '../random-schemas';

/** The strings ascending by UTF-16 code units, as JS sorts them. */
const ascending = (values: readonly string[]): string[] => [...values].sort();

/** Item nodes covering every way a string is spelled. */
const ITEMS: [string, () => PNode<string>][] = [
  ['ladder', () => p.string()],
  ['bounded ladder', () => p.string().max(40)],
  ['adaptive', () => p.string().adaptive()],
  ['prose', () => p.string().prose()],
  ['adaptive prose', () => p.string().prose().adaptive()],
  ['repeats', () => p.string().repeats()],
  ['recall', () => p.string().recall()],
  ['delta', () => p.string().delta()],
];

/** Sets of strings meeting at every edge: empties, shared starts, prefixes, surrogates. */
const SETS: string[][] = [
  [],
  [''],
  ['', 'a'],
  ['a', 'ab', 'abc', 'abd', 'b'],
  ['userId', 'userName', 'user_id', 'user', 'users', 'User', 'USER_ID'],
  ['Value', 'value', 'vALUE', 'valuE', 'v', 'Vé', 'vé', 'vê', 'v1', 'v2'],
  ['\ud800', '𐀀', '\ud800x', '', '￿', '\u{10ffff}', '\udc00', '\u{1f600}'],
  ['https://a.example/x/1', 'https://a.example/x/2', 'https://a.example/y', 'https://b.example'],
];

describe('Restricted runs of strings', () => {
  describe.each(ITEMS)('%s items', (_name, item) => {
    it.each(SETS.map((set) => [set]))('round-trip %j in every order restriction', (set) => {
      const shuffled = [...set].reverse();
      expect(trip(p.array(item()).unordered(), shuffled)).toEqual(ascending(set));
      expect(trip(p.array(item()).unordered().unique(), shuffled)).toEqual(ascending(set));
      expect(trip(p.array(item()).sorted(), ascending(set))).toEqual(ascending(set));
      expect(trip(p.array(item()).sorted().unique(), ascending(set))).toEqual(ascending(set));
      expect(trip(p.array(item()).unique(), shuffled)).toEqual(shuffled);
      expect([...trip(p.set(item()).unordered(), new Set(shuffled))]).toEqual(ascending(set));
    });

    it('round-trips repeats where the run allows them', () => {
      const values = ['b', '', 'a', 'b', '', 'ab', 'a'];
      expect(trip(p.array(item()).unordered(), values)).toEqual(ascending(values));
      expect(trip(p.array(item()).sorted(), ascending(values))).toEqual(ascending(values));
    });
  });

  it('round-trip random strings under every item and restriction', () => {
    useRng(mulberry32(0x5e7));
    for (let round = 0; round < 40; round++) {
      const values = Array.from({ length: 1 + (round % 9) }, () => randString(4));
      // Repeats now and then, from a short alphabet.
      values.push(values[0], 'ab'.repeat(round % 3));
      const distinct = [...new Set(values)];
      for (const [, item] of ITEMS) {
        expect(trip(p.array(item()).unordered(), values)).toEqual(ascending(values));
        expect(trip(p.array(item()).sorted(), ascending(values))).toEqual(ascending(values));
        expect(trip(p.array(item()).unique(), distinct)).toEqual(distinct);
      }
    }
  });

  it('round-trip strings of a charset, listed ascending or not, static or adaptive', () => {
    const values = ['ba', 'ab', 'a', '', 'bb', 'aab', 'b'];
    for (const item of [
      p.string().charset('ab'),
      p.string().charset('ba'),
      p.string().charset([97, 98]),
      p.string().charset('ba').adaptive(),
    ]) {
      expect(trip(p.array(item).unordered().unique(), values)).toEqual(ascending(values));
      expect(trip(p.array(item).unordered(), [...values, 'a'])).toEqual(
        ascending([...values, 'a'])
      );
    }
  });

  it('code every collection type alike, decoding keys ascending', () => {
    const keys = ['zeta', 'alpha', 'beta', 'alphabet', 'Gamma'];
    const sorted = ascending(keys);
    const bytes = p.array(p.string()).unordered().unique().encode(keys);
    expect(p.set(p.string()).unordered().encode(new Set(keys))).toEqual(bytes);
    const record = p.record(p.null()).unordered();
    const object = Object.fromEntries(keys.map((key) => [key, null]));
    expect(record.encode(object)).toEqual(bytes);
    expect(Object.keys(trip(record, object))).toEqual(sorted);
    const map = p.map(p.string(), p.null()).unordered();
    expect(map.encode(new Map(keys.map((key) => [key, null])))).toEqual(bytes);
  });

  it('write the values of a map or record after the keys, in key order', () => {
    const node = p.record(p.int().min(0).max(9)).unordered();
    const back = trip(node, { b: 2, a: 1, c: 3 });
    expect(Object.entries(back)).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const map = trip(
      p.map(p.string().adaptive(), p.string()).unordered(),
      new Map([
        ['y', 'why'],
        ['x', 'ex'],
      ])
    );
    expect([...map]).toEqual([
      ['x', 'ex'],
      ['y', 'why'],
    ]);
  });

  it('take a string the node recalls from elsewhere in the message', () => {
    const name = p.string().recall();
    const node = p.object({ first: name, all: p.array(name).unordered().unique() });
    const value = { first: 'beta', all: ['gamma', 'beta', 'alpha'] };
    const back = trip(node, value);
    expect(back).toEqual({ first: 'beta', all: ['alpha', 'beta', 'gamma'] });
    const once = p.object({ first: p.string(), all: p.array(p.string()).unordered().unique() });
    expect(node.encode(value).length).toBeLessThanOrEqual(once.encode(value).length);
  });

  it('spell a value as the length, the shared start on the gamma scale, then the rest', () => {
    const node = p.array(p.string()).length(2).sorted().unique();
    const enc = new Encoder();
    p.string()._write(enc, 'ab');
    p.int().min(0)._write(enc, 2);
    // At most 1 shared: all of "ab" would make the value "ab" again. Sharing
    // 1 is the top class, so one bit and no stop; its one tail is free.
    enc.compose(1, 2);
    enc.compose(0, 1);
    // The next code point lies above "b", not "b" itself: "c" is the first of 32.
    enc.compose(0, 131 - 99);
    expect(node.encode(['ab', 'ac'])).toEqual(enc.output());
  });

  it('cost less than the same strings in their own order', () => {
    const words = 'the quick brown fox jumps over the lazy dog and then some more words follow';
    const values = [...new Set(words.split(' '))];
    for (const item of [p.string(), p.string().adaptive(), p.string().charset([97, 122])]) {
      const ordered = p.array(item).encode(values).length;
      expect(p.array(item).unordered().unique().encode(values).length).toBeLessThan(ordered);
    }
  });

  it('keep distinct strings in their order whichever way is shorter, by a choice', () => {
    const hex = Array.from({ length: 40 }, (_, i) => ((i * 2654435761) >>> 0).toString(16));
    const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/items/${19 - i}`);
    for (const values of [hex, urls]) {
      for (const node of [p.string(), p.string().adaptive()]) {
        const ordered = p.array(node).encode(values);
        for (const array of [p.array(node).unique(), p.array(node).adaptive().unique()]) {
          const kept = array.encode(values);
          expect(array.decode(kept)).toEqual(values);
          // The choice costs at most a bit, and less when learned.
          expect(kept.length).toBeLessThanOrEqual(ordered.length + 1);
        }
      }
    }
    // URLs sharing their starts take the ascending spelling.
    const choice = (values: string[]) =>
      p.array(p.string()).unique().encode(values).length <
      p.array(p.string()).encode(values).length;
    expect(choice(urls)).toBe(true);
    expect(() => p.array(p.string().charset('ab')).unique().encode(['a', 'c'])).toThrow(
      new RangeError('[1]: Character "c" at 0 is not in the character set')
    );
  });

  it('refuse values out of order or repeated, located', () => {
    expect(() => p.array(p.string()).sorted().encode(['b', 'a'])).toThrow(
      new RangeError('[1]: Value "a" is below the one before it')
    );
    expect(() => p.array(p.string()).unique().encode(['a', 'b', 'a'])).toThrow(
      new RangeError('[2]: Value "a" repeats an earlier one')
    );
    expect(() =>
      p
        .map(p.string().charset('ab'), p.int())
        .unordered()
        .encode(new Map([['c', 1]]))
    ).toThrow(new RangeError('c: Character "c" at 0 is not in the character set'));
    expect(() =>
      p
        .set(p.string().max(1))
        .unordered()
        .encode(new Set(['b', 'aa']))
    ).toThrow('[1]: String length 2 is above the maximum 1');
    expect(() => p.record(p.int().max(3)).unordered().encode({ b: 9, a: 1 })).toThrow(
      new RangeError('b: Value 9 is above the maximum 3')
    );
  });

  it('refuse an empty value after another in a run of distinct values as corrupt', () => {
    const node = p.array(p.string().charset('ab')).length(2).unordered().unique();
    const enc = new Encoder();
    p.string().charset('ab')._write(enc, 'a');
    p.int().min(0)._write(enc, 0);
    expect(() => node.decode(enc.output())).toThrow(
      new CorruptInputError('An empty value follows another in an ascending run')
    );
  });

  it('refuse a character past the last one an ascending charset has as corrupt', () => {
    const node = p.array(p.string().charset('ab')).length(2).unordered().unique();
    const enc = new Encoder();
    p.string().charset('ab')._write(enc, 'b');
    p.int().min(0)._write(enc, 2);
    // Nothing shared, so the first character lies above "b".
    enc.compose(0, 2);
    expect(() => node.decode(enc.output())).toThrow(
      new CorruptInputError('No symbol lies at or above 2')
    );
  });
});
