/**
 * The sequence engine behind `p.string` and `p.binary`, over toy alphabets:
 * the length prefix, the symbols under each spelling, their tails and rows,
 * the run read for a uniform, tailless alphabet, and the contexts and
 * repeats of the adaptive one.
 */

import { Encoder, Decoder, CorruptInputError } from '../../index';
import { Sequence, StaticLiterals, withRepeats, type Symbols } from '../../nodes/sequence';
import { buildWeights, writeTable } from '../../nodes/weights';
import { ScaledRatio } from '../../packer';
import type { LengthBounds } from '../../nodes/lattice';
import { AdaptivePrior } from '../../nodes/adaptive';
import { ContextModel } from '../../nodes/contexts';
import { Repeats, type Match } from '../../nodes/repeats';
import { LearnedMagnitude } from '../../nodes/magnitude';
import { mulberry32 } from '../support';

/**
 * Items 0–12 over four symbols: 0–2 are their own symbol, 3 and above share
 * symbol 3 with a one-digit tail. Item 1 takes two units. Given rows, the
 * next item is priced in the row of the item's parity, the first in row 1.
 */
const toy = (rows?: number[][], check?: (count: number) => void): Symbols<number[]> => ({
  who: 'toy',
  pool: rows ?? 'toy',
  size: 4,
  rows,
  start: rows === undefined ? 0 : 1,
  noun: 'length',
  item: 'toy item',
  tailless: false,
  order: rows === undefined ? 0 : 1,
  count: (value) => value.reduce((sum, item) => sum + (item === 1 ? 2 : 1), 0),
  span: (count) => count,
  check,
  items: (value) => {
    if (value.some((item) => item > 12)) {
      throw new RangeError('Toy item above 12');
    }
    return [...value];
  },
  units: (item) => (item === 1 ? 2 : 1),
  symbol: (item) => Math.min(item, 3),
  tail: (enc, item, symbol) => {
    if (symbol === 3) {
      enc.compose(item - 3, 10);
    }
  },
  tails: (_item, symbol) => (symbol === 3 ? 10 : 1),
  untail: (dec, symbol) => (symbol === 3 ? 3 + dec.parse(10) : symbol),
  row: (item) => (rows === undefined ? 0 : item % 2),
  build: (items) => items,
  subject: (value) => `Toy length ${value.length}`,
});

/** Symbols 0–3 as themselves, two units per value-length unit. */
const plain: Symbols<number[]> = {
  who: 'plain',
  pool: 'plain',
  size: 4,
  start: 0,
  noun: 'count',
  item: 'digit',
  tailless: true,
  order: 0,
  count: (value) => value.length / 2,
  span: (count) => count * 2,
  items: (value) => [...value],
  units: () => 1,
  symbol: (item) => item,
  tail: () => {},
  tails: () => 1,
  untail: (_dec, symbol) => symbol,
  row: () => 0,
  build: (items) => items,
  subject: (value) => `Plain count ${value.length / 2}`,
};

const rows = [
  [1, 1, 1, 1],
  [8, 1, 4, 2],
];

const roundTrip = <T>(sequence: Sequence<T>, values: T[]): T[] => {
  const enc = new Encoder();
  for (const value of values) {
    sequence.write(enc, value);
  }
  const dec = new Decoder(enc.output());
  const out = values.map(() => sequence.read(dec));
  dec.finalize();
  return out;
};

const encode = <T>(sequence: Sequence<T>, value: T): Uint8Array => {
  const enc = new Encoder();
  sequence.write(enc, value);
  return enc.output();
};

const values = [[], [0], [1, 2, 3], [12, 0, 1, 1, 5], [3, 3, 3, 3, 3, 3, 3, 3, 0]];

