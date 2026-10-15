/**
 * A learned alphabet that grows: items admitted as the message meets them,
 * numbered alike on both sides, and the prior that codes an admitted item
 * as its one symbol for "seen before", then the item by its count.
 */

import { CorruptInputError, Encoder, Decoder, costUnits } from '../../packer';
import { AdaptivePrior } from '../../nodes/adaptive';
import { Exclusion } from '../../nodes/excluded';
import { GrownAlphabet, GrownPrior, MAX_ADMITTED, type Range } from '../../nodes/grown';
import { mulberry32 } from '../support';

const BASE = 4;
const WEIGHTS = [5, 3, 2, 1, 2];

/** Every symbol spells the items 0 through 2^20 with a tail. */
const wide: Range = () => [0, 1 << 20];

const priorOver = (alphabet: GrownAlphabet): GrownPrior =>
  new GrownPrior(new AdaptivePrior([WEIGHTS], BASE + 1, undefined, 'w'), alphabet);

/** An exclusion over `size` members holding `members`. */
const excluding = (size: number, members: readonly number[]): Exclusion => {
  const exclusion = new Exclusion(size);
  for (const member of members) {
    exclusion.add(member);
  }
  return exclusion;
};

describe('GrownAlphabet', () => {
  it('numbers the items it admits in order, past the prior symbol for them', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, wide);
    const enc = new Encoder();
    expect(alphabet.size).toBe(BASE + 1 + MAX_ADMITTED);
    expect(alphabet.symbol(enc, 900)).toBe(-1);
    alphabet.admit(enc, 900, 0);
    alphabet.admit(enc, 70, 0);
    expect(alphabet.symbol(enc, 900)).toBe(BASE + 1);
    expect(alphabet.symbol(enc, 70)).toBe(BASE + 2);
    expect(alphabet.symbol(enc, 71)).toBe(-1);
    expect(alphabet.item(enc, BASE + 2)).toBe(70);
    expect(alphabet.admitted(enc)).toBe(2);
    expect(alphabet.admitted(new Encoder())).toBe(0);
  });

  it('admits no more than MAX_ADMITTED items', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, wide);
    const enc = new Encoder();
    for (let item = 0; item <= MAX_ADMITTED; item++) {
      alphabet.admit(enc, item, 0);
    }
    expect(alphabet.admitted(enc)).toBe(MAX_ADMITTED);
    expect(alphabet.symbol(enc, MAX_ADMITTED - 1)).toBe(alphabet.size - 1);
    expect(alphabet.symbol(enc, MAX_ADMITTED)).toBe(-1);
  });

  it('takes back what a rolled-back transaction admitted and counted', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, wide);
    const enc = new Encoder();
    alphabet.admit(enc, 900, 0);
    const mark = enc.mark();
    alphabet.admit(enc, 70, 0);
    alphabet.learn(enc, BASE + 1);
    enc.rollback(mark);
    const { counts } = alphabet.message(enc);
    expect(alphabet.admitted(enc)).toBe(1);
    expect(alphabet.symbol(enc, 70)).toBe(-1);
    expect(counts.size).toBe(1);
    expect(counts.total).toBe(2);
    expect(alphabet.message(enc).offsets[0]).toEqual([900]);
    alphabet.admit(enc, 71, 0);
    expect(alphabet.symbol(enc, 71)).toBe(BASE + 2);
  });

  it('halves the counts past the window, or twice the items admitted, keeping each', () => {
    const alphabet = new GrownAlphabet(BASE, 4, wide);
    const enc = new Encoder();
    alphabet.admit(enc, 900, 0);
    alphabet.admit(enc, 70, 0);
    const { counts } = alphabet.message(enc);
    alphabet.learn(enc, BASE + 1);
    expect([counts.count(0), counts.count(1)]).toEqual([2, 1]);
    alphabet.learn(enc, BASE + 1);
    expect([counts.count(0), counts.count(1)]).toEqual([3, 1]);
    alphabet.learn(enc, BASE + 1);
    expect([counts.count(0), counts.count(1)]).toEqual([2, 1]);
    // Past the window, twice the items admitted is the bound.
    for (let item = 0; item < 4; item++) {
      alphabet.admit(enc, item, 0);
    }
    alphabet.learn(enc, BASE + 1);
    expect(counts.total).toBe(12);
    expect(counts.count(0)).toBe(3);
  });
});

