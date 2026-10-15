/**
 * Repeats: the hash-chain finder, values coded as a log2 bucket plus a
 * uniform offset, and the repeat tables of a node with their pricing: flags
 * per flag context, and matches at a new or a cached distance.
 */

import { Encoder, Decoder, ScaledRatio, CorruptInputError } from '../../packer';
import { AdaptiveTable } from '../../nodes/adaptive';
import {
  CHAIN_DEPTH,
  Finder,
  MIN_MATCH,
  REPS,
  REP_MIN,
  EVEN_REPEATS,
  Repeats,
  type FlagContext,
  readBucketed,
  writeBucketed,
  type Match,
} from '../../nodes/repeats';
import { mulberry32 } from '../support';

const BUCKETS = 32;
const ones = (n: number): number[] => new Array<number>(n).fill(1);
const bucketTable = (): AdaptiveTable => new AdaptiveTable(ones(BUCKETS), BUCKETS, 2, 1024, 'w');

/** A finder with every position of `items` before `end` registered. */
const finderOver = (items: readonly number[], end: number): Finder => {
  const finder = new Finder();
  for (let at = 0; at < end; at++) {
    finder.insert(items, at);
  }
  return finder;
};

/** The ratios are equal: neither exceeds the other. */
const expectSame = (a: ScaledRatio, b: ScaledRatio): void => {
  expect(a.exceeds(b)).toBe(false);
  expect(b.exceeds(a)).toBe(false);
};

describe('constants', () => {
  it('fix the shortest matches, the cached distances and the chain depth', () => {
    expect(MIN_MATCH).toBe(3);
    expect(REP_MIN).toBe(2);
    expect(REPS).toBe(4);
    expect(CHAIN_DEPTH).toBe(256);
  });
});

