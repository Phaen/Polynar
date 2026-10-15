/**
 * The streaming coder under the Encoder and Decoder, driven directly: exact
 * round trips over every short message of a small alphabet under any window
 * L, the output bases, the edges of the safe totals and the switch between
 * double and BigInt states, and the small-state map that ends a message.
 * Seeded, so failures reproduce.
 */

import { StreamReader, StreamWriter } from '../packer/stream';
import { rankOf, residualAt, spreadOf } from '../packer/spread';
import { mulberry32 } from './support';

const rand = mulberry32(0x57ea4);
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const BASES = [2, 3, 10, 64, 85, 256, 65536];

/** One symbol: the bucket `[cum, cum + freq)` of `total` states, uniform or weighted. */
type Event = readonly [cum: number, freq: number, total: number, weighted: boolean];

/**
 * The buckets a weighted event splits its total into: below it, it, and
 * above it, each named by its start.
 */
const around =
  ([cum, freq, total]: Event) =>
  (r: number): readonly [number, number, number] =>
    r < cum
      ? [0, 0, cum]
      : r < cum + freq
        ? [cum, cum, freq]
        : [cum + freq, cum + freq, total - cum - freq];

const writerOf = (events: readonly Event[], size: number, L?: number, head = 0): StreamWriter =>
  new StreamWriter(
    size,
    events.map(([, , total]) => total),
    events.map(([, freq]) => freq),
    head,
    L
  );

const write = (events: readonly Event[], size: number, L?: number): number[] => {
  const writer = writerOf(events, size, L);
  for (let i = events.length - 1; i >= 0; i--) {
    writer.push(...events[i]);
  }
  return writer.digits();
};

/** What reading `events` back returns, and where the reader ends. */
const read = (digits: readonly number[], events: readonly Event[], size: number, L?: number) => {
  const reader = new StreamReader((i) => digits[i], digits.length, size, L);
  const symbols = events.map((event) =>
    event[3] ? reader.weighted(event[2], around(event)) : reader.uniform(event[2])
  );
  return { symbols, state: reader.state, position: reader.position };
};

/** Writes `events`, expects them back with every digit read and the state at 0, and returns the digits. */
const expectTrip = (events: readonly Event[], size: number, L?: number): number[] => {
  const digits = write(events, size, L);
  expect(digits.every((d) => Number.isInteger(d) && d >= 0 && d < size)).toBe(true);
  expect(read(digits, events, size, L)).toEqual({
    symbols: events.map(([cum]) => cum),
    state: 0n,
    position: digits.length,
  });
  return digits;
};

/** Every uniform slot and weighted bucket with a total from 2 to `top`. */
const alphabet = (top: number): Event[] => {
  const events: Event[] = [];
  for (let total = 2; total <= top; total++) {
    for (let cum = 0; cum < total; cum++) {
      events.push([cum, 1, total, false]);
      for (let freq = 1; cum + freq <= total && freq < total; freq++) {
        events.push([cum, freq, total, true]);
      }
    }
  }
  return events;
};

/** A random event with a total up to `top`, its frequency often at an edge. */
const randomEvent = (top: number): Event => {
  const total =
    rand() < 0.2 ? Math.max(2, top - randInt(0, 2)) : randInt(2, Math.min(top, 2 ** 20));
  if (rand() < 0.4) {
    return [Math.floor(rand() * total), 1, total, false];
  }
  const r = rand();
  const freq = r < 0.2 ? 1 : r < 0.4 ? total - 1 : 1 + Math.floor(rand() * (total - 1));
  return [Math.floor(rand() * (total - freq + 1)), freq, total, true];
};

