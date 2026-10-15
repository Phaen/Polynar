/**
 * Mixtures: a value written several ways at once, the choice left to the
 * fold and given back by the decoder. Round trips over random messages of
 * plain symbols and mixtures, of up to 64 choices with weights up to 2^20,
 * at the message's start and end, back to back, inside transactions and
 * `decide`, in every output base; and the bits a mixture costs against the
 * ideal. Seeded, so failures reproduce.
 */

import { Decoder, Encoder, ReplayDecoder, CorruptInputError } from '../packer';
import type { CodecOptions } from '../packer';
import { MixtureLayout, choiceCum, measure } from '../packer/mixture';
import { StreamReader, StreamWriter, TupleLocator } from '../packer/stream';
import { mulberry32 } from './support';

const rand = mulberry32(0xb175bac);
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

/** One plain symbol: the bucket `[cum, cum + freq)` of `total` states, uniform or weighted. */
type Event = readonly [cum: number, freq: number, total: number, weighted: boolean];

/** A table of `freqs` over its symbols, as a decoder locates in it. */
interface Table {
  readonly freqs: readonly number[];
  readonly cums: readonly number[];
  readonly total: number;
}

const tableOf = (freqs: readonly number[]): Table => {
  const cums: number[] = [];
  let total = 0;
  for (const freq of freqs) {
    cums.push(total);
    total += freq;
  }
  return { freqs, cums, total };
};

const locateIn =
  ({ freqs, cums }: Table) =>
  (residual: number): readonly [number, number, number] => {
    let s = 0;
    while (cums[s] + freqs[s] <= residual) {
      s++;
    }
    return [s, cums[s], freqs[s]];
  };

/** The buckets a weighted event splits its total into: below it, it, and above it. */
const around =
  ([cum, freq, total]: Event) =>
  (r: number): readonly [number, number, number] =>
    r < cum
      ? [0, 0, cum]
      : r < cum + freq
        ? [cum, cum, freq]
        : [cum + freq, cum + freq, total - cum - freq];

/**
 * A value of a mixture: choice j spells it as j under `prior`, the symbols
 * of `head[j]`, the value under `tables[j]`, then `tail[j]`.
 */
interface Mix {
  readonly weights: readonly number[];
  readonly prior: Table;
  readonly head: readonly (readonly Event[])[];
  readonly tables: readonly Table[];
  readonly tail: readonly (readonly Event[])[];
  readonly value: number;
}

type Op = { readonly plain: Event } | { readonly mix: Mix };

const writeEvent = (enc: Encoder, [cum, freq, total, weighted]: Event): void => {
  if (weighted) {
    enc.composeWeighted(cum, freq, total);
  } else {
    enc.compose(cum, total);
  }
};

/** Reads `event` back, expecting its value. */
const readEvent = (dec: Decoder, event: Event): void => {
  const [cum, , total, weighted] = event;
  const got = weighted ? dec.parseWeighted(total, around(event)) : dec.parse(total);
  expect(got).toBe(cum);
};

const writeChoice = (enc: Encoder, mix: Mix, j: number): void => {
  const { prior, head, tables, tail, value } = mix;
  enc.composeWeighted(prior.cums[j], prior.freqs[j], prior.total);
  head[j].forEach((event) => writeEvent(enc, event));
  const table = tables[j];
  enc.composeWeighted(table.cums[value], table.freqs[value], table.total);
  tail[j].forEach((event) => writeEvent(enc, event));
};

const writeOp = (enc: Encoder, op: Op): void => {
  if ('plain' in op) {
    writeEvent(enc, op.plain);
  } else {
    const { mix } = op;
    enc.composeMixture(mix.weights, (j) => writeChoice(enc, mix, j));
  }
};

/** Reads `op` back, expecting its value; returns the choice a mixture read. */
const readOp = (dec: Decoder, op: Op): number => {
  if ('plain' in op) {
    readEvent(dec, op.plain);
    return -1;
  }
  const { prior, head, tables, tail, value, weights } = op.mix;
  const j = dec.parseWeighted(prior.total, locateIn(prior));
  head[j].forEach((event) => readEvent(dec, event));
  expect(dec.parseWeighted(tables[j].total, locateIn(tables[j]))).toBe(value);
  tail[j].forEach((event) => readEvent(dec, event));
  dec.parseMixture(weights, j);
  return j;
};