describe('Finder', () => {
  it('finds the longest match, the nearest on a tie', () => {
    //              0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17
    const items = [1, 2, 3, 4, 5, 9, 1, 2, 3, 4, 7, 9, 1, 2, 3, 4, 5, 8];
    const finder = finderOver(items, 12);
    expect(finder.find(items, 12, 100)).toEqual({ distance: 12, length: 5 });
    const tie = [1, 2, 3, 4, 9, 1, 2, 3, 4, 8, 1, 2, 3, 4, 7];
    expect(finderOver(tie, 10).find(tie, 10, 100)).toEqual({ distance: 5, length: 4 });
  });

  it('copies overlapping its own start', () => {
    const items = ones(20);
    expect(finderOver(items, 1).find(items, 1, 100)).toEqual({ distance: 1, length: 19 });
  });

  it('stops at the limit and the end of the items', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7];
    const finder = finderOver(items, 7);
    expect(finder.find(items, 7, 100)).toEqual({ distance: 7, length: 7 });
    expect(finder.find(items, 7, 5)).toEqual({ distance: 7, length: 5 });
    expect(finder.find(items, 7, 5.9)).toEqual({ distance: 7, length: 5 });
    expect(finder.find(items, 7, MIN_MATCH)).toEqual({ distance: 7, length: MIN_MATCH });
    expect(finder.find(items, 7, MIN_MATCH - 1)).toBeUndefined();
    expect(finder.find(items, 7, NaN)).toBeUndefined();
    expect(finder.find(items, 12, 100)).toBeUndefined();
    expect(finder.find(items, 14, 100)).toBeUndefined();
  });

  it('finds nothing shorter than MIN_MATCH, nothing unregistered, nothing at or after the position', () => {
    const items = [1, 2, 3, 4, 1, 2, 3, 5, 1, 2, 3, 4];
    expect(finderOver(items, 8).find(items, 8, 100)).toEqual({ distance: 8, length: 4 });
    expect(finderOver(items, 0).find(items, 8, 100)).toBeUndefined();
    const short = [1, 2, 9, 1, 2, 8];
    expect(finderOver(short, 3).find(short, 3, 100)).toBeUndefined();
    const all = finderOver(items, 9);
    expect(all.find(items, 0, 100)).toBeUndefined();
    expect(all.find(items, 8, 100)).toEqual({ distance: 8, length: 4 });
  });

  it('examines at most CHAIN_DEPTH candidates, newest first', () => {
    // Each copy holds one window of three 5s, as do the first and last
    // stretches.
    const build = (copies: number): number[] => {
      const items = [5, 5, 5, 1, 2, 3];
      for (let i = 0; i < copies; i++) {
        items.push(5, 5, 5, 0);
      }
      items.push(5, 5, 5, 1, 2, 3);
      return items;
    };
    const near = build(10);
    const end = near.length - 6;
    expect(finderOver(near, end).find(near, end, 100)).toEqual({ distance: end, length: 6 });
    const far = build(CHAIN_DEPTH);
    const farEnd = far.length - 6;
    expect(finderOver(far, farEnd).find(far, farEnd, 100)).toEqual({ distance: 4, length: 3 });
    const edge = build(CHAIN_DEPTH - 1);
    const edgeEnd = edge.length - 6;
    expect(finderOver(edge, edgeEnd).find(edge, edgeEnd, 100)).toEqual({
      distance: edgeEnd,
      length: 6,
    });
  });

  it('matches a brute-force search on random items', () => {
    const random = mulberry32(7);
    const items = Array.from({ length: 400 }, () => Math.floor(random() * 3));
    const finder = new Finder();
    for (let at = 0; at + MIN_MATCH <= items.length; at++) {
      let best: Match | undefined;
      for (let cand = at - 1; cand >= 0; cand--) {
        let l = 0;
        while (l < 12 && at + l < items.length && items[cand + l] === items[at + l]) l++;
        if (l >= MIN_MATCH && (best === undefined || l > best.length)) {
          best = { distance: at - cand, length: l };
        }
      }
      // Few candidates per hash on 400 items, so the depth never binds.
      expect(finder.find(items, at, 12)).toEqual(best);
      finder.insert(items, at);
    }
  });

  it('registers each position once, in rising order, with MIN_MATCH items from it', () => {
    const items = [1, 2, 3, 4, 5, 6];
    const finder = new Finder();
    expect(() => finder.insert(items, -1)).toThrow(
      new RangeError('Position -1 is below the minimum 0')
    );
    expect(() => finder.insert(items, 0.5)).toThrow(
      new TypeError('Position must be an integer, got 0.5')
    );
    expect(() => finder.insert(items, 4)).toThrow(
      new RangeError('Position 4 is above the maximum 3')
    );
    finder.insert(items, 1);
    expect(() => finder.insert(items, 1)).toThrow(
      new RangeError('Position 1 is below the minimum 2')
    );
    expect(() => finder.insert(items, 0)).toThrow(RangeError);
    finder.insert(items, 2);
  });

  it('rewinds to the chains as they stood before a position', () => {
    const items = [1, 2, 3, 4, 1, 2, 3, 5, 1, 2, 3, 4, 1, 2, 3, 4];
    const finder = finderOver(items, 12);
    finder.rewind(items, 12);
    expect(finder.find(items, 12, 100)).toEqual({ distance: 4, length: 4 });
    finder.rewind(items, 5);
    expect(finder.find(items, 12, 100)).toEqual({ distance: 12, length: 4 });
    finder.rewind(items, 0);
    expect(finder.find(items, 12, 100)).toBeUndefined();
    finder.insert(items, 0);
    expect(() => finder.rewind(items, 2)).toThrow(
      new RangeError('Position 2 is above the maximum 1')
    );
    expect(() => finder.rewind(items, -1)).toThrow(
      new RangeError('Position -1 is below the minimum 0')
    );
  });

  it('refuses a position outside the items', () => {
    const finder = new Finder();
    expect(() => finder.find([1, 2], -1, 4)).toThrow(
      new RangeError('Position -1 is below the minimum 0')
    );
    expect(() => finder.find([1, 2], 3, 4)).toThrow(
      new RangeError('Position 3 is above the maximum 2')
    );
    expect(() => finder.find([1, 2], 1.5, 4)).toThrow(TypeError);
    expect(finder.find([1, 2], 2, 4)).toBeUndefined();
  });
});