describe('Sequence', () => {
  it.each([
    ['uniform', undefined, {}],
    ['uniform with a max', undefined, { max: 12 }],
    ['rows', rows, { max: 12 }],
    ['adaptive', undefined, { adaptive: {} }],
    ['adaptive rows with a learned length', rows, { max: 12, adaptive: { window: 8 } }],
  ])('round-trips under the %s spelling', (_name, given, bounds: LengthBounds) => {
    const many = Array.from({ length: 40 }, (_, i) => values[i % values.length]);
    expect(roundTrip(new Sequence(toy(given), bounds), many)).toEqual(many);
  });

  it('writes the prefix, then each symbol and its tail', () => {
    const plainEnc = new Encoder();
    plainEnc.compose(4, 13);
    for (const [symbol, tail] of [
      [3, 9],
      [1, -1],
      [0, -1],
    ]) {
      plainEnc.compose(symbol, 4);
      if (tail >= 0) {
        plainEnc.compose(tail, 10);
      }
    }
    expect(encode(new Sequence(toy(), { max: 12 }), [12, 1, 0])).toEqual(plainEnc.output());
  });

  it('prices the first item in the start row and each next one in its predecessor row', () => {
    const tables = new Sequence(toy([[1, 1, 1, 1], rows[1]]), { max: 12 });
    const flat = new Sequence(toy([rows[1], rows[1]]), { max: 12 });
    // Row 1 throughout: only odd items lead, so both price alike.
    expect(encode(tables, [1, 1, 5])).toEqual(encode(flat, [1, 1, 5]));
    // Zeros, then an item that keeps them from ending the message for free.
    const zeros = [...Array<number>(11).fill(0), 2];
    expect(encode(tables, zeros).length).toBeGreaterThan(encode(flat, zeros).length);
  });

  it('reads a uniform, tailless alphabet as one run of the span', () => {
    const sequence = new Sequence(plain, { max: 3 });
    const value = [3, 0, 2, 1, 1, 3];
    const enc = new Encoder();
    enc.compose(3, 4);
    for (const digit of value) {
      enc.compose(digit, 4);
    }
    expect(encode(sequence, value)).toEqual(enc.output());
    const dec = new Decoder(enc.output());
    const run = jest.spyOn(dec, 'parseMany');
    expect(sequence.read(dec)).toEqual(value);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(4, 6);
  });

  it.each([
    ['tailed', toy(), {}],
    ['weighted', { ...plain, rows: [rows[1]] }, {}],
    ['adaptive', plain, { adaptive: {} }],
  ])('reads a %s alphabet item by item', (_name, symbols: Symbols<number[]>, bounds) => {
    const sequence = new Sequence(symbols, bounds);
    const value = [0, 2, 0, 3];
    const dec = new Decoder(encode(sequence, value));
    const run = jest.spyOn(dec, 'parseMany');
    expect(sequence.read(dec)).toEqual(value);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses items that overrun the length prefix', () => {
    // A prefix of one unit, then item 1, which takes two.
    const enc = new Encoder();
    enc.compose(1, 13);
    enc.compose(1, 4);
    expect(() => new Sequence(toy(), { max: 12 }).read(new Decoder(enc.output()))).toThrow(
      new CorruptInputError('Toy items overrun the length prefix')
    );
  });

  it('refuses a length outside the bounds, naming the value as the alphabet does', () => {
    expect(() => encode(new Sequence(toy(), { max: 2 }), [0, 0, 0])).toThrow(
      new RangeError('Toy length 3 is above the maximum 2')
    );
    expect(() => encode(new Sequence(plain, { min: 2 }), [0, 0])).toThrow(
      new RangeError('Plain count 1 is below the minimum 2')
    );
  });

  it("passes on the alphabet's own error for an item it cannot spell", () => {
    expect(() => encode(new Sequence(toy(), {}), [13])).toThrow(
      new RangeError('Toy item above 12')
    );
  });

  it('checks the length prefix right after reading it', () => {
    const counts: number[] = [];
    const sequence = new Sequence(
      toy(undefined, (count) => {
        counts.push(count);
        if (count > 4) {
          throw new CorruptInputError(`Count ${count} is too long`);
        }
      }),
      { max: 12 }
    );
    expect(roundTrip(sequence, [[1, 2, 3]])).toEqual([[1, 2, 3]]);
    expect(counts).toEqual([4]);
    const enc = new Encoder();
    enc.compose(5, 13);
    expect(() => sequence.read(new Decoder(enc.output()))).toThrow(
      new CorruptInputError('Count 5 is too long')
    );
    expect(counts).toEqual([4, 5]);
  });

  it('learns the symbols without a max, and refuses bad adaptive options', () => {
    const repeated = Array<number>(400).fill(2);
    const learning = new Sequence(toy(), { adaptive: {} });
    expect(roundTrip(learning, [repeated])).toEqual([repeated]);
    expect(encode(learning, repeated).length).toBeLessThan(
      encode(new Sequence(toy(), {}), repeated).length / 4
    );
    expect(() => new Sequence(toy(), { adaptive: { window: 0 } })).toThrow(
      new RangeError('toy adaptive window must be a positive integer, got 0')
    );
    expect(() => new Sequence(toy(), { prior: [1, 1] })).toThrow(
      new TypeError('toy weights requires a max length')
    );
  });

  describe('adaptive', () => {
    /** The writer of an adaptive sequence's lengths without a max, as it writes them. */
    const lengths = (): ((enc: Encoder, n: number) => void) => {
      const scale = new LearnedMagnitude(false, {}, 'toy');
      return (enc, n) => scale.write(enc, n, 0, 0, Number.MAX_SAFE_INTEGER);
    };
    /** The mode of an adaptive sequence's second value, the plain spelling, as its mode table writes it. */
    const plainMode = (enc: Encoder): void =>
      new AdaptivePrior([[1, 1]], 2, undefined, 'toy').write(enc, 0);
    const random = (seed: number, length: number): number[] => {
      const next = mulberry32(seed);
      return Array.from({ length }, () => Math.floor(next() * 13));
    };
    const stretch = [5, 0, 7, 2, 9, 3, 12, 0, 4, 6];
    /** Sixty-seven units, past the warm-up on its own. */
    const repetitive = [
      ...stretch,
      ...stretch,
      ...stretch,
      8,
      ...stretch,
      ...stretch,
      ...stretch,
      ...stretch.slice(0, 6),
    ];

    /** The writes `Repeats` makes while `run` runs: each value's branch, and each match with its bounds. */
    const spy = (run: () => void): { used: boolean[]; matches: [Match, number, number][] } => {
      const used = jest.spyOn(Repeats.prototype, 'writeUsed');
      const match = jest.spyOn(Repeats.prototype, 'writeMatch');
      try {
        run();
        return {
          used: used.mock.calls.map(([, u]) => u),
          matches: match.mock.calls.map(([, m, d, l]) => [m, d, l]),
        };
      } finally {
        used.mockRestore();
        match.mockRestore();
      }
    };

    it.each([
      ['without rows', undefined],
      ['in rows', rows],
    ])('round-trips long repetitive and random values in one message %s', (_name, given) => {
      const sequence = new Sequence(toy(given), { adaptive: {} });
      const many = [repetitive, random(1, 60), repetitive, [], [3], random(2, 5), repetitive];
      expect(roundTrip(sequence, many)).toEqual(many);
    });

    it('spells a repetitive value with repeats, and a random one without', () => {
      const { used, matches } = spy(() =>
        encode(new Sequence(toy(), { adaptive: {} }), repetitive)
      );
      expect(used).toEqual([true]);
      expect(matches.length).toBeGreaterThan(0);
      const sequence = new Sequence(toy(), { adaptive: {} });
      expect(spy(() => encode(sequence, random(3, 80))).used).toEqual([false]);
    });

    it('refers the first item of a value into the value before it, capped at its end', () => {
      const sequence = new Sequence(toy(), { adaptive: {} });
      const first = random(4, 70);
      const second = first.slice(5, 25);
      const enc = new Encoder();
      const { matches } = spy(() => {
        sequence.write(enc, first);
        sequence.write(enc, second);
      });
      // At the second value's first position: 65 items back, 70 in reach,
      // and every unit of the second value left.
      expect(matches).toEqual([[{ distance: 65, length: 20 }, 70, toy().count(second)]]);
      const dec = new Decoder(enc.output());
      expect([sequence.read(dec), sequence.read(dec)]).toEqual([first, second]);
      dec.finalize();
    });

    it('copies a match overlapping the position it starts at', () => {
      const sequence = new Sequence(toy(), { adaptive: {} });
      const run = [6, ...Array<number>(80).fill(2)];
      const { matches } = spy(() => encode(sequence, run));
      expect(matches.some(([match]) => match.distance < match.length)).toBe(true);
      expect(roundTrip(sequence, [run])).toEqual([run]);
    });

    it('copies items wider than one unit, the bounds counting units', () => {
      const sequence = new Sequence(toy(), { adaptive: {} });
      const wide = Array<number>(40).fill(1);
      const { matches } = spy(() => encode(sequence, wide));
      // After the first item, 78 units are left for the 39 items that follow.
      expect(matches).toEqual([[{ distance: 1, length: 39 }, 1, 78]]);
      expect(roundTrip(sequence, [wide, wide])).toEqual([wide, wide]);
    });

    it('writes the branch only once history plus span reaches the warm-up, and a repeat fits', () => {
      const branches = (values: number[][]): boolean[] => {
        const sequence = new Sequence(toy(), { adaptive: {} });
        const enc = new Encoder();
        const { used } = spy(() => values.forEach((value) => sequence.write(enc, value)));
        const dec = new Decoder(enc.output());
        expect(values.map(() => sequence.read(dec))).toEqual(values);
        dec.finalize();
        return used;
      };
      const twos = (n: number): number[] => Array<number>(n).fill(2);
      // 30, 59 and 63 units of history plus span: none.
      expect(branches([twos(30), twos(29), twos(4)])).toEqual([]);
      // 30, 60, then 64: the third value is the first with a branch.
      expect(branches([twos(30), twos(30), twos(4)])).toHaveLength(1);
      // Past the warm-up, a value of two units holds no repeat, and one of
      // three does.
      expect(branches([twos(70), twos(2)])).toHaveLength(1);
      expect(branches([twos(70), twos(3)])).toHaveLength(2);
    });

    it('flags no repeat where more units are left than a repeat is coded under', () => {
      // A corrupt prefix of 2^33 units: every item reads as a literal, past
      // the input too without a decode limit, so the read is cut off after
      // the written ones.
      const enc = new Encoder();
      lengths()(enc, 2 ** 33);
      new Repeats('toy').writeUsed(enc, true);
      const model = new ContextModel(
        new AdaptivePrior([[1, 1, 1, 1]], 4, undefined, 'toy'),
        4,
        0,
        'toy'
      );
      let history = [4, 4, 4];
      for (const sym of [2, 0, 3]) {
        model.write(enc, sym, 0, history);
        history = [sym, history[0], history[1]];
      }
      const read = ContextModel.prototype.read;
      let literals = 0;
      const literal = jest.spyOn(ContextModel.prototype, 'read').mockImplementation(function (
        this: ContextModel,
        ...args
      ) {
        if (++literals > 3) {
          throw new Error('cut off');
        }
        return read.apply(this, args);
      });
      const flag = jest.spyOn(Repeats.prototype, 'readFlag');
      try {
        const dec = new Decoder(enc.output(), { limit: Infinity });
        expect(() => new Sequence(toy(), { adaptive: {} }).read(dec)).toThrow('cut off');
        expect(flag).not.toHaveBeenCalled();
      } finally {
        literal.mockRestore();
        flag.mockRestore();
      }
    });

    it('refuses a repeat that grows the items past the largest array', () => {
      const repeats = new Repeats('toy');
      const model = new ContextModel(
        new AdaptivePrior([[1, 1, 1, 1]], 4, undefined, 'toy'),
        4,
        0,
        'toy'
      );
      // A first value [2, 2], too short for a repeat; then one of 2^32 - 1
      // units: a flagged literal, and a match of all but one unit, which
      // would hold 2^32 + 1 items.
      const enc = new Encoder();
      const length = lengths();
      length(enc, 2);
      model.write(enc, 2, 0, [4, 4, 4]);
      model.write(enc, 2, 0, [2, 4, 4]);
      length(enc, 2 ** 32 - 1);
      plainMode(enc);
      repeats.writeUsed(enc, true);
      repeats.writeFlag(enc, false, 0);
      model.write(enc, 0, 0, [4, 4, 4]);
      repeats.writeFlag(enc, true, 0);
      repeats.writeMatch(enc, { distance: 1, length: 2 ** 32 - 2 }, 3, 2 ** 32 - 2);
      const sequence = new Sequence(toy(), { adaptive: {} });
      const dec = new Decoder(enc.output());
      expect(sequence.read(dec)).toEqual([2, 2]);
      expect(() => sequence.read(dec)).toThrow(
        new CorruptInputError(`Repeat length ${2 ** 32 - 2} is above the maximum ${2 ** 32 - 4}`)
      );
    });

    it('refuses repeats that copy more than 2^16 items per digit of input', () => {
      // A value of 2^20 units: one literal, then a match copying the rest.
      const enc = new Encoder();
      lengths()(enc, 2 ** 20);
      const repeats = new Repeats('toy');
      const model = new ContextModel(
        new AdaptivePrior([[1, 1, 1, 1]], 4, undefined, 'toy'),
        4,
        0,
        'toy'
      );
      repeats.writeUsed(enc, true);
      model.write(enc, 2, 0, [4, 4, 4]);
      repeats.writeFlag(enc, true, 0);
      repeats.writeMatch(enc, { distance: 1, length: 2 ** 20 - 1 }, 1, 2 ** 20 - 1);
      const bytes = enc.output();
      expect(() => new Sequence(toy(), { adaptive: {} }).read(new Decoder(bytes))).toThrow(
        new CorruptInputError(
          `Repeats copy more than ${2 ** 16 * bytes.length} items from ${bytes.length} digits of input`
        )
      );
    });

    it('copies a long run far under the cap', () => {
      const sequence = new Sequence(toy(), { adaptive: {} });
      const run = Array<number>(100000).fill(2);
      const bytes = encode(sequence, run);
      expect(bytes.length).toBeLessThan(20);
      expect(roundTrip(sequence, [run])).toEqual([run]);
    });

    /** One step the encoder took: a flag, a match, or a literal and what it ruled out. */
    type Event =
      | { kind: 'flag'; match: boolean; context: number }
      | { kind: 'match'; match: Match }
      | { kind: 'literal'; sym: number; except: number | undefined }
      | { kind: 'top'; top: boolean };

    /** The flags, matches and literals `run` writes, in order. */
    const record = (run: () => void): Event[] => {
      const flag = jest.spyOn(Repeats.prototype, 'writeFlag');
      const match = jest.spyOn(Repeats.prototype, 'writeMatch');
      const literal = jest.spyOn(ContextModel.prototype, 'write');
      const top = jest.spyOn(ContextModel.prototype, 'hitTop');
      try {
        run();
        const events: [number, Event][] = [
          ...flag.mock.calls.map(([, m, context], i): [number, Event] => [
            flag.mock.invocationCallOrder[i],
            { kind: 'flag', match: m, context },
          ]),
          ...match.mock.calls.map(([, m], i): [number, Event] => [
            match.mock.invocationCallOrder[i],
            { kind: 'match', match: m },
          ]),
          ...literal.mock.calls.map(([, sym, , , except], i): [number, Event] => [
            literal.mock.invocationCallOrder[i],
            { kind: 'literal', sym, except },
          ]),
          ...top.mock.results.map(({ value }, i): [number, Event] => [
            top.mock.invocationCallOrder[i],
            { kind: 'top', top: value as boolean },
          ]),
        ];
        return events.sort((a, b) => a[0] - b[0]).map(([, event]) => event);
      } finally {
        flag.mockRestore();
        match.mockRestore();
        literal.mockRestore();
        top.mockRestore();
      }
    };

    /**
     * A tailless value of `periods` copies of a random block of `period`
     * digits, each copy with one digit changed: matches at the period's
     * distance stop short at every change, then resume.
     */
    const mutated = (seed: number, period: number, periods: number): number[] => {
      const next = mulberry32(seed);
      const block = Array.from({ length: period }, () => Math.floor(next() * 4));
      const value: number[] = [];
      for (let c = 0; c < periods; c++) {
        const at = Math.floor(next() * period);
        block[at] = (block[at] + 1 + Math.floor(next() * 3)) % 4;
        value.push(...block);
      }
      return value;
    };

    /** Two tailless values with matches that stop short and resume, and the events of writing them. */
    const written = (): { values: number[][]; events: Event[] } => {
      const values = [mutated(5, 40, 12), mutated(6, 30, 10)];
      const sequence = new Sequence(plain, { adaptive: {} });
      const enc = new Encoder();
      const events = record(() => values.forEach((value) => sequence.write(enc, value)));
      const dec = new Decoder(enc.output());
      expect(values.map(() => sequence.read(dec))).toEqual(values);
      dec.finalize();
      return { values, events };
    };

    /** The events of each value: a value starts at its first flag or literal after the last item of the one before. */
    const byValue = (values: number[][], events: Event[]): Event[][] => {
      const out: Event[][] = values.map(() => []);
      let v = 0;
      let left = values[0].length;
      for (const event of events) {
        if (left === 0) {
          v++;
          left = values[v].length;
        }
        out[v].push(event);
        if (event.kind === 'match') left -= event.match.length;
        if (event.kind === 'literal') left--;
      }
      return out;
    };

    it('names a cached distance again, the cache kept in step with every match', () => {
      const { events } = written();
      let reps = [1, 2, 3, 4];
      const matches = events.flatMap((e) => (e.kind === 'match' ? [e.match] : []));
      for (const match of matches) {
        if (match.rep === undefined) {
          reps = [match.distance, ...reps.slice(0, 3)];
        } else {
          expect(match.distance).toBe(reps[match.rep]);
          reps = [match.distance, ...reps.filter((_, i) => i !== match.rep)];
        }
      }
      // The period's distance is named again after every change.
      expect(matches.some((m) => m.rep === 0 && m.distance === 40)).toBe(true);
      expect(matches.some((m) => m.rep === undefined)).toBe(true);
    });

    it('rules out the continuation of a match that stopped short from the literal after it', () => {
      const { values, events } = written();
      let applied = 0;
      let dropped = 0;
      byValue(values, events).forEach((list, v) => {
        const items = values[v];
        let at = 0;
        let pending: number | undefined;
        for (const event of list) {
          if (event.kind === 'match') {
            if (pending !== undefined) dropped++;
            at += event.match.length;
            pending = at < items.length ? items[at - event.match.distance] : undefined;
          } else if (event.kind === 'literal') {
            expect(event.except).toBe(pending);
            if (pending !== undefined) {
              expect(event.sym).not.toBe(pending);
              applied++;
            }
            pending = undefined;
            at++;
          }
        }
      });
      expect(applied).toBeGreaterThan(0);
      expect(dropped).toBeGreaterThan(0);
    });

    it('rules nothing out in an alphabet with tails', () => {
      const sequence = new Sequence(toy(), { adaptive: {} });
      const value = mutated(7, 40, 10).map((digit, i) => (digit === 3 ? 3 + (i % 10) : digit));
      const events = record(() => encode(sequence, value));
      expect(events.some((e) => e.kind === 'match')).toBe(true);
      expect(events.every((e) => e.kind !== 'literal' || e.except === undefined)).toBe(true);
      expect(roundTrip(sequence, [value])).toEqual([value]);
    });

    it('flags in context 2 right after a match, 1 after a top hit, else 0 and at a value start', () => {
      const { values, events } = written();
      const seen = new Set<number>();
      for (const list of byValue(values, events)) {
        let expected = 0;
        for (const event of list) {
          if (event.kind === 'flag') {
            expect(event.context).toBe(expected);
            seen.add(event.context);
          } else if (event.kind === 'match') {
            expected = 2;
          } else if (event.kind === 'top') {
            expected = event.top ? 1 : 0;
          }
        }
      }
      expect([...seen].sort()).toEqual([0, 1, 2]);
    });

    it('refuses copied items that overrun the length prefix', () => {
      // Seventy units: item 1 spelled, then 35 more copied from it, 72 units.
      const enc = new Encoder();
      lengths()(enc, 70);
      const repeats = new Repeats('toy');
      const model = new ContextModel(
        new AdaptivePrior([[1, 1, 1, 1]], 4, undefined, 'toy'),
        4,
        0,
        'toy'
      );
      repeats.writeUsed(enc, true);
      model.write(enc, 1, 0, [4, 4, 4]);
      repeats.writeFlag(enc, true, 0);
      repeats.writeMatch(enc, { distance: 1, length: 35 }, 1, 68);
      expect(() => new Sequence(toy(), { adaptive: {} }).read(new Decoder(enc.output()))).toThrow(
        new CorruptInputError('Toy items overrun the length prefix')
      );
    });

    /** The matches written for `first` then `second`, after round-tripping both. */
    const pair = (first: Sequence<number[]>, second: Sequence<number[]>, value: number[]) => {
      const enc = new Encoder();
      const { matches } = spy(() => {
        first.write(enc, value);
        second.write(enc, value);
      });
      const dec = new Decoder(enc.output());
      expect([first.read(dec), second.read(dec)]).toEqual([value, value]);
      dec.finalize();
      return { matches, bytes: enc.output() };
    };

    it('learns as one with every sequence of its pool and window, in either write order', () => {
      // An undeclared window is the default one, and the length is the
      // sequence's own.
      const a = new Sequence(toy(), { adaptive: {} });
      const b = new Sequence(toy(), { max: 100, adaptive: { window: 1024 } });
      const value = random(4, 70);
      for (const [first, second] of [
        [a, b],
        [b, a],
      ]) {
        expect(pair(first, second, value).matches).toEqual([
          [{ distance: 70, length: 70 }, 70, toy().count(value)],
        ]);
      }
    });

    it('keeps apart sequences of another pool or window, and a separate one', () => {
      const a = new Sequence(toy(), { adaptive: {} });
      const value = random(4, 70);
      for (const b of [
        new Sequence(toy(rows), { adaptive: {} }),
        new Sequence(toy(), { adaptive: { window: 512 } }),
        new Sequence(toy(), { adaptive: { separate: true } }),
      ]) {
        expect(pair(a, b, value).matches).toEqual([]);
      }
    });

    it('spells a separate sequence as one alone in its pool', () => {
      const value = random(6, 70);
      const alone = () => new Sequence({ ...toy(), pool: {} }, { adaptive: {} });
      const separate = () => new Sequence(toy(), { adaptive: { separate: true } });
      expect(pair(separate(), separate(), value).bytes).toEqual(
        pair(alone(), alone(), value).bytes
      );
      expect(encode(new Sequence(toy(), { adaptive: {} }), value)).toEqual(encode(alone(), value));
    });
  });
});