/** A random plain symbol, its total up to `top`. */
const randomEvent = (top = 2 ** 20): Event => {
  const total = randInt(2, top);
  if (rand() < 0.5) {
    return [randInt(0, total - 1), 1, total, false];
  }
  const freq = randInt(1, total - 1);
  return [randInt(0, total - freq), freq, total, true];
};

const randomEvents = (count: number, top?: number): Event[] =>
  Array.from({ length: count }, () => randomEvent(top));

/** Random positive freqs, `count` of them, each up to `top`. */
const randomFreqs = (count: number, top: number): number[] =>
  Array.from({ length: count }, () => randInt(1, top));

/** A random mixture of up to `choices` choices, weights up to `top`, some of them 0. */
const randomMix = (choices = 64, top = 2 ** 20, eventTop?: number): Mix => {
  const K = randInt(1, choices);
  const weights = Array.from({ length: K }, () => (rand() < 0.15 ? 0 : randInt(1, top)));
  if (!weights.some((w) => w > 0)) {
    weights[randInt(0, K - 1)] = randInt(1, top);
  }
  const V = randInt(1, 40);
  return {
    weights,
    prior: tableOf(randomFreqs(K, randInt(1, 1000))),
    head: Array.from({ length: K }, () => randomEvents(randInt(0, 3), eventTop)),
    tables: Array.from({ length: K }, () => tableOf(randomFreqs(V, randInt(1, 5000)))),
    tail: Array.from({ length: K }, () => randomEvents(randInt(0, 3), eventTop)),
    value: randInt(0, V - 1),
  };
};

const randomOps = (count: number, mixShare: number): Op[] =>
  Array.from({ length: count }, () =>
    rand() < mixShare ? { mix: randomMix() } : { plain: randomEvent() }
  );

const CHARSETS: readonly CodecOptions<'text'>[] = [
  { type: 'text', charset: [0, 1] },
  { type: 'text', charset: '0123456789' },
  { type: 'text' },
  { type: 'text', charset: [0, 0xd7ff] },
];

/** Encodes `ops`, decodes them back, and returns the output and the choices read. */
const trip = (ops: readonly Op[], options: CodecOptions<'text'> = { type: 'text' }) => {
  const enc = new Encoder();
  ops.forEach((op) => writeOp(enc, op));
  const out = enc.output({ ...options, type: 'text' });
  const dec = new Decoder(out, options);
  const choices = ops.map((op) => readOp(dec, op));
  dec.finalize();
  const replay = new ReplayDecoder(enc);
  ops.forEach((op) => readOp(replay, op));
  replay.finalize();
  return { out, choices };
};