describe('writeBucketed and readBucketed', () => {
  const maxes = [1, 2, 3, 4, 5, 7, 8, 9, 255, 256, 1000, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1];

  /** Every bucket boundary up to `max`, and `max`. */
  const boundaries = (max: number): number[] => {
    const values = new Set<number>([1, max]);
    for (let k = 1; k <= 32; k++) {
      for (const v of [2 ** k - 1, 2 ** k, 2 ** k + 1]) {
        if (v <= max) values.add(v);
      }
    }
    return [...values];
  };

  it.each(maxes)('round-trip every bucket boundary under %p', (max) => {
    const table = bucketTable();
    const values = boundaries(max);
    const enc = new Encoder();
    for (const v of values) {
      writeBucketed(enc, table, v, max);
    }
    const dec = new Decoder(enc.output());
    expect(values.map(() => readBucketed(dec, table, max))).toEqual(values);
    dec.finalize();
  });

  it.each(maxes)('write a fresh table as hand-composed buckets under %p', (max) => {
    const top = 31 - Math.clz32(max);
    for (const v of [1, max, Math.ceil(max / 2)]) {
      const enc = new Encoder();
      writeBucketed(enc, bucketTable(), v, max);
      const b = 31 - Math.clz32(v);
      const lo = 2 ** b;
      const hand = new Encoder();
      hand.composeWeighted(2 * b, 2, 2 * (top + 1), { index: b, count: top + 1 });
      hand.compose(v - lo, Math.min(2 * lo - 1, max) - lo + 1);
      expect(enc.output()).toEqual(hand.output());
    }
  });

  it('reads a bucket written as its index at the end of a message', () => {
    // Value 1 is bucket 0 with no offset after it, and some message length
    // ends a block right at it.
    const random = mulberry32(21);
    for (let n = 1; n < 60; n++) {
      const values = Array.from({ length: n }, () => 1 + Math.floor(random() * 1000));
      values.push(1);
      const table = bucketTable();
      const enc = new Encoder();
      values.forEach((v) => writeBucketed(enc, table, v, 1000));
      const reader = bucketTable();
      const dec = new Decoder(enc.output());
      expect(values.map(() => readBucketed(dec, reader, 1000))).toEqual(values);
      dec.finalize();
    }
  });

  it('caps the top bucket at the maximum', () => {
    const enc = new Encoder();
    writeBucketed(enc, bucketTable(), 9, 9);
    const hand = new Encoder();
    hand.composeWeighted(6, 2, 8, { index: 3, count: 4 });
    hand.compose(1, 2);
    expect(enc.output()).toEqual(hand.output());
  });

  it('learns, so a recurring bucket gets cheaper', () => {
    const learning = new Encoder();
    const table = bucketTable();
    const fixed = new Encoder();
    for (let i = 0; i < 64; i++) {
      writeBucketed(learning, table, 5, 1000);
      fixed.composeWeighted(4, 2, 20, { index: 2, count: 10 });
      fixed.compose(1, 4);
    }
    expect(learning.output().length).toBeLessThan(fixed.output().length);
    expect(table.live(learning).learned.count(2)).toBe(64);
  });

  it('refuses a maximum outside [1, 2^32) and a value outside [1, max]', () => {
    const table = bucketTable();
    const enc = new Encoder();
    const dec = new Decoder(new Encoder().output());
    for (const [max, error] of [
      [0, new RangeError('Maximum 0 is below the minimum 1')],
      [2 ** 32, new RangeError('Maximum 4294967296 is above the maximum 4294967295')],
      [1.5, new TypeError('Maximum must be an integer, got 1.5')],
      [NaN, new TypeError('Maximum must be an integer, got NaN')],
    ] as const) {
      expect(() => writeBucketed(enc, table, 1, max)).toThrow(error);
      expect(() => readBucketed(dec, table, max)).toThrow(error);
    }
    expect(() => writeBucketed(enc, table, 0, 5)).toThrow(
      new RangeError('Value 0 is below the minimum 1')
    );
    expect(() => writeBucketed(enc, table, 6, 5)).toThrow(
      new RangeError('Value 6 is above the maximum 5')
    );
    expect(() => writeBucketed(enc, table, 2.5, 5)).toThrow(
      new TypeError('Value must be an integer, got 2.5')
    );
  });
});