describe('Sequence methods', () => {
  /** The output of `steps` run on a fresh encoder: the hand-built spelling. */
  const hand = (steps: (enc: Encoder) => void): Uint8Array => {
    const enc = new Encoder();
    steps(enc);
    return enc.output();
  };

  /** The output of `values` written in turn to one message. */
  const message = <T>(sequence: Sequence<T>, values: T[]): Uint8Array => {
    const enc = new Encoder();
    for (const value of values) {
      sequence.write(enc, value);
    }
    return enc.output();
  };

  /** Composes each `[digit, radix]`. */
  const digits = (enc: Encoder, list: readonly (readonly [number, number])[]): void => {
    for (const [digit, radix] of list) {
      enc.compose(digit, radix);
    }
  };

  describe('delta', () => {
    it('spells each value after the first by the start it shares with the one before', () => {
      const values = [
        [0, 2, 3],
        [0, 2, 5],
        [1, 1],
        [1, 0],
      ];
      const sequence = () => new Sequence(toy(), { max: 12 }, { delta: true });
      const expected = hand((enc) =>
        digits(enc, [
          // [0, 2, 3]: the length, then the items in full.
          [3, 13],
          [0, 4],
          [2, 4],
          [3, 4],
          [0, 10],
          // [0, 2, 5]: two of at most three items shared, then item 5.
          [3, 13],
          [2, 4],
          [3, 4],
          [2, 10],
          // [1, 1], four units: all three items of the last value fit, none shared.
          [4, 13],
          [0, 4],
          [1, 4],
          [1, 4],
          // [1, 0], three units: only the first item 1, of two units, fits, and is shared.
          [3, 13],
          [1, 2],
          [0, 4],
        ])
      );
      expect(message(sequence(), values)).toEqual(expected);
      expect(roundTrip(sequence(), values)).toEqual(values);
    });

    it('prices the first item after the shared start in the row of the last shared one', () => {
      const tables = rows.map((weights) => buildWeights(weights, 4, 'toy'));
      const expected = hand((enc) => {
        digits(enc, [[2, 13]]);
        writeTable(enc, tables[1], 0);
        writeTable(enc, tables[0], 0);
        digits(enc, [
          [2, 13],
          [1, 3],
        ]);
        writeTable(enc, tables[0], 2);
      });
      const values = [
        [0, 0],
        [0, 2],
      ];
      const sequence = () => new Sequence(toy(rows), { max: 12 }, { delta: true });
      expect(message(sequence(), values)).toEqual(expected);
      expect(roundTrip(sequence(), values)).toEqual(values);
    });

    it('reads the items after the shared start of a uniform, tailless alphabet as one run', () => {
      const sequence = new Sequence(plain, { max: 3 }, { delta: true });
      const values = [
        [3, 0, 2, 1],
        [3, 0, 1, 1],
      ];
      const dec = new Decoder(message(sequence, values));
      const run = jest.spyOn(dec, 'parseMany');
      expect([sequence.read(dec), sequence.read(dec)]).toEqual(values);
      dec.finalize();
      expect(run.mock.calls).toEqual([
        [4, 4],
        [4, 2],
      ]);
    });

    it('refuses items after the shared start that overrun the length prefix', () => {
      const bytes = hand((enc) =>
        digits(enc, [
          [1, 13],
          [0, 4],
          // One unit, none shared, then item 1 of two units.
          [1, 13],
          [0, 2],
          [1, 4],
        ])
      );
      const sequence = new Sequence(toy(), { max: 12 }, { delta: true });
      const dec = new Decoder(bytes);
      expect(sequence.read(dec)).toEqual([0]);
      expect(() => sequence.read(dec)).toThrow(
        new CorruptInputError('Toy items overrun the length prefix')
      );
    });
  });

  describe('adaptive delta', () => {
    const a = Array.from({ length: 30 }, (_, i) => 2 + (i % 11));
    const b = [...a.slice(0, 27), 0, 0, 0];
    const c = Array<number>(30).fill(12);

    /** The shared starts `run` writes and learns, as value, origin and bounds. */
    const scale = (run: () => void): { written: number[][]; learned: number[][] } => {
      const write = jest.spyOn(LearnedMagnitude.prototype, 'write');
      const learn = jest.spyOn(LearnedMagnitude.prototype, 'learn');
      try {
        run();
        return {
          written: write.mock.calls.map(([, ...rest]) => rest),
          learned: learn.mock.calls.map(([, ...rest]) => rest),
        };
      } finally {
        write.mockRestore();
        learn.mockRestore();
      }
    };

    it('picks the delta for a value sharing a long start, and the plain spelling otherwise, each learning both', () => {
      const sequence = new Sequence(toy(), { max: 100, adaptive: {} });
      const values = [a, b, c];
      let bytes: Uint8Array = new Uint8Array();
      // The first value has no delta; b shares 27 of 30 items; c none, and
      // its shared start of 0 is learned all the same.
      expect(scale(() => (bytes = message(sequence, values)))).toEqual({
        written: [[27, 0, 0, 30]],
        learned: [[0, 0, 0, 30]],
      });
      const read = jest.spyOn(LearnedMagnitude.prototype, 'read');
      const learned = scale(() => {
        const dec = new Decoder(bytes);
        expect(values.map(() => sequence.read(dec))).toEqual(values);
        dec.finalize();
      }).learned;
      expect(read.mock.calls.map(([, ...rest]) => rest)).toEqual([[0, 0, 30]]);
      read.mockRestore();
      expect(learned).toEqual([[0, 0, 0, 30]]);
    });

    it('spells every value after the first by the delta when declared, with no mode', () => {
      const sequence = () => new Sequence(toy(), { max: 100, adaptive: {} }, { delta: true });
      expect(scale(() => message(sequence(), [a, c]))).toEqual({
        written: [[0, 0, 0, 30]],
        learned: [],
      });
      expect(roundTrip(sequence(), [a, b, c, b])).toEqual([a, b, c, b]);
    });

    it('round-trips a run of related values under either', () => {
      const random = mulberry32(9);
      const values = Array.from({ length: 60 }, () =>
        Array.from({ length: Math.floor(random() * 12) }, () => Math.floor(random() * 13))
      ).map((value, i, all) => (i % 3 === 0 ? value : [...(all[i - 1] ?? []), ...value]));
      for (const spelling of [{}, { delta: true as const }]) {
        const sequence = new Sequence(toy(), { adaptive: {} }, spelling);
        expect(roundTrip(sequence, values)).toEqual(values);
      }
    });
  });

  describe('adaptive lengths without a max', () => {
    /** One symbol, so the items cost nothing and the lengths are the message. */
    const single: Symbols<number[]> = { ...plain, size: 1, count: (v) => v.length, span: (n) => n };

    it('learn on the magnitude scale from the min', () => {
      const values = Array.from({ length: 100 }, () => Array<number>(40).fill(0));
      const sequence = new Sequence(single, { min: 5, adaptive: {} });
      expect(roundTrip(sequence, values)).toEqual(values);
      // A term costs over 10 bits for 35; learned, under 4.
      expect(message(sequence, values).length).toBeLessThan(50);
      expect(() => message(sequence, [[0, 0]])).toThrow(
        new RangeError('Plain count 1 is below the minimum 5')
      );
    });
  });

  describe('recall', () => {
    it('spells a value already written by its place among those seen, and a new one in full', () => {
      const values = [[0, 2], [3], [0, 2]];
      const expected = hand((enc) =>
        digits(enc, [
          [0, 1],
          [2, 13],
          [0, 4],
          [2, 4],
          [0, 2],
          [1, 13],
          [3, 4],
          [0, 10],
          [1, 3],
        ])
      );
      const sequence = () => new Sequence(toy(), { max: 12 }, { recall: true });
      expect(message(sequence(), values)).toEqual(expected);
      expect(roundTrip(sequence(), values)).toEqual(values);
    });

    it('measures a delta against the previous value, recalled or spelled', () => {
      const values = [[0, 2, 4], [5], [0, 2, 4], [0, 2, 6]];
      const expected = hand((enc) =>
        digits(enc, [
          [3, 13],
          [0, 4],
          [2, 4],
          [3, 4],
          [1, 10],
          // [5]: new, then nothing shared of the one item that fits.
          [0, 2],
          [1, 13],
          [0, 2],
          [3, 4],
          [2, 10],
          // [0, 2, 4] recalled.
          [1, 3],
          // [0, 2, 6]: new, two items shared with the recalled value.
          [0, 3],
          [3, 13],
          [2, 4],
          [3, 4],
          [3, 10],
        ])
      );
      const sequence = () => new Sequence(toy(), { max: 12 }, { recall: true, delta: true });
      expect(message(sequence(), values)).toEqual(expected);
      expect(roundTrip(sequence(), values)).toEqual(values);
    });

    it('learns under adaptive, and copies a recalled value when the alphabet copies', () => {
      const copies: number[][] = [];
      const copying: Symbols<number[]> = {
        ...toy(),
        copy: (value) => {
          copies.push(value);
          return [...value];
        },
      };
      const values = [[0, 2], [3], [0, 2], [0, 2], [3]];
      const sequence = new Sequence(copying, { max: 12, adaptive: {} }, { recall: true });
      const out = roundTrip(sequence, values);
      expect(out).toEqual(values);
      expect(copies).toEqual([[0, 2], [0, 2], [3]]);
      expect(out[2]).not.toBe(out[0]);
      const once = message(new Sequence(toy(), { max: 12, adaptive: {} }, { recall: true }), [
        [0, 2],
      ]);
      expect(once).toEqual(message(new Sequence(toy(), { max: 12, adaptive: {} }), [[0, 2]]));
    });
  });

  describe('repeats without adaptive', () => {
    it('copies a stretch at fixed odds', () => {
      const expected = hand((enc) => {
        digits(enc, [
          [6, 13],
          [1, 2],
        ]);
        enc.composeWeighted(0, 1, 4);
        digits(enc, [[0, 2]]);
        enc.composeWeighted(2, 1, 4);
        // A match at distance 2 of at most 2, of 4 items of at most 4.
        digits(enc, [
          [1, 2],
          [1, 2],
          [0, 1],
          [1, 2],
          [0, 1],
        ]);
      });
      const sequence = () => new Sequence(toy(), { max: 12 }, { repeats: true });
      const value = [0, 2, 0, 2, 0, 2];
      expect(encode(sequence(), value)).toEqual(expected);
      expect(roundTrip(sequence(), [value])).toEqual([value]);
    });

    it('round-trips repetitive and random values, with rows, tails and a delta', () => {
      const random = mulberry32(12);
      const stretch = [5, 0, 7, 2, 9, 3, 12, 0, 4, 6];
      const values = [
        [...stretch, ...stretch, 1, ...stretch],
        Array.from({ length: 40 }, () => Math.floor(random() * 13)),
        [],
        [2],
        stretch,
        [...stretch, 8, 8, 8, 8],
      ];
      for (const [given, spelling] of [
        [undefined, { repeats: true as const }],
        [rows, { repeats: true as const }],
        [rows, { repeats: true as const, delta: true as const }],
      ] as const) {
        expect(roundTrip(new Sequence(toy(given), { max: 100 }, spelling), values)).toEqual(values);
      }
      const symbols = { ...plain, count: (v: number[]) => v.length, span: (n: number) => n };
      const tailless = [
        [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 0],
        [3, 3, 3, 3, 3, 3],
      ];
      expect(roundTrip(new Sequence(symbols, {}, { repeats: true }), tailless)).toEqual(tailless);
      const repetitive = [...stretch, ...stretch, ...stretch];
      expect(encode(new Sequence(toy(), {}, { repeats: true }), repetitive).length).toBeLessThan(
        encode(new Sequence(toy(), {}), repetitive).length * 0.6
      );
    });

    it('refuses copied items that overrun the length prefix', () => {
      const bytes = hand((enc) => {
        digits(enc, [
          [5, 13],
          [1, 2],
        ]);
        enc.composeWeighted(1, 1, 4);
        // Three copies of item 1, two units each.
        digits(enc, [
          [1, 2],
          [0, 1],
          [0, 1],
          [0, 1],
          [0, 1],
        ]);
      });
      expect(() =>
        new Sequence(toy(), { max: 12 }, { repeats: true }).read(new Decoder(bytes))
      ).toThrow(new CorruptInputError('Toy items overrun the length prefix'));
    });

    it('are declared once', () => {
      expect(withRepeats({ delta: true }, 'toy')).toEqual({ delta: true, repeats: true });
      expect(() => withRepeats({ repeats: true }, 'toy')).toThrow(
        new TypeError('toy repeats is already set')
      );
    });
  });
});