describe('composeMixture', () => {
  it('round-trips random messages of plain symbols and mixtures in every base', () => {
    for (let round = 0; round < 300; round++) {
      const ops = randomOps(randInt(0, 30), rand());
      trip(ops, CHARSETS[round % CHARSETS.length]);
    }
  });

  it('round-trips under a checksum and as bytes', () => {
    for (let round = 0; round < 40; round++) {
      const ops = randomOps(randInt(1, 20), 0.5);
      const enc = new Encoder();
      ops.forEach((op) => writeOp(enc, op));
      const bytes = enc.output({ checksum: 16 });
      const dec = new Decoder(bytes, { checksum: 16 });
      ops.forEach((op) => readOp(dec, op));
      dec.finalize();
    }
  });

  it('round-trips a mixture alone, first, last and many back to back', () => {
    for (let round = 0; round < 100; round++) {
      trip([{ mix: randomMix() }], CHARSETS[round % CHARSETS.length]);
      trip([{ mix: randomMix() }, ...randomOps(5, 0)]);
      trip([...randomOps(5, 0), { mix: randomMix() }]);
    }
    for (let round = 0; round < 10; round++) {
      trip(
        Array.from({ length: 300 }, () => ({ mix: randomMix(randInt(2, 8)) })),
        CHARSETS[round % CHARSETS.length]
      );
    }
  });

  it('round-trips spellings of huge totals and mixtures past the window', () => {
    for (let round = 0; round < 150; round++) {
      const ops: Op[] = Array.from({ length: randInt(1, 12) }, () => {
        if (rand() < 0.4) {
          return { plain: randomEvent(Number.MAX_SAFE_INTEGER) };
        }
        const mix = randomMix(4, rand() < 0.3 ? 2 ** 51 : 2 ** 20, Number.MAX_SAFE_INTEGER);
        return { mix };
      });
      trip(ops, CHARSETS[round % CHARSETS.length]);
    }
  });

  it('takes choices in proportion to their weights', () => {
    const weights = [1, 3, 0, 4];
    const counts = [0, 0, 0, 0];
    const ops: Op[] = [];
    for (let i = 0; i < 4000; i++) {
      ops.push({ plain: [randInt(0, 255), 1, 256, false] });
      ops.push({
        mix: {
          weights,
          prior: tableOf([1, 1, 1, 1]),
          head: [[], [], [], []],
          tables: [tableOf([1]), tableOf([1]), tableOf([1]), tableOf([1])],
          tail: [[], [], [], []],
          value: 0,
        },
      });
    }
    const { choices } = trip(ops, { type: 'text' });
    choices.forEach((j) => j >= 0 && counts[j]++);
    expect(counts[2]).toBe(0);
    expect(counts[0] / 4000).toBeCloseTo(1 / 8, 1);
    expect(counts[1] / 4000).toBeCloseTo(3 / 8, 1);
    expect(counts[3] / 4000).toBeCloseTo(4 / 8, 1);
  });

  it('spells the heaviest choice where nothing follows', () => {
    const mix: Mix = {
      weights: [2, 0, 5, 5],
      prior: tableOf([1, 1, 1, 1]),
      head: [[], [], [], []],
      tables: [tableOf([1]), tableOf([1]), tableOf([1]), tableOf([1])],
      tail: [[], [], [], []],
      value: 0,
    };
    expect(trip([{ mix }]).choices).toEqual([2]);
  });

  it('writes a lone choice of positive weight as it is', () => {
    const enc = new Encoder();
    enc.composeMixture([0, 7, 0], (j) => enc.compose(j, 3));
    expect(enc.events().totals).toEqual([3]);
    const out = enc.output();
    const dec = new Decoder(out);
    expect(dec.parse(3)).toBe(1);
    dec.parseMixture([0, 7, 0], 1);
    dec.finalize();
  });

  it('round-trips inside transactions and decide', () => {
    for (let round = 0; round < 60; round++) {
      const kept = randomOps(randInt(1, 6), 0.5);
      const dropped = randomOps(randInt(1, 6), 0.5);
      const choices = [randomOps(randInt(1, 6), 0.6), randomOps(randInt(1, 6), 0.6)];
      const enc = new Encoder({ checkDecisions: round % 2 === 1 });
      kept.forEach((op) => writeOp(enc, op));
      const mark = enc.mark();
      dropped.forEach((op) => writeOp(enc, op));
      expect(enc.bitsSince(mark)).toBeGreaterThanOrEqual(0);
      enc.rollback(mark);
      const pick = enc.decide([0, 1], [1, 0], (c) => {
        // A mixture whose spellings decide in turn.
        enc.composeMixture([3, 5], (j) =>
          enc.decide([0, 1], [0, 1], (d) => enc.compose(2 * j + d, 4))
        );
        choices[c].forEach((op) => writeOp(enc, op));
      });
      const out = enc.output({ type: 'text' });
      const dec = new Decoder(out);
      kept.forEach((op) => readOp(dec, op));
      const j = Math.floor(dec.parse(4) / 2);
      dec.parseMixture([3, 5], j);
      choices[pick].forEach((op) => readOp(dec, op));
      dec.finalize();
    }
  });

  it('prices a mixture at −log2 of the sum of its spellings’ probabilities', () => {
    const enc = new Encoder();
    const mark = enc.mark();
    // Spellings of 1/4 and 1/8: 3/8 together.
    enc.composeMixture([2, 1], (j) => enc.composeWeighted(0, 1, j === 0 ? 4 : 8));
    expect(enc.bitsSince(mark)).toBeCloseTo(-Math.log2(3 / 8), 5);
    enc.compose(1, 2);
    expect(enc.bitsSince(mark)).toBeCloseTo(1 - Math.log2(3 / 8), 5);
    enc.commit(mark);
    // Spellings that cost nothing between them are priced at 0.
    const free = enc.mark();
    enc.composeMixture([1, 1], () => undefined);
    expect(enc.bitsSince(free)).toBe(0);
    enc.rollback(free);
  });

  it('charges a mixture to the tries of decide as a whole', () => {
    const enc = new Encoder();
    // Candidate 0 costs 3 bits; candidate 1 a mixture of 2 bits and 4 bits
    // at most, which is less, so it wins once tried under budget.
    const pick = enc.decide([0, 1], [0, 1], (c) => {
      if (c === 0) {
        enc.compose(0, 8);
      } else {
        enc.composeMixture([4, 1], (j) => enc.composeWeighted(j, 1, j === 0 ? 4 : 16));
      }
    });
    expect(pick).toBe(1);
    const lose = enc.decide([0, 1], [0, 1], (c) => {
      if (c === 0) {
        enc.compose(0, 2);
      } else {
        enc.composeMixture([1, 1], (j) => enc.composeWeighted(j, 1, 64));
      }
    });
    expect(lose).toBe(0);
  });

  it('refuses spellings that are not plain symbols, and takes back what they wrote', () => {
    const enc = new Encoder();
    const group = {};
    expect(() =>
      enc.composeMixture([1, 1], (j) => enc.composeMixture([1, 2], (k) => enc.compose(j + k, 4)))
    ).toThrow(new TypeError('A mixture spelling cannot write a mixture'));
    expect(() => enc.composeMixture([1, 1], () => enc.composeSelector(group, [[0, 1, 2]]))).toThrow(
      new TypeError('A mixture spelling cannot write a selector or alternatives')
    );
    expect(enc.events().totals).toEqual([]);
    // A lone choice inside a spelling is a plain write.
    enc.composeMixture([1, 1], (j) => enc.composeMixture([0, 1], () => enc.compose(j, 2)));
    const dec = new Decoder(enc.output());
    const j = dec.parse(2);
    dec.parseMixture([0, 1], 1);
    dec.parseMixture([1, 1], j);
    dec.finalize();
  });

  it('refuses weights that lay out no choice', () => {
    const enc = new Encoder();
    const write = (): void => undefined;
    expect(() => enc.composeMixture([], write)).toThrow(
      new RangeError('A mixture needs a choice of positive weight')
    );
    expect(() => enc.composeMixture([0, 0], write)).toThrow(RangeError);
    expect(() => enc.composeMixture([1, 0.5], write)).toThrow(
      new TypeError('Weight must be an integer, got 0.5')
    );
    expect(() => enc.composeMixture([1, -1], write)).toThrow(
      new RangeError('Weight -1 is negative')
    );
    expect(() => enc.composeMixture([2 ** 53, 2 ** 53], write)).toThrow(RangeError);
  });

  it('refuses a choice of weight 0 on decode, and a replay of another bucket', () => {
    const dec = new Decoder(new Uint8Array([1]));
    expect(() => dec.parseMixture([1, 0], 1)).toThrow(CorruptInputError);
    expect(() => dec.parseMixture([1, 0], 5)).toThrow(CorruptInputError);
    const enc = new Encoder();
    enc.composeMixture([1, 1], (j) => enc.compose(j, 2));
    const replay = new ReplayDecoder(enc);
    replay.parse(2);
    expect(() => replay.parseMixture([1, 1], 1)).toThrow(
      new TypeError('Replay read event 1 as a bucket other than the one logged')
    );
  });

  it('puts nothing back past the end of the input', () => {
    // Reads past the input decode as zeros, and the choice owning residual 0 folds back to 0.
    const dec = new Decoder(new Uint8Array(0));
    expect(dec.parse(5)).toBe(0);
    dec.parseMixture([1, 9], 1);
    dec.finalize();
  });

  it('counts the choices put back past the input, but for the first 64, against the limit', () => {
    // A choice read and put back at even weights takes and gives back the
    // same bit, so the state never drains: only the limit stops the loop.
    const input = Uint8Array.of(0x5a, 0xc3, 0x0f);
    const dec = new Decoder(input, { limit: 1000 });
    let rounds = 0;
    expect(() => {
      for (;;) {
        dec.parseMixture(
          [1, 1],
          dec.parseWeighted(2, (r) => [r, r, 1])
        );
        rounds++;
      }
    }).toThrow(
      new CorruptInputError(
        'Input decodes to more values past its end than the decode limit allows'
      )
    );
    expect(rounds).toBeGreaterThanOrEqual(1000 + 64);
    expect(rounds).toBeLessThan(1000 + 64 + 24);
    // A message ending in mixtures puts the last few back past its input:
    // the first 64 of those are free, so it decodes under any limit.
    const ops: Op[] = Array.from({ length: 200 }, () => ({ mix: randomMix(4) }));
    const enc = new Encoder();
    ops.forEach((op) => writeOp(enc, op));
    const bytes = enc.output();
    const read = (limit: number): void => {
      const back = new Decoder(bytes, { limit });
      ops.forEach((op) => readOp(back, op));
      back.finalize();
    };
    expect(() => read(0)).not.toThrow();
  });
});