describe('Repeats', () => {
  /** The cached distances every read in these steps looks rep matches up in. */
  const REPS_CACHE = [7, 1, 300, 2];

  type Step =
    | { kind: 'used'; used: boolean }
    | { kind: 'flag'; match: boolean; context: FlagContext }
    | { kind: 'match'; match: Match; maxDistance: number; maxLength: number };

  const steps: Step[] = [
    { kind: 'used', used: true },
    { kind: 'flag', match: false, context: 0 },
    { kind: 'flag', match: true, context: 1 },
    { kind: 'match', match: { distance: 1, length: 3 }, maxDistance: 1, maxLength: 3 },
    { kind: 'flag', match: true, context: 2 },
    { kind: 'match', match: { distance: 17, length: 9 }, maxDistance: 40, maxLength: 30 },
    { kind: 'match', match: { distance: 7, length: 2, rep: 0 }, maxDistance: 7, maxLength: 3 },
    {
      kind: 'match',
      match: { distance: 300, length: 40, rep: 2 },
      maxDistance: 900,
      maxLength: 40,
    },
    {
      kind: 'match',
      match: { distance: 2, length: 2, rep: 3 },
      maxDistance: 2,
      maxLength: 2 ** 32 - 1,
    },
    { kind: 'used', used: false },
    { kind: 'flag', match: false, context: 2 },
    { kind: 'flag', match: true, context: 0 },
    {
      kind: 'match',
      match: { distance: 2 ** 32 - 1, length: 2 ** 32 - 1 },
      maxDistance: 2 ** 32 - 1,
      maxLength: 2 ** 32 - 1,
    },
    { kind: 'used', used: true },
  ];

  const write = (repeats: Repeats, enc: Encoder, list: readonly Step[]): void => {
    for (const step of list) {
      if (step.kind === 'used') repeats.writeUsed(enc, step.used);
      else if (step.kind === 'flag') repeats.writeFlag(enc, step.match, step.context);
      else repeats.writeMatch(enc, step.match, step.maxDistance, step.maxLength);
    }
  };

  const read = (repeats: Repeats, dec: Decoder, list: readonly Step[]): Step[] =>
    list.map((step): Step => {
      if (step.kind === 'used') return { kind: 'used', used: repeats.readUsed(dec) };
      if (step.kind === 'flag') {
        return { ...step, match: repeats.readFlag(dec, step.context) };
      }
      return {
        ...step,
        match: repeats.readMatch(dec, step.maxDistance, step.maxLength, REPS_CACHE),
      };
    });

  it('round-trips branches, flags and matches interleaved in one message', () => {
    const repeats = new Repeats('w');
    const enc = new Encoder();
    write(repeats, enc, steps);
    const dec = new Decoder(enc.output());
    expect(read(repeats, dec, steps)).toEqual(steps);
    dec.finalize();
  });

  it('round-trips random matches under random bounds', () => {
    const random = mulberry32(3);
    const list: Step[] = [];
    for (let i = 0; i < 300; i++) {
      const maxDistance = 300 + Math.floor(random() * 5000);
      const maxLength = MIN_MATCH + Math.floor(random() * 300);
      const context = Math.floor(random() * 3) as FlagContext;
      list.push({ kind: 'flag', match: random() < 0.5, context });
      if (random() < 0.4) {
        const rep = Math.floor(random() * REPS);
        const length = REP_MIN + Math.floor(random() ** 3 * (maxLength - REP_MIN + 1));
        const match = { distance: REPS_CACHE[rep], length, rep };
        list.push({ kind: 'match', match, maxDistance, maxLength });
      } else {
        const distance = 1 + Math.floor(random() ** 3 * maxDistance);
        const length = MIN_MATCH + Math.floor(random() ** 3 * (maxLength - MIN_MATCH + 1));
        list.push({ kind: 'match', match: { distance, length }, maxDistance, maxLength });
      }
    }
    const repeats = new Repeats('w');
    const enc = new Encoder();
    write(repeats, enc, list);
    const dec = new Decoder(enc.output());
    expect(read(repeats, dec, list)).toEqual(list);
    dec.finalize();
  });

  it('keeps the branch, each flag context, the kind and the lengths in tables of their own', () => {
    const enc = new Encoder();
    const repeats = new Repeats('w');
    repeats.writeUsed(enc, true);
    repeats.writeFlag(enc, false, 0);
    repeats.writeFlag(enc, true, 0);
    // Fresh tables in contexts 1 and 2, untouched by context 0's.
    repeats.writeFlag(enc, true, 1);
    repeats.writeFlag(enc, false, 2);
    // A rep match: its kind, then its length 3 as 2 of 4 under 5, bucket 1
    // of 0..2; a new match: its kind with rep 1 learned, then a fresh
    // distance and length table.
    repeats.writeMatch(enc, { distance: 9, length: 3, rep: 1 }, 10, 5);
    repeats.writeMatch(enc, { distance: 9, length: 3 }, 10, 5);
    const hand = new Encoder();
    hand.composeWeighted(2, 2, 4, { index: 1, count: 2 });
    hand.composeWeighted(0, 2, 4, { index: 0, count: 2 });
    hand.composeWeighted(4, 2, 6, { index: 1, count: 2 });
    hand.composeWeighted(2, 2, 4, { index: 1, count: 2 });
    hand.composeWeighted(0, 2, 4, { index: 0, count: 2 });
    hand.composeWeighted(2, 2, 10, { index: 1, count: 5 });
    hand.composeWeighted(2, 2, 6, { index: 1, count: 3 });
    hand.compose(0, 2);
    hand.composeWeighted(8 + 5, 2, 10 + 5, { index: 4, count: 5 });
    hand.composeWeighted(6, 2, 8, { index: 3, count: 4 });
    hand.compose(1, 3);
    hand.composeWeighted(0, 2, 4, { index: 0, count: 2 });
    hand.compose(0, 1);
    expect(enc.output()).toEqual(hand.output());
  });

  it('prices flags and matches as the live tables would code them, learning nothing', () => {
    const repeats = new Repeats('w');
    const enc = new Encoder();
    const history: Step[] = [
      { kind: 'flag', match: true, context: 0 },
      { kind: 'match', match: { distance: 5, length: 6 }, maxDistance: 10, maxLength: 20 },
      { kind: 'flag', match: true, context: 0 },
      { kind: 'match', match: { distance: 6, length: 7 }, maxDistance: 10, maxLength: 20 },
      { kind: 'flag', match: false, context: 0 },
      { kind: 'flag', match: true, context: 2 },
      { kind: 'match', match: { distance: 1, length: 4, rep: 1 }, maxDistance: 10, maxLength: 20 },
    ];
    write(repeats, enc, history);
    // Context 0's flag learned [1, 2], context 2's [0, 1]; the kind learned
    // 4 twice and 1 once; distance learned bucket 2 twice; length learned
    // values 4 and 5, buckets 2 and 2; the rep length value 3, bucket 1.
    // Ones over n members at prior 2: member p holds 2 + total·learned(p)
    // of n·2 + total·learned.
    const flag = new ScaledRatio();
    repeats.priceFlag(enc, false, 0, flag);
    const flagHand = new ScaledRatio();
    flagHand.multiply(2 + 2 * 1, 2 * (2 + 3));
    expectSame(flag, flagHand);
    const fresh = new ScaledRatio();
    repeats.priceFlag(enc, true, 1, fresh);
    const half = new ScaledRatio();
    half.multiply(1, 2);
    expectSame(fresh, half);

    const match: Match = { distance: 4, length: 12 };
    const priced = new ScaledRatio();
    repeats.priceMatch(enc, match, 9, 16, 0, priced);
    const hand = new ScaledRatio();
    hand.multiply(2 + 2 * 2, 2 * (2 + 3));
    // Kind 4: 2 + 5·2 of 5·2 + 5·3.
    hand.multiply(2 + 5 * 2, 10 + 15);
    // Distance 4 is bucket 2 of buckets 0..3 under 9: 2 + 32·2 of 4·2 + 32·2.
    hand.multiply(2 + 32 * 2, 8 + 64);
    hand.multiply(1, 4);
    // Length 12 codes 10 under 14, bucket 3 of 0..3: 2 of 8 + 32·2.
    hand.multiply(2, 8 + 64);
    hand.multiply(1, 14 - 8 + 1);
    expectSame(priced, hand);

    const rep: Match = { distance: 1, length: 3, rep: 1 };
    const repPriced = new ScaledRatio();
    repeats.priceMatch(enc, rep, 9, 16, 2, repPriced);
    const repHand = new ScaledRatio();
    // Context 2's flag: 2 + 2 of 4 + 2.
    repHand.multiply(4, 6);
    // Kind 1: 2 + 5 of 25.
    repHand.multiply(7, 25);
    // Length 3 codes 2 under 15, bucket 1 of 0..3: 2 + 32 of 8 + 32.
    repHand.multiply(2 + 32, 8 + 32);
    repHand.multiply(1, 2);
    expectSame(repPriced, repHand);

    const again = new ScaledRatio();
    repeats.priceMatch(enc, match, 9, 16, 0, again);
    expectSame(again, priced);

    const tail: Step[] = [
      { kind: 'flag', match: true, context: 0 },
      { kind: 'match', match, maxDistance: 9, maxLength: 16 },
    ];
    write(repeats, enc, tail);
    const dec = new Decoder(enc.output());
    const reader = new Repeats('w');
    const cache = [9, 1, 9, 9];
    const readSteps = (list: readonly Step[]): Step[] =>
      list.map((step): Step => {
        if (step.kind === 'flag') return { ...step, match: reader.readFlag(dec, step.context) };
        if (step.kind === 'used') return step;
        return { ...step, match: reader.readMatch(dec, step.maxDistance, step.maxLength, cache) };
      });
    expect(readSteps(history)).toEqual(history);
    const decoded = new ScaledRatio();
    reader.priceMatch(dec, match, 9, 16, 0, decoded);
    expectSame(decoded, priced);
    expect(readSteps(tail)).toEqual(tail);
    dec.finalize();
  });

  it('prices a recurring match higher than a fresh one', () => {
    const repeats = new Repeats('w');
    const enc = new Encoder();
    const match: Match = { distance: 300, length: 40 };
    const fresh = new ScaledRatio();
    repeats.priceMatch(enc, match, 1000, 100, 0, fresh);
    for (let i = 0; i < 8; i++) {
      repeats.writeFlag(enc, true, 0);
      repeats.writeMatch(enc, match, 1000, 100);
    }
    const learned = new ScaledRatio();
    repeats.priceMatch(enc, match, 1000, 100, 0, learned);
    expect(learned.exceeds(fresh)).toBe(true);
  });

  it('refuses a rep naming a distance further back than the position', () => {
    const enc = new Encoder();
    new Repeats('w').writeMatch(enc, { distance: 3, length: 2, rep: 2 }, 3, 3);
    expect(() => new Repeats('w').readMatch(new Decoder(enc.output()), 3, 3, [1, 2, 4, 3])).toThrow(
      new CorruptInputError('Repeat distance 4 is above the maximum 3')
    );
  });

  it('refuses bounds and matches outside them', () => {
    const repeats = new Repeats('w');
    const enc = new Encoder();
    const dec = new Decoder(new Encoder().output());
    const ok: Match = { distance: 1, length: MIN_MATCH };
    const into = new ScaledRatio();
    for (const [match, maxDistance, maxLength, error] of [
      [ok, 0, 4, new RangeError('Maximum distance 0 is below the minimum 1')],
      [ok, 1.5, 4, new TypeError('Maximum distance must be an integer, got 1.5')],
      [
        ok,
        2 ** 32,
        4,
        new RangeError('Maximum distance 4294967296 is above the maximum 4294967295'),
      ],
      [ok, 1, 2, new RangeError('Maximum length 2 is below the minimum 3')],
      [ok, 1, 4.5, new TypeError('Maximum length must be an integer, got 4.5')],
      [ok, 1, 2 ** 32, new RangeError('Maximum length 4294967296 is above the maximum 4294967295')],
    ] as const) {
      expect(() => repeats.writeMatch(enc, match, maxDistance, maxLength)).toThrow(error);
      expect(() => repeats.readMatch(dec, maxDistance, maxLength, REPS_CACHE)).toThrow(error);
      expect(() => repeats.priceMatch(enc, match, maxDistance, maxLength, 0, into)).toThrow(error);
    }
    for (const [match, error] of [
      [{ distance: 0, length: 4 }, new RangeError('Match distance 0 is below the minimum 1')],
      [{ distance: 6, length: 4 }, new RangeError('Match distance 6 is above the maximum 5')],
      [{ distance: 1.5, length: 4 }, new TypeError('Match distance must be an integer, got 1.5')],
      [{ distance: 1, length: 2 }, new RangeError('Match length 2 is below the minimum 3')],
      [{ distance: 1, length: 9 }, new RangeError('Match length 9 is above the maximum 8')],
      [{ distance: 1, length: 4.5 }, new TypeError('Match length must be an integer, got 4.5')],
      [{ distance: 1, length: 1, rep: 0 }, new RangeError('Match length 1 is below the minimum 2')],
      [{ distance: 1, length: 9, rep: 0 }, new RangeError('Match length 9 is above the maximum 8')],
      [{ distance: 1, length: 2, rep: 4 }, new RangeError('Match rep 4 is above the maximum 3')],
      [{ distance: 1, length: 2, rep: -1 }, new RangeError('Match rep -1 is below the minimum 0')],
      [
        { distance: 1, length: 2, rep: 0.5 },
        new TypeError('Match rep must be an integer, got 0.5'),
      ],
    ] as const) {
      expect(() => repeats.writeMatch(enc, match, 5, 8)).toThrow(error);
      expect(() => repeats.priceMatch(enc, match, 5, 8, 0, into)).toThrow(error);
    }
  });
});