describe('spreadOf / residualAt / rankOf', () => {
  /** Expects the pair (`cum`, `y`) to come back from the state it spreads to. */
  const expectPair = (cum: number, freq: number, total: number, y: number): number => {
    const state = spreadOf(cum, freq, total, y);
    expect(state).toBeGreaterThanOrEqual(0);
    expect(state).toBeLessThan(total);
    const { residual, visit } = residualAt(state, total);
    expect(residual).toBeGreaterThanOrEqual(cum);
    expect(residual).toBeLessThan(cum + freq);
    expect(rankOf(visit, cum, freq, total)).toBe(y);
    return state;
  };

  it('visits the residuals in bit-reversed order, skipping those past the total', () => {
    const lone = (total: number) =>
      Array.from({ length: total }, (_, c) => spreadOf(c, 1, total, 0));
    expect(lone(8)).toEqual([0, 4, 2, 6, 1, 5, 3, 7]);
    // Visits 0 4 2 1 3: 6, 5 and 7 lie past 5.
    expect(lone(5)).toEqual([0, 3, 2, 4, 1]);
    expect(lone(2)).toEqual([0, 1]);
  });

  it('places the y-th visit inside a bucket', () => {
    // [2, 6) of 8 is visited at 2, 4, 5 and 3, the 1st, 2nd, 5th and 6th visits.
    expect([0, 1, 2, 3].map((y) => spreadOf(2, 4, 8, y))).toEqual([1, 2, 5, 6]);
  });

  it('round-trips every pair of every bucket of a small total', () => {
    for (let total = 2; total <= 33; total++) {
      for (let cum = 0; cum < total; cum++) {
        for (let freq = 1; cum + freq <= total; freq++) {
          for (let y = 0; y < freq; y++) {
            expectPair(cum, freq, total, y);
          }
        }
      }
    }
  });

  it('maps the pairs of a partition one to one onto the states', () => {
    for (let run = 0; run < 300; run++) {
      const total = randInt(2, 300);
      const states: number[] = [];
      for (let cum = 0; cum < total; ) {
        const freq = randInt(1, total - cum);
        for (let y = 0; y < freq; y++) {
          states.push(expectPair(cum, freq, total, y));
        }
        cum += freq;
      }
      expect(states.sort((a, b) => a - b)).toEqual(Array.from({ length: total }, (_, i) => i));
    }
  });

  it('round-trips pairs of totals up to 2^53, a power of two or not', () => {
    for (const total of [MAX_SAFE, 2 ** 52 + 1, 2 ** 52, 2 ** 40, 3 * 2 ** 50]) {
      const buckets: [number, number][] = [
        [0, 1],
        [total - 1, 1],
        [1, total - 2],
        [0, total - 1],
      ];
      for (let i = 0; i < 6; i++) {
        const freq = 1 + Math.floor(rand() * (total - 1));
        buckets.push([Math.floor(rand() * (total - freq + 1)), freq]);
      }
      for (const [cum, freq] of buckets) {
        for (const y of [0, freq - 1, Math.floor(rand() * freq)]) {
          expectPair(cum, freq, total, y);
        }
      }
    }
  });
});