describe('GrownAlphabet tails', () => {
  /** Symbol 0 spells 1000 through 1999, symbol 1 the 5 items from 7, symbol 2 has no tail. */
  const ranges: Range = (symbol) =>
    symbol === 0 ? [1000, 1999] : symbol === 1 ? [7, 11] : undefined;

  /** Writes each `[item, symbol]` new to the message, then reads them back. */
  const roundTrip = (spelled: readonly [number, number][]): number[] => {
    const alphabet = new GrownAlphabet(BASE, 1024, ranges);
    const enc = new Encoder();
    for (const [item, symbol] of spelled) {
      expect(alphabet.tail(enc, item, symbol)).toBe(true);
    }
    const decoding = new GrownAlphabet(BASE, 1024, ranges);
    const dec = new Decoder(enc.output());
    const read = spelled.map(([, symbol]) => decoding.untail(dec, symbol) as number);
    dec.finalize();
    return read;
  };

  it('round-trips new items, each admitted, in the range of their symbol', () => {
    const random = mulberry32(0x7a1);
    const items = new Set<number>();
    while (items.size < 400) {
      items.add(
        1000 + (random() < 0.7 ? 300 + Math.floor(random() * 64) : Math.floor(random() * 998) + 1)
      );
    }
    const spelled: [number, number][] = [...items].map((item) => [item, 0]);
    spelled.push([1999, 0], [1000, 0], [11, 1], [7, 1], [9, 1], [8, 1], [10, 1]);
    expect(roundTrip(spelled)).toEqual(spelled.map(([item]) => item));
  });

  it('spends nothing on the one item its symbol leaves new', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, ranges);
    const enc = new Encoder();
    for (const item of [7, 8, 10, 11]) {
      alphabet.tail(enc, item, 1);
    }
    expect(alphabet.symbol(enc, 11)).toBe(BASE + 4);
    const before = enc.output().length;
    alphabet.tail(enc, 9, 1);
    expect(enc.output().length).toBe(before);
    expect(roundTrip([7, 8, 10, 11, 9].map((item) => [item, 1]))).toEqual([7, 8, 10, 11, 9]);
  });

  it('weighs the stretch new items came from above the rest', () => {
    const cost = (item: number): number => {
      const alphabet = new GrownAlphabet(BASE, 1024, ranges);
      const enc = new Encoder();
      for (let k = 0; k < 20; k++) {
        alphabet.tail(enc, 1500 + 2 * k, 0);
      }
      const before = enc.output().length;
      for (let k = 0; k < 8; k++) {
        alphabet.tail(enc, item + 2 * k, 0);
      }
      return enc.output().length - before;
    };
    expect(cost(1501)).toBeLessThan(cost(1101));
  });

  it('leaves a symbol without a tail to the alphabet', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, ranges);
    const enc = new Encoder();
    expect(alphabet.tail(enc, 3, 2)).toBe(false);
    expect(alphabet.admitted(enc)).toBe(0);
    const dec = new Decoder(enc.output());
    expect(alphabet.untail(dec, 2)).toBeUndefined();
  });

  it('codes new items past MAX_ADMITTED without admitting them', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, wide);
    const enc = new Encoder();
    for (let item = 0; item < MAX_ADMITTED; item++) {
      alphabet.admit(enc, item, 0);
    }
    expect(alphabet.tail(enc, MAX_ADMITTED + 5, 0)).toBe(true);
    expect(alphabet.symbol(enc, MAX_ADMITTED + 5)).toBe(-1);
    expect(alphabet.message(enc).offsets[0].length).toBe(MAX_ADMITTED);
  });

  it('refuses a new item where its symbol spells none not admitted', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, ranges);
    const dec = new Decoder(new Encoder().output());
    for (let item = 7; item <= 11; item++) {
      alphabet.admit(dec, item, 1);
    }
    expect(() => alphabet.untail(dec, 1)).toThrow(CorruptInputError);
  });
});