describe('Repeats priceUsed', () => {
  it('prices the branch as its table would code it, learning nothing', () => {
    const repeats = new Repeats('w');
    const enc = new Encoder();
    repeats.writeUsed(enc, true);
    repeats.writeUsed(enc, true);
    // Two members at prior 2, member 1 learned twice: 2 + 2·2 of 4 + 2·2.
    for (const [used, freq] of [
      [true, 6],
      [false, 2],
    ] as const) {
      const priced = new ScaledRatio();
      repeats.priceUsed(enc, used, priced);
      const hand = new ScaledRatio();
      hand.multiply(freq, 8);
      expectSame(priced, hand);
    }
    const again = new ScaledRatio();
    repeats.priceUsed(enc, true, again);
    const hand = new ScaledRatio();
    hand.multiply(6, 8);
    expectSame(again, hand);
  });
});

describe('EVEN_REPEATS', () => {
  it('names no cached distance', () => {
    expect(EVEN_REPEATS.cached).toBe(false);
  });

  it('spells the branch and every flag as one even bit, whatever the context', () => {
    const enc = new Encoder();
    EVEN_REPEATS.writeUsed(enc, true);
    EVEN_REPEATS.writeUsed(enc, false);
    EVEN_REPEATS.writeFlag(enc, true, 2);
    EVEN_REPEATS.writeFlag(enc, false, 1);
    const hand = new Encoder();
    for (const digit of [1, 0, 1, 0]) {
      hand.compose(digit, 2);
    }
    expect(enc.output()).toEqual(hand.output());
    const dec = new Decoder(enc.output());
    expect([
      EVEN_REPEATS.readUsed(dec),
      EVEN_REPEATS.readUsed(dec),
      EVEN_REPEATS.readFlag(dec, 0),
      EVEN_REPEATS.readFlag(dec, 2),
    ]).toEqual([true, false, true, false]);
    dec.finalize();
    for (const price of [
      (into: ScaledRatio) => EVEN_REPEATS.priceUsed(enc, true, into),
      (into: ScaledRatio) => EVEN_REPEATS.priceFlag(enc, false, 1, into),
    ]) {
      const priced = new ScaledRatio();
      price(priced);
      const half = new ScaledRatio();
      half.multiply(1, 2);
      expectSame(priced, half);
    }
  });

  it('spells a match as its distance and length, each an even bucket and offset', () => {
    // Distance 17 of 40: bucket 4 of 6, offset 1 of 16; length 9 of 30 as
    // 7 of 28: bucket 2 of 5, offset 3 of 4.
    const enc = new Encoder();
    EVEN_REPEATS.writeMatch(enc, { distance: 17, length: 9 }, 40, 30);
    const hand = new Encoder();
    for (const [digit, radix] of [
      [4, 6],
      [1, 16],
      [2, 5],
      [3, 4],
    ]) {
      hand.compose(digit, radix);
    }
    expect(enc.output()).toEqual(hand.output());
    const priced = new ScaledRatio();
    EVEN_REPEATS.priceMatch(enc, { distance: 17, length: 9 }, 40, 30, 2, priced);
    const odds = new ScaledRatio();
    odds.multiply(1, 2 * 6 * 16 * 5 * 4);
    expectSame(priced, odds);
  });

  it('round-trips random matches under random bounds, the cache unread', () => {
    const random = mulberry32(5);
    const draw = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
    const cases = Array.from({ length: 300 }, () => {
      const maxDistance = draw(1, 2 ** draw(0, 32) - 1 || 1);
      const maxLength = draw(MIN_MATCH, Math.max(MIN_MATCH, 2 ** draw(2, 32) - 1));
      const match = { distance: draw(1, maxDistance), length: draw(MIN_MATCH, maxLength) };
      return { match, maxDistance, maxLength };
    });
    const enc = new Encoder();
    for (const { match, maxDistance, maxLength } of cases) {
      EVEN_REPEATS.writeMatch(enc, match, maxDistance, maxLength);
    }
    const dec = new Decoder(enc.output());
    for (const { match, maxDistance, maxLength } of cases) {
      expect(EVEN_REPEATS.readMatch(dec, maxDistance, maxLength, [])).toEqual(match);
    }
    dec.finalize();
  });

  it('refuses a match at a cached distance, and bounds and matches outside them', () => {
    const enc = new Encoder();
    const rep = { distance: 1, length: 3, rep: 0 };
    expect(() => EVEN_REPEATS.writeMatch(enc, rep, 4, 4)).toThrow(
      new TypeError('Repeats at fixed odds name no cached distance')
    );
    expect(() => EVEN_REPEATS.priceMatch(enc, rep, 4, 4, 0, new ScaledRatio())).toThrow(
      new TypeError('Repeats at fixed odds name no cached distance')
    );
    expect(() => EVEN_REPEATS.writeMatch(enc, { distance: 5, length: 3 }, 4, 4)).toThrow(
      new RangeError('Match distance 5 is above the maximum 4')
    );
    expect(() => EVEN_REPEATS.readMatch(new Decoder(new Uint8Array(4)), 0, 4, [])).toThrow(
      new RangeError('Maximum distance 0 is below the minimum 1')
    );
  });
});