describe('StreamWriter / StreamReader', () => {
  it('writes nothing for an empty message, and reads zeros from nothing', () => {
    for (const size of BASES) {
      expect(write([], size)).toEqual([]);
      const reader = new StreamReader(() => 0, 0, size);
      expect(reader.uniform(1000)).toBe(0);
      expect(reader.weighted(10, around([3, 4, 10, true]))).toBe(0);
      expect(reader.uniform(MAX_SAFE)).toBe(0);
      expect([reader.state, reader.position, reader.drained]).toEqual([0n, 0, true]);
    }
  });

  it('round-trips a single symbol of every kind in every base', () => {
    const singles: Event[] = [
      [0, 1, 2, false],
      [1, 1, 2, false],
      [MAX_SAFE - 1, 1, MAX_SAFE, false],
      [0, 1, 2, true],
      [1, 1, 2, true],
      [0, MAX_SAFE - 1, MAX_SAFE, true],
      [MAX_SAFE - 1, 1, MAX_SAFE, true],
      [12345, 2 ** 40, MAX_SAFE, true],
    ];
    for (const size of BASES) {
      for (const event of singles) {
        expectTrip([event], size);
      }
    }
  });

  it('reads a head slot first, folded last after the windows counted it', () => {
    const events: Event[] = [
      [3, 4, 10, true],
      [MAX_SAFE - 1, 1, MAX_SAFE, false],
      [7, 1, 9, false],
    ];
    for (const size of BASES) {
      for (const head of [2, 2 ** 32, MAX_SAFE]) {
        const writer = writerOf(events, size, undefined, head);
        for (let i = events.length - 1; i >= 0; i--) {
          writer.push(...events[i]);
        }
        writer.push(head - 1, 1, head, false);
        const digits = writer.digits();
        const reader = new StreamReader((i) => digits[i], digits.length, size);
        expect(reader.uniform(head)).toBe(head - 1);
        expect(
          events.map((e) => (e[3] ? reader.weighted(e[2], around(e)) : reader.uniform(e[2])))
        ).toEqual(events.map(([cum]) => cum));
        expect([reader.state, reader.position]).toEqual([0n, digits.length]);
      }
    }
  });

  it('round-trips every message of up to three symbols over a small alphabet', () => {
    // Totals up to 5: L = 25 meets L ≥ T·T′ for every adjacent pair, and
    // L = 1 and 7 leave it to the windows' ceiling term.
    const events = alphabet(5);
    for (const [size, L] of [
      [2, 25],
      [3, 1],
      [2, 7],
    ]) {
      for (const a of events) {
        expectTrip([a], size, L);
        for (const b of events) {
          expectTrip([a, b], size, L);
          for (const c of events) {
            expectTrip([a, b, c], size, L);
          }
        }
      }
    }
  });

  it('round-trips random messages under any window, narrow or wide', () => {
    for (let run = 0; run < 2000; run++) {
      const top = randInt(2, 40);
      const events = Array.from({ length: randInt(1, 30) }, () => randomEvent(top));
      const L = rand() < 0.5 ? randInt(1, top * top) : top * top + randInt(0, 50);
      expectTrip(events, BASES[run % BASES.length], L);
    }
  });

  it("keeps the proof's minimal counterexample to a plain ⌊L/T⌋ window exact", () => {
    // L = 7, base 2: the first bucket's lower bound ⌊7/6⌋·5 = 5 tops the
    // window ⌊7/4⌋·4 = 4 of the next, where the state can land at 4. The
    // next window is widened to ⌈5/4⌉·4 = 8 instead.
    const events: Event[] = [
      [0, 5, 6, true],
      [0, 1, 4, true],
      [2, 1, 3, false],
    ];
    expectTrip(events, 2, 7);
    expectTrip(events, 2, 24);
    expectTrip(events, 2);
  });

  it('round-trips long random messages in every base, totals up to 2^53', () => {
    for (const size of BASES) {
      for (const top of [256, 2 ** 32, MAX_SAFE]) {
        const events = Array.from({ length: 1500 }, () => randomEvent(top));
        const writer = writerOf(events, size);
        for (let i = events.length - 1; i >= 0; i--) {
          writer.push(...events[i]);
          // Totals of 2^8 keep every window within L, and the state a double.
          if (top === 256) {
            expect(writer.state).toBeLessThan(2n ** 53n);
          }
        }
        expect(writer.digits()).toEqual(expectTrip(events, size));
      }
    }
  });

  it('round-trips the switches between double and BigInt states, past 2^53 included', () => {
    const near = [MAX_SAFE, MAX_SAFE - 1, 2 ** 52 + 1, 2 ** 52, 3 * 2 ** 50];
    const small: Event[] = [
      [0, 1, 2, false],
      [5, 3, 10, true],
      [200, 1, 256, false],
      [1, 1000, 2 ** 20, true],
    ];
    for (const size of BASES) {
      // Weighted totals near 2^53 with their widest buckets, each just below
      // B of the one before: B grows to 2·(2^53 − 4), then 3·(2^53 − 6), and
      // k of the slot of 2 after them passes 2^53 too, before the small
      // totals take the window back to ⌊L/T⌋.
      const past: Event[] = [
        [0, MAX_SAFE - 1, MAX_SAFE, true],
        [1, MAX_SAFE - 3, MAX_SAFE - 2, true],
        [0, MAX_SAFE - 5, MAX_SAFE - 4, true],
        [1, 1, 2, false],
        ...small,
        ...small,
      ];
      // The state leaves the doubles at the large totals, once the bytes
      // after them have filled it past their windows, and comes back.
      const bytes = Array.from({ length: 20 }, (): Event => [200, 1, 256, false]);
      const message = [...small, ...past, ...bytes];
      const writer = writerOf(message, size);
      const states: bigint[] = [];
      for (let i = message.length - 1; i >= 0; i--) {
        writer.push(...message[i]);
        states.push(writer.state);
      }
      expect(states.some((state) => state > 2n ** 53n)).toBe(true);
      expect(states[states.length - 1]).toBeLessThan(2n ** 53n);
      expect(writer.digits()).toEqual(expectTrip(message, size));
      expectTrip(past, size);
      for (const total of near) {
        for (const big of [
          [total - 1, 1, total, false],
          [0, total - 1, total, true],
          [1, total - 1, total, true],
          [12345, 2 ** 40, total, true],
        ] as Event[]) {
          expectTrip([big, ...small], size);
          expectTrip([...small, big], size);
          expectTrip([...small, big, big, ...small, big], size);
        }
      }
    }
  });

  it('spends the information content of a long message, plus a few digits', () => {
    for (const size of [2, 10, 256]) {
      const events = Array.from({ length: 3000 }, () => randomEvent(2 ** 20));
      const bits = events.reduce((sum, [, freq, total]) => sum + Math.log2(total / freq), 0);
      const digits = expectTrip(events, size);
      expect(digits.length).toBeLessThanOrEqual(Math.ceil(bits / Math.log2(size)) + 2);
    }
  });

  it('spends nothing on symbols at residual 0 that end the message', () => {
    const tail: Event[] = [
      [0, 1, 1000, false],
      [0, 7, 9, true],
      [0, 1, 2, false],
    ];
    const head: Event[] = [[5, 1, 7, false]];
    expect(write([...head, ...tail, ...tail], 256)).toEqual(write(head, 256));
    expectTrip([...head, ...tail, ...tail], 256);
  });

  it('reads nothing for a weighted bucket holding every state, before or after a read', () => {
    const digits = write([[3, 1, 10, false]], 10);
    const full = (): readonly [string, number, number] => ['all', 0, 10];
    const reader = new StreamReader((i) => digits[i], digits.length, 10);
    expect(reader.weighted(10, full)).toBe('all');
    expect(reader.position).toBe(0);
    expect(reader.uniform(10)).toBe(3);
    expect(reader.weighted(10, full)).toBe('all');
    expect([reader.state, reader.position]).toEqual([0n, digits.length]);
    // The same around a total whose window takes a BigInt state.
    const wide = write([[3, 1, MAX_SAFE, false]], 10);
    const all = (): readonly [string, number, number] => ['all', 0, MAX_SAFE];
    const big = new StreamReader((i) => wide[i], wide.length, 10);
    expect(big.weighted(MAX_SAFE, all)).toBe('all');
    expect(big.position).toBe(0);
    expect(big.uniform(MAX_SAFE)).toBe(3);
    expect([big.state, big.position]).toEqual([0n, wide.length]);
  });

  it('reads a symbol whose cdf hands the full width to one end only', () => {
    // The bucket at residual 0 claims all ten states, the one at 9 does not:
    // not a full bucket, so the digits are read and the residual decides.
    const digits = write([[9, 1, 10, true]], 10);
    const locate = (r: number): readonly [number, number, number] =>
      r === 9 ? [9, 9, 1] : [0, 0, 10];
    const reader = new StreamReader((i) => digits[i], digits.length, 10);
    expect(reader.weighted(10, locate)).toBe(9);
    expect(reader.position).toBe(digits.length);
  });

  it('refuses a locate that misses the residual, on a small state or a large one', () => {
    const misses: [number, number][] = [
      [0.5, 1],
      [0, 1.5],
      [0, 0],
      [-1, 2],
      [5, 1],
      [0, 1],
      [0, 11],
    ];
    const small = write([[4, 1, 10, true]], 256);
    const large = write(
      [
        [4, 1, 10, true],
        [MAX_SAFE - 1, 1, MAX_SAFE, false],
      ],
      256
    );
    for (const [cum, freq] of misses) {
      for (const digits of [small, large]) {
        const reader = new StreamReader((i) => digits[i], digits.length, 256);
        expect(() => reader.weighted(10, () => ['x', cum, freq] as const)).toThrow(
          new RegExp(`^locate returned a bucket that does not contain the residual: \\[${cum}, `)
        );
      }
    }
  });
});