describe('GrownPrior', () => {
  it('spans the grown alphabet and keeps the rows of its prior', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, wide);
    const inner = new AdaptivePrior([WEIGHTS], BASE + 1, undefined, 'w');
    const prior = new GrownPrior(inner, alphabet);
    expect(prior.members).toBe(alphabet.size);
    expect(prior.bases).toBe(inner.bases);
  });

  it('round-trips symbols and admitted items under exclusions of both', () => {
    const random = mulberry32(0x6e0);
    const items = [900, 70, 4000, 12, 333, 5000];
    // Each step: the symbol, the members ruled out, and whether an item is admitted after it.
    const script: [number, number[], number][] = [];
    let admitted = 0;
    for (let i = 0; i < 400; i++) {
      if (admitted < items.length && random() < 0.05) {
        script.push([Math.floor(random() * BASE), [], items[admitted++]]);
        continue;
      }
      const sym =
        admitted > 0 && random() < 0.6
          ? BASE + 1 + Math.floor(random() * admitted)
          : Math.floor(random() * BASE);
      const out: number[] = [];
      for (let s = 0; s < BASE + 1 + admitted; s++) {
        if (s !== sym && s !== BASE && random() < 0.3) {
          out.push(s);
        }
      }
      script.push([sym, out, -1]);
    }
    const alphabet = new GrownAlphabet(BASE, 64, wide);
    const prior = priorOver(alphabet);
    const enc = new Encoder();
    for (const [sym, out, item] of script) {
      prior.write(enc, sym, 0, excluding(alphabet.size, out));
      if (item >= 0) {
        alphabet.admit(enc, item, 0);
      }
    }
    const dec = new Decoder(enc.output());
    const read = script.map(([, out, item]) => {
      const sym = prior.read(dec, 0, excluding(alphabet.size, out));
      if (item >= 0) {
        alphabet.admit(dec, item, 0);
      }
      return sym;
    });
    dec.finalize();
    expect(read).toEqual(script.map(([sym]) => sym));
    expect(admitted).toBe(items.length);
  });

  it('rules out its symbol for an admitted item where none is left', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, wide);
    const prior = priorOver(alphabet);
    const plain = new AdaptivePrior([WEIGHTS], BASE + 1, undefined, 'w');
    const enc = new Encoder();
    const none = new Exclusion(alphabet.size);
    expect(prior.cost(enc, 2, 0, none)).toBe(plain.cost(enc, 2, 0, excluding(BASE + 1, [BASE])));
    alphabet.admit(enc, 900, 0);
    const all = excluding(alphabet.size, [BASE + 1]);
    expect(prior.cost(enc, 2, 0, all)).toBe(plain.cost(enc, 2, 0, excluding(BASE + 1, [BASE])));
    expect(prior.cost(enc, 2, 0, none)).toBe(plain.cost(enc, 2, 0, new Exclusion(BASE + 1)));
  });

  it('prices an admitted item by its symbol and count, one numbered ahead as just admitted', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, wide);
    const prior = priorOver(alphabet);
    const plain = new AdaptivePrior([WEIGHTS], BASE + 1, undefined, 'w');
    const enc = new Encoder();
    alphabet.admit(enc, 900, 0);
    alphabet.admit(enc, 70, 0);
    alphabet.learn(enc, BASE + 2);
    const none = new Exclusion(alphabet.size);
    const seen = plain.cost(enc, BASE, 0, new Exclusion(BASE + 1));
    expect(prior.cost(enc, BASE + 2, 0, none)).toBe(seen + costUnits(3, 5));
    expect(prior.cost(enc, BASE + 2, 0, excluding(alphabet.size, [BASE + 1]))).toBe(seen);
    expect(prior.cost(enc, BASE + 3, 0, none)).toBe(seen + costUnits(2, 7));
  });

  it('learns its symbol for an admitted item and the item’s count', () => {
    const alphabet = new GrownAlphabet(BASE, 1024, wide);
    const prior = priorOver(alphabet);
    const enc = new Encoder();
    alphabet.admit(enc, 900, 0);
    prior.learn(enc, BASE + 1, 0);
    prior.learn(enc, 1, 0);
    expect(alphabet.message(enc).counts.count(0)).toBe(3);
  });
});