describe('composePriced', () => {
  /** The bucket `[0, 1)` of `total` states, located the way a decoder reads it. */
  const first = (total: number) => (r: number) =>
    r < 1 ? ([0, 0, 1] as const) : ([1, 1, total - 1] as const);

  it('weighs by what the spellings cost, in 2^20ths of a bit', () => {
    const weigh = jest.fn().mockReturnValue([2, 1]);
    const enc = new Encoder();
    enc.composePriced(2, weigh, (j) => {
      enc.compose(j, 2);
      enc.composeWeighted(0, 1, j === 0 ? 4 : 8);
    });
    enc.compose(1, 2);
    // One bit of choice, then two bits or three.
    expect(weigh).toHaveBeenCalledTimes(1);
    expect(weigh).toHaveBeenCalledWith([3 * 2 ** 20, 4 * 2 ** 20]);
    const dec = new Decoder(enc.output());
    const j = dec.parse(2);
    dec.parseWeighted(j === 0 ? 4 : 8, first(j === 0 ? 4 : 8));
    dec.parseMixture([2, 1], j);
    expect(dec.parse(2)).toBe(1);
    dec.finalize();
  });

  it('writes a lone choice of positive weight as it is', () => {
    const enc = new Encoder();
    enc.composePriced(
      2,
      () => [0, 5],
      (j) => {
        enc.compose(j, 2);
        enc.composeWeighted(0, 1, j === 0 ? 4 : 8);
      }
    );
    expect(Array.from(enc.events().totals)).toEqual([2, 8]);
    expect(Array.from(enc.events().weighted)).toEqual([false, true]);
    const dec = new Decoder(enc.output());
    expect(dec.parse(2)).toBe(1);
    dec.parseWeighted(8, first(8));
    dec.parseMixture([0, 5], 1);
    dec.finalize();
  });

  it('refuses weights of the wrong count, leaving the log empty', () => {
    const enc = new Encoder();
    expect(() =>
      enc.composePriced(
        2,
        () => [1],
        (j) => enc.compose(j, 2)
      )
    ).toThrow(new RangeError('Expected 2 weights, got 1'));
    expect(enc.events().totals).toHaveLength(0);
  });

  it('takes back a spelling that throws, whole', () => {
    const enc = new Encoder();
    enc.compose(1, 3);
    const before = Array.from(enc.events().totals);
    expect(() =>
      enc.composePriced(
        2,
        () => [1, 1],
        (j) => {
          enc.compose(0, 5);
          if (j === 1) {
            throw new Error('spelling failed');
          }
        }
      )
    ).toThrow(new Error('spelling failed'));
    expect(Array.from(enc.events().totals)).toEqual(before);
    enc.composeMixture([1, 1], (j) => enc.compose(j, 2));
    enc.compose(0, 2);
    expect(Array.from(enc.events().totals)).toEqual([3, 2, 2, 2]);
  });

  /** A state the spellings change through the journal, as a model's learning does. */
  const counter = (enc: Encoder) => {
    const state = { n: 0 };
    const bump = () => {
      enc.journal.set(state, 'n', state.n);
      state.n++;
    };
    return { state, bump };
  };

  it('keeps what the kept spelling changes, the spellings after it written from there', () => {
    const enc = new Encoder();
    const { state, bump } = counter(enc);
    const seen: number[] = [];
    enc.composePriced(
      2,
      () => [1, 1],
      (j) => {
        seen.push(state.n);
        if (j === 0) {
          bump();
        }
        enc.compose(j, 2);
      },
      0
    );
    expect(seen).toEqual([0, 1]);
    expect(state.n).toBe(1);
    expect(enc.events().totals).toHaveLength(2);
  });

  it('takes back every spelling when one after the kept one throws', () => {
    const enc = new Encoder();
    const { state, bump } = counter(enc);
    expect(() =>
      enc.composePriced(
        2,
        () => [1, 1],
        (j) => {
          bump();
          if (j === 1) {
            throw new Error('spelling failed');
          }
        },
        0
      )
    ).toThrow(new Error('spelling failed'));
    expect(state.n).toBe(0);
    expect(enc.events().totals).toHaveLength(0);
  });

  it('keeps the kept spelling within a transaction, which a rollback takes back', () => {
    const enc = new Encoder();
    const { state, bump } = counter(enc);
    const mark = enc.mark();
    enc.composePriced(
      2,
      () => [1, 1],
      (j) => {
        if (j === 1) {
          bump();
        }
        enc.compose(j, 2);
      },
      1
    );
    expect(state.n).toBe(1);
    enc.rollback(mark);
    expect(state.n).toBe(0);
    expect(enc.events().totals).toHaveLength(0);
  });

  it('cannot be written by a mixture spelling', () => {
    const enc = new Encoder();
    expect(() =>
      enc.composeMixture([1, 1], () =>
        enc.composePriced(
          2,
          () => [1, 1],
          (j) => enc.compose(j, 2)
        )
      )
    ).toThrow(new TypeError('A mixture spelling cannot write a mixture'));
  });
});