describe('StaticLiterals', () => {
  const literals = new StaticLiterals(toy(rows) as Symbols<unknown>);
  const history = [4, 4, 4];

  it("spells a symbol at its row's weights, the excluded symbol ruled out", () => {
    const enc = new Encoder();
    literals.write(enc, 2, 0, history, 1);
    literals.write(enc, 2, 1, history);
    const expected = hand((h) => {
      h.composeWeighted(1, 1, 3);
      h.composeWeighted(9, 4, 15);
    });
    expect(enc.output()).toEqual(expected);
    const dec = new Decoder(enc.output());
    expect([literals.read(dec, 0, history, 1), literals.read(dec, 1, history)]).toEqual([2, 2]);
    dec.finalize();
    const priced = new ScaledRatio();
    literals.price(enc, 2, 0, history, priced, 1);
    const odds = new ScaledRatio();
    odds.multiply(1, 3);
    expect(priced.exceeds(odds) || odds.exceeds(priced)).toBe(false);
  });

  it('learns nothing and never hits a context', () => {
    const enc = new Encoder();
    literals.learn();
    expect(literals.hitTop()).toBe(false);
    literals.write(enc, 0, 0, history);
    expect(enc.output()).toEqual(hand((h) => h.composeWeighted(0, 1, 4)));
  });

  it('refuses a row outside its rows', () => {
    expect(() => literals.write(new Encoder(), 0, 2, history)).toThrow(
      new RangeError('Row 2 is outside [0, 2)')
    );
  });

  /** The output of `steps` run on a fresh encoder. */
  function hand(steps: (enc: Encoder) => void): Uint8Array {
    const enc = new Encoder();
    steps(enc);
    return enc.output();
  }
});