describe('MixtureLayout', () => {
  it('lays out the heaviest choice first, then the rest in order', () => {
    const layout = new MixtureLayout([3, 0, 5, 5, 1]);
    expect(layout.top).toBe(2);
    expect(layout.only).toBe(-1);
    expect(layout.total).toBe(14);
    expect(layout.cums).toEqual([5, 0, 0, 8, 13]);
    const owners = Array.from({ length: 14 }, (_, r) => layout.locate(r)[0]);
    expect(owners).toEqual([2, 2, 2, 2, 2, 0, 0, 0, 3, 3, 3, 3, 3, 4]);
    expect(new MixtureLayout([0, 4]).only).toBe(1);
  });
});

describe('measure / choiceCum', () => {
  it('give what MixtureLayout lays out', () => {
    const random = mulberry32(5);
    for (let round = 0; round < 300; round++) {
      const weights = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
        random() < 0.3 ? 0 : 1 + Math.floor(random() * 20)
      );
      if (!weights.some((w) => w > 0)) {
        weights[0] = 1;
      }
      const layout = new MixtureLayout(weights);
      const { total, top, owners } = measure(weights);
      expect([total, top, owners === 1 ? top : -1]).toEqual([
        layout.total,
        layout.top,
        layout.only,
      ]);
      weights.forEach((w, j) => {
        if (w > 0) {
          expect(choiceCum(weights, top, j)).toBe(layout.cums[j]);
        }
      });
    }
  });

  it('measure refuses what MixtureLayout refuses', () => {
    expect(() => measure([1.5])).toThrow(new TypeError('Weight must be an integer, got 1.5'));
    expect(() => measure([-1, 2])).toThrow(new RangeError('Weight -1 is negative'));
    expect(() => measure([0, 0])).toThrow(
      new RangeError('A mixture needs a choice of positive weight')
    );
    expect(() => measure([2 ** 53, 2 ** 53])).toThrow(RangeError);
  });
});

describe('StreamWriter.unmix', () => {
  it('round-trips latent choices under narrow windows', () => {
    // L of 2^6 to 2^12 with totals up to 2^10 puts the latent windows above,
    // below and at ⌊L/T⌋.
    for (let round = 0; round < 400; round++) {
      const size = randInt(2, 20);
      const L = 2 ** randInt(6, 12);
      type Item =
        | { readonly event: Event }
        | { readonly layout: MixtureLayout; readonly spellings: readonly Event[][] };
      const items: Item[] = Array.from({ length: randInt(1, 12) }, () => {
        if (rand() < 0.5) {
          return { event: randomEvent(1024) };
        }
        const layout = new MixtureLayout(
          Array.from({ length: randInt(2, 6) }, () => randInt(0, 300))
        );
        const K = layout.weights.length;
        // Choice j's spelling opens with j as a uniform slot, so it reads back.
        const spellings = Array.from({ length: K }, (_, j): Event[] => [
          [j, 1, K, false],
          ...randomEvents(randInt(0, 3), 1024),
        ]);
        return { layout, spellings };
      });
      const valid = items.filter((item) => !('layout' in item) || item.layout.only < 0);
      const totals = valid.map((item) => ('event' in item ? item.event[2] : item.layout.total));
      const freqs = valid.map((item) => ('event' in item ? item.event[1] : 0));
      const writer = new StreamWriter(size, totals, freqs, 0, L);
      const spellingOf = (events: readonly Event[]) => ({
        cums: events.map((e) => e[0]),
        freqs: events.map((e) => e[1]),
        totals: events.map((e) => e[2]),
        weighted: events.map((e) => e[3]),
      });
      for (let i = valid.length - 1; i >= 0; i--) {
        const item = valid[i];
        if ('event' in item) {
          writer.push(...item.event);
        } else {
          writer.unmix(
            item.layout.total,
            (r) => item.layout.locate(r),
            (j) => spellingOf(item.spellings[j])
          );
        }
      }
      const digits = writer.digits();
      const reader = new StreamReader((i) => digits[i], digits.length, size, L);
      const readBack = (event: Event): number =>
        event[3]
          ? reader.weighted(event[2], new TupleLocator(around(event)), true)
          : reader.uniform(event[2]);
      for (const item of valid) {
        if ('event' in item) {
          expect(readBack(item.event)).toBe(item.event[0]);
        } else {
          const K = item.layout.weights.length;
          const j = reader.uniform(K);
          expect(item.layout.weights[j]).toBeGreaterThan(0);
          for (const event of item.spellings[j].slice(1)) {
            expect(readBack(event)).toBe(event[0]);
          }
          reader.mix(item.layout.cums[j], item.layout.weights[j], item.layout.total);
        }
      }
      expect(reader.state).toBe(0n);
      expect(reader.position).toBe(digits.length);
    }
  });

  it('round-trips spellings whose windows pass 2^53', () => {
    const L = 2 ** 6;
    const MAX_SAFE = Number.MAX_SAFE_INTEGER;
    // Totals near 2^53 with their widest buckets, each just below B of the
    // one before, grow B to 3·(2^53 − 6), and k of the slot of 2 after them
    // passes 2^53.
    const ladder: Event[] = [
      [0, MAX_SAFE - 1, MAX_SAFE, true],
      [0, MAX_SAFE - 3, MAX_SAFE - 2, true],
      [0, MAX_SAFE - 5, MAX_SAFE - 4, true],
      [0, 1, 2, true],
    ];
    for (const size of [2, 3, 10]) {
      const layout = new MixtureLayout([5, 3]);
      const spellings = [0, 1].map((j): Event[] => [[j, 1, 2, false], ...ladder]);
      const after: Event = [7, 1, 9, false];
      const writer = new StreamWriter(size, [layout.total, 9], [0, 1], 0, L);
      writer.push(...after);
      writer.unmix(
        layout.total,
        (r) => layout.locate(r),
        (j) => ({
          cums: spellings[j].map((e) => e[0]),
          freqs: spellings[j].map((e) => e[1]),
          totals: spellings[j].map((e) => e[2]),
          weighted: spellings[j].map((e) => e[3]),
        })
      );
      const digits = writer.digits();
      const reader = new StreamReader((i) => digits[i], digits.length, size, L);
      const j = reader.uniform(2);
      for (const event of spellings[j].slice(1)) {
        expect(reader.weighted(event[2], new TupleLocator(around(event)), true)).toBe(0);
      }
      reader.mix(layout.cums[j], layout.weights[j], layout.total);
      expect(reader.uniform(9)).toBe(7);
      expect(reader.state).toBe(0n);
      expect(reader.position).toBe(digits.length);
    }
  });
});
