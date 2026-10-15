/**
 * Adaptive priors: the adaptation's checks, the live-table helpers, the
 * table that learns a message's values on top of its fixed weights, and the
 * user-facing prior that picks the cheapest of its static spelling and the
 * ladder's adaptive ones per message, and its estimate of a bucket.
 */

import { Encoder, Decoder } from '../../packer';
import {
  AdaptivePrior,
  AdaptiveTable,
  BLEND_SHARE,
  DEFAULT_ADAPTIVE_WINDOW,
  Lineage,
  LiveCounts,
  LADDER,
  MAX_ADAPTIVE_MEMBERS,
  checkAdaptation,
  checkAdaptiveMembers,
  lineageOf,
  readLive,
  withLineage,
  writeLive,
} from '../../nodes/adaptive';
import { Exclusion, excludedBucket } from '../../nodes/excluded';
import { Fenwick } from '../../nodes/fenwick';
import { buildWeights, readTable, writeTable } from '../../nodes/weights';
import { mulberry32 } from '../support';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const ones = (n: number): number[] => new Array<number>(n).fill(1);
const sum = (list: readonly number[]): number => list.reduce((a, b) => a + b, 0);

/** The buckets an adaptive table should give: fixed weights at `prior` observations plus a learned list. */
class Model {
  readonly learned: number[];
  private readonly total: number;

  constructor(
    private readonly weights: readonly number[],
    private readonly prior: number,
    private readonly window: number
  ) {
    this.learned = weights.map(() => 0);
    this.total = sum(weights);
  }

  bucket(pos: number): [number, number, number] {
    const { weights, prior, total, learned } = this;
    return [
      sum(weights.slice(0, pos)) * prior + sum(learned.slice(0, pos)) * total,
      weights[pos] * prior + learned[pos] * total,
      total * (prior + sum(learned)),
    ];
  }

  bump(pos: number): void {
    this.learned[pos]++;
    if (sum(this.learned) > this.window) {
      for (let i = 0; i < this.learned.length; i++) {
        this.learned[i] = Math.floor(this.learned[i] / 2);
      }
    }
  }
}

const learned = (table: AdaptiveTable, side: Encoder | Decoder): number[] => {
  const counts = table.live(side).learned;
  return Array.from({ length: counts.size }, (_, i) => counts.count(i));
};

/** A seeded sequence of `length` members below `members`, member 0 drawn with probability `skew`. */
const sequence = (seed: number, length: number, members: number, skew = 0): number[] => {
  const random = mulberry32(seed);
  return Array.from({ length }, () => (random() < skew ? 0 : Math.floor(random() * members)));
};

describe('checkAdaptation', () => {
  it('keeps only the declared options, leaving the defaults to the table', () => {
    expect(checkAdaptation(undefined, 'w')).toEqual({});
    expect(checkAdaptation({}, 'w')).toEqual({});
    expect('window' in checkAdaptation({}, 'w')).toBe(false);
    expect(checkAdaptation({ window: 1 }, 'w')).toEqual({ window: 1 });
    expect(checkAdaptation({ window: MAX_SAFE }, 'w')).toEqual({ window: MAX_SAFE });
  });

  it.each([
    [0, RangeError],
    [-1, RangeError],
    [2 ** 53, RangeError],
    [Infinity, TypeError],
    [1.5, TypeError],
    [NaN, TypeError],
  ])('refuses a window of %p', (n, kind) => {
    expect(() => checkAdaptation({ window: n }, 'w')).toThrow(
      new kind(`w adaptive window must be a positive integer, got ${n}`)
    );
  });
});

describe('checkAdaptiveMembers', () => {
  it('passes up to the limit and refuses past it', () => {
    expect(MAX_ADAPTIVE_MEMBERS).toBe(65536);
    expect(() => checkAdaptiveMembers(MAX_ADAPTIVE_MEMBERS, 'w')).not.toThrow();
    expect(() => checkAdaptiveMembers(MAX_ADAPTIVE_MEMBERS + 1, 'w')).toThrow(
      new RangeError('w adaptive prior spans 65537 values, above the limit 65536')
    );
  });
});

describe('writeLive and readLive', () => {
  it('round-trip members of a Fenwick, empty buckets included', () => {
    const table = new Fenwick([3, 0, 1, 0, 5]);
    const positions = [4, 0, 2, 4, 4, 0];
    const enc = new Encoder();
    for (const pos of positions) {
      writeLive(enc, table, pos);
    }
    const dec = new Decoder(enc.output());
    expect(positions.map(() => readLive(dec, table))).toEqual(positions);
    dec.finalize();
    expect(() => writeLive(new Encoder(), table, 1)).toThrow(RangeError);
  });

  it('write and read nothing for a lone member', () => {
    const table = new Fenwick([7]);
    const enc = new Encoder();
    writeLive(enc, table, 0);
    expect(enc.output()).toEqual(new Encoder().output());
    const dec = new Decoder(new Encoder().output());
    expect(readLive(dec, table)).toBe(0);
    dec.finalize();
  });
});

describe('AdaptiveTable', () => {
  const W = DEFAULT_ADAPTIVE_WINDOW;

  it('refuses weights buildWeights refuses, too many members, a bad prior or window, a small window, and an overflowing total', () => {
    expect(() => new AdaptiveTable([], 0, 1, W, 'w')).toThrow(
      new RangeError('w weights need at least one value, got 0')
    );
    expect(() => new AdaptiveTable([1, 0], 2, 2, W, 'w')).toThrow(
      new TypeError('w weights must be positive integers, got 0')
    );
    expect(() => new AdaptiveTable([1, 1], 3, 3, W, 'w')).toThrow(
      new TypeError('w weights must list one weight per value: expected 3, got 2')
    );
    expect(() => new AdaptiveTable([1, 1], 2, 0, W, 'w')).toThrow(
      new RangeError('w adaptive prior must be a positive integer, got 0')
    );
    expect(() => new AdaptiveTable([1, 1], 2, 1.5, W, 'w')).toThrow(
      new TypeError('w adaptive prior must be a positive integer, got 1.5')
    );
    expect(() => new AdaptiveTable([1, 1], 2, 2, NaN, 'w')).toThrow(
      new TypeError('w adaptive window must be a positive integer, got NaN')
    );
    expect(
      () =>
        new AdaptiveTable(
          ones(MAX_ADAPTIVE_MEMBERS + 1),
          MAX_ADAPTIVE_MEMBERS + 1,
          1,
          MAX_ADAPTIVE_MEMBERS + 1,
          'w'
        )
    ).toThrow(new RangeError('w adaptive prior spans 65537 values, above the limit 65536'));
    expect(() => new AdaptiveTable([2 ** 43, 1], 2, 2, W, 'w')).toThrow(
      new RangeError(
        `w adaptive prior 2 and window 1024 overflow with weights totalling ${2 ** 43 + 1}`
      )
    );
    expect(() => new AdaptiveTable([1, 1], 2, MAX_SAFE, 2, 'w')).toThrow(
      `w adaptive prior ${MAX_SAFE} and window 2 overflow with weights totalling 2`
    );
  });

  it('builds a table whose largest bucket total is exactly the largest safe integer', () => {
    // 2^53 - 1 = 6361 · 69431 · 20394401.
    const total = 69431 * 20394401;
    const table = new AdaptiveTable([total - 1, 1], 2, 2, 6359, 'w');
    expect(table.base.total).toBe(total);
    expect(() => new AdaptiveTable([total - 1, 1], 2, 2, 6360, 'w')).toThrow(
      'overflow with weights totalling'
    );
  });

  it('halves past its window', () => {
    const table = new AdaptiveTable(ones(3), 3, 3, 8, 'w');
    const live = table.live(new Encoder());
    for (let i = 0; i < 8; i++) {
      live.learn(1);
    }
    expect([live.learned.count(1), live.learned.total]).toEqual([8, 8]);
    live.learn(1);
    expect([live.learned.count(1), live.learned.total]).toEqual([4, 4]);
  });

  it('gives each member of its live table its located bucket', () => {
    const table = new AdaptiveTable([2, 1, 5], 3, 3, 100, 'w');
    const live = table.live(new Encoder());
    live.learn(2);
    for (let i = 0; i < 3; i++) {
      expect(live.located(i)).toEqual([i, live.cum(i), live.freq(i)]);
      expect(live.bucket(i)).toEqual([live.cum(i), live.freq(i), live.total]);
    }
  });

  it('keeps the static table of its weights as declared as base', () => {
    const table = new AdaptiveTable([2, 1, 5], 3, 3, W, 'w');
    expect(table.base.cums).toEqual([0, 2, 3]);
    expect(table.base.total).toBe(8);
    expect(new AdaptiveTable([9000, 1000], 2, 2, W, 'w').base.freqs).toEqual([9000, 1000]);
  });

  it('locates every residual in the bucket that holds it', () => {
    const table = new AdaptiveTable([2, 1, 5], 3, 3, 100, 'w');
    const enc = new Encoder();
    const live = table.live(enc);
    live.learn(1);
    live.learn(1);
    live.learn(2);
    expect(live.size).toBe(3);
    for (let r = 0; r < live.total; r++) {
      const pos = live.locate(r);
      expect(live.cum(pos)).toBeLessThanOrEqual(r);
      expect(r).toBeLessThan(live.cum(pos) + live.freq(pos));
    }
  });

  it.each([
    ['uniform weights, a prior of the member count', ones(5), 5, 1024],
    ['skewed weights, a light prior', [9, 1, 1, 4], 1, 40],
    ['a window that halves often', [1, 2, 3], 6, 16],
    ['a window of the member count', [2, 3], 2, 2],
    ['a heavy prior', [5, 1, 1], 1000, 64],
  ])(
    'round-trips a seeded sequence under %s, tracking the model across halvings',
    (_name, weights, prior, window) => {
      const table = new AdaptiveTable(weights, weights.length, prior, window, 'w');
      const symbols = sequence(weights.length, 400, weights.length, 0.6);
      const model = new Model(weights, prior, window);
      const enc = new Encoder();
      for (const symbol of symbols) {
        expect(table.bucket(enc, symbol)).toEqual(model.bucket(symbol));
        table.write(enc, symbol);
        model.bump(symbol);
        expect(learned(table, enc)).toEqual(model.learned);
      }
      const dec = new Decoder(enc.output());
      expect(symbols.map(() => table.read(dec))).toEqual(symbols);
      dec.finalize();
      expect(learned(table, dec)).toEqual(model.learned);
    }
  );

  it('writes nothing for a lone member but still learns it', () => {
    const table = new AdaptiveTable([5], 1, 1, 2, 'w');
    const enc = new Encoder();
    for (let i = 0; i < 3; i++) {
      table.write(enc, 0);
    }
    // 1, 2, then 3 passes the window and halves to 1.
    expect(learned(table, enc)).toEqual([1]);
    expect(enc.output()).toEqual(new Encoder().output());
    const dec = new Decoder(new Encoder().output());
    expect([table.read(dec), table.read(dec), table.read(dec)]).toEqual([0, 0, 0]);
    dec.finalize();
    expect(learned(table, dec)).toEqual([1]);
  });

  it('refuses a position outside its members', () => {
    expect(() => new AdaptiveTable([1, 1], 2, 2, W, 'w').write(new Encoder(), 2)).toThrow(
      RangeError
    );
    expect(() => new AdaptiveTable([1], 1, 1, W, 'w').write(new Encoder(), 1)).toThrow(RangeError);
    expect(() => new AdaptiveTable([1, 1], 2, 2, W, 'w').bucket(new Encoder(), -1)).toThrow(
      RangeError
    );
  });

  it('keeps separate counts per table and shared counts per message', () => {
    const a = new AdaptiveTable([1, 1, 1], 3, 3, W, 'w');
    const b = new AdaptiveTable([1, 1, 1], 3, 3, W, 'w');
    const enc = new Encoder();
    a.write(enc, 0);
    a.write(enc, 0);
    b.write(enc, 2);
    expect(learned(a, enc)).toEqual([2, 0, 0]);
    expect(learned(b, enc)).toEqual([0, 0, 1]);
    const bytes = enc.output();
    expect(learned(a, new Encoder())).toEqual([0, 0, 0]);
    const dec = new Decoder(bytes);
    expect([a.read(dec), a.read(dec), b.read(dec)]).toEqual([0, 0, 2]);
    dec.finalize();
    expect(learned(a, dec)).toEqual([2, 0, 0]);
    expect(learned(a, new Decoder(bytes))).toEqual([0, 0, 0]);
  });

  it('learns the same under weights scaled by a constant', () => {
    const symbols = sequence(5, 1000, 2, 0.3);
    const run = (weights: number[]) => {
      const table = new AdaptiveTable(weights, weights.length, 4, 64, 'w');
      const model = new Model(weights, 4, 64);
      const enc = new Encoder();
      const buckets: number[][] = [];
      for (const symbol of symbols) {
        expect(table.bucket(enc, symbol)).toEqual(model.bucket(symbol));
        buckets.push(model.bucket(symbol));
        table.write(enc, symbol);
        model.bump(symbol);
      }
      const bytes = enc.output();
      const dec = new Decoder(bytes);
      expect(symbols.map(() => table.read(dec))).toEqual(symbols);
      dec.finalize();
      return { bytes, buckets, learned: learned(table, enc) };
    };
    const small = run([9, 1]);
    const large = run([9000, 1000]);
    // The symbols cost the same bits; wider totals only change how the
    // message ends, which costs a byte or two either way.
    expect(Math.abs(large.bytes.length - small.bytes.length)).toBeLessThanOrEqual(2);
    expect(large.learned).toEqual(small.learned);
    // Every bucket is the same fraction of its total: scaled by 1000 throughout.
    expect(large.buckets).toEqual(small.buckets.map((b) => b.map((x) => x * 1000)));
  });

  it('spells a recurring member cheaper as it is learned', () => {
    const table = new AdaptiveTable(ones(16), 16, 16, W, 'w');
    const enc = new Encoder();
    for (let i = 0; i < 200; i++) {
      table.write(enc, 3);
    }
    // 200 uniform symbols in 16 would cost 100 bytes.
    expect(enc.output().length).toBeLessThan(15);
  });
});

/** The selector's weights: static as likely as every rung together. */
const selectorTable = (prior: AdaptivePrior) =>
  buildWeights([prior.rungs.length, ...ones(prior.rungs.length)], 1 + prior.rungs.length, 'w');

/** `bucket(pos)` with the members of `excluded` owning no states. */
const cut = (
  bucket: (pos: number) => readonly number[],
  pos: number,
  excluded: readonly number[]
): [number, number, number] => {
  let [cum, freq, total] = bucket(pos);
  for (const member of excluded) {
    const width = bucket(member)[1];
    total -= width;
    cum -= member < pos ? width : 0;
    freq = member === pos ? 0 : freq;
  }
  return [cum, freq, total];
};

/**
 * A message of `symbols` in contexts `rows`, spelled by hand under `coding`
 * of `prior`: the first value static, the selector, then every later value
 * static under coding 0, or under coding i through the brute-force count
 * model of its row at the i-th rung, each row learning its own values.
 * `excluded[i]` lists the members ruled out of value i, which is not
 * written when they leave it alone; `learned[i]` marks a value learned
 * without being written. Either way the value is still learned.
 */
const forge = (
  prior: AdaptivePrior,
  weights: readonly number[][],
  coding: number,
  symbols: readonly number[],
  rows: readonly number[] = symbols.map(() => 0),
  window = Math.max(DEFAULT_ADAPTIVE_WINDOW, prior.members),
  excluded: readonly (readonly number[])[] = [],
  learned: readonly boolean[] = []
): Uint8Array => {
  const enc = new Encoder();
  const models: Model[] = [];
  const model = (row: number): Model =>
    (models[row] ??= new Model(weights[row], prior.rungs[coding - 1], window));
  let written = 0;
  symbols.forEach((symbol, i) => {
    const row = rows[i];
    const out = excluded[i] ?? [];
    if (!learned[i] && out.length < prior.members - 1) {
      if (written === 1) {
        writeTable(enc, selectorTable(prior), coding);
      }
      const base = prior.bases[row];
      const [cum, freq, total] =
        written === 0 || coding === 0
          ? cut((pos) => [base.cums[pos], base.freqs[pos], base.total], symbol, out)
          : cut((pos) => model(row).bucket(pos), symbol, out);
      enc.composeWeighted(cum, freq, total);
      written++;
    }
    if (coding > 0) {
      model(row).bump(symbol);
    }
  });
  return enc.output();
};

const encodeAll = (
  prior: AdaptivePrior,
  symbols: readonly number[],
  rows: readonly number[] = symbols.map(() => 0)
): Uint8Array => {
  const enc = new Encoder();
  symbols.forEach((symbol, i) => prior.write(enc, symbol, rows[i]));
  return enc.output();
};

const decodeAll = (prior: AdaptivePrior, bytes: Uint8Array, rows: readonly number[]): number[] => {
  const dec = new Decoder(bytes);
  const out = rows.map((row) => prior.read(dec, row));
  dec.finalize();
  return out;
};

/** The selector a message of `prior` carries: read after its first, static, value. */
const selector = (prior: AdaptivePrior, bytes: Uint8Array, row = 0): number => {
  const dec = new Decoder(bytes);
  readTable(dec, prior.bases[row]);
  return readTable(dec, selectorTable(prior));
};

const zeros = (n: number): number[] => new Array<number>(n).fill(0);

/** A message's values: each written with `excluded` ruled out, or learned when `learned`. */
interface Script {
  readonly symbols: readonly number[];
  readonly rows: readonly number[];
  readonly excluded: readonly (readonly number[])[];
  readonly learned: readonly boolean[];
}

const exclusionOf = (prior: AdaptivePrior, members: readonly number[]): Exclusion => {
  const exclusion = new Exclusion(prior.members);
  members.forEach((member) => exclusion.add(member));
  return exclusion;
};

const encodeScript = (prior: AdaptivePrior, script: Script): Uint8Array => {
  const enc = new Encoder();
  script.symbols.forEach((symbol, i) => {
    if (script.learned[i]) {
      prior.learn(enc, symbol, script.rows[i]);
    } else {
      prior.write(enc, symbol, script.rows[i], exclusionOf(prior, script.excluded[i] ?? []));
    }
  });
  return enc.output();
};

const decodeScript = (prior: AdaptivePrior, bytes: Uint8Array, script: Script): number[] => {
  const dec = new Decoder(bytes);
  const out = script.symbols.map((symbol, i) => {
    if (script.learned[i]) {
      prior.learn(dec, symbol, script.rows[i]);
      return symbol;
    }
    return prior.read(dec, script.rows[i], exclusionOf(prior, script.excluded[i] ?? []));
  });
  dec.finalize();
  return out;
};

const forgeScript = (
  prior: AdaptivePrior,
  weights: readonly number[][],
  coding: number,
  script: Script
): Uint8Array =>
  forge(
    prior,
    weights,
    coding,
    script.symbols,
    script.rows,
    undefined,
    script.excluded,
    script.learned
  );

describe('AdaptivePrior', () => {
  it('scales the ladder by the member count, each rung at least 1, repeats collapsed', () => {
    expect(LADDER).toEqual([1 / 32, 1 / 8, 1 / 2, 2]);
    const rungs = (m: number) => new AdaptivePrior([ones(m)], m, undefined, 'w').rungs;
    expect(rungs(1)).toEqual([1, 2]);
    expect(rungs(2)).toEqual([1, 4]);
    expect(rungs(3)).toEqual([1, 2, 6]);
    expect(rungs(16)).toEqual([1, 2, 8, 32]);
    expect(rungs(98)).toEqual([3, 12, 49, 196]);
    expect(rungs(65536)).toEqual([2048, 8192, 32768, 131072]);
  });

  it('refuses no rows, bad rows, too many members, a bad or small window, and an overflow at any rung', () => {
    expect(() => new AdaptivePrior([], 2, undefined, 'w')).toThrow(
      new TypeError('w adaptive prior needs at least one row of weights')
    );
    expect(() => new AdaptivePrior([[1, 1], [1]], 2, undefined, 'w')).toThrow(
      new TypeError('w weights must list one weight per value: expected 2, got 1')
    );
    expect(() => new AdaptivePrior([ones(65537)], 65537, undefined, 'w')).toThrow(
      new RangeError('w adaptive prior spans 65537 values, above the limit 65536')
    );
    expect(() => new AdaptivePrior([ones(2)], 2, 0, 'w')).toThrow(
      new RangeError('w adaptive window must be a positive integer, got 0')
    );
    // The slowest rung, 4 for two members, binds; the row with the largest total counts.
    expect(
      () =>
        new AdaptivePrior(
          [
            [1, 1],
            [2 ** 43, 1],
          ],
          2,
          undefined,
          'w'
        )
    ).toThrow(
      new RangeError(
        `w adaptive prior 4 and window 1024 overflow with weights totalling ${2 ** 43 + 1}`
      )
    );
    const total = Math.floor(MAX_SAFE / (4 + 1024));
    expect(() => new AdaptivePrior([[total - 1, 1]], 2, undefined, 'w')).not.toThrow();
    expect(() => new AdaptivePrior([[total, 1]], 2, undefined, 'w')).toThrow(
      'w adaptive prior 4 and window 1024 overflow'
    );
  });

  it('defaults the window to DEFAULT_ADAPTIVE_WINDOW, or the member count when that is larger', () => {
    // A window of 1024 halves once 1025 values are learned, so a forged
    // message under it decodes only if the prior holds that window.
    const symbols = zeros(1100);
    for (const m of [3, 2000]) {
      const weights = [ones(m)];
      const prior = new AdaptivePrior(weights, m, undefined, 'w');
      const bytes = forge(prior, weights, 1, symbols, undefined, Math.max(1024, m));
      expect(decodeAll(prior, bytes, zeros(symbols.length))).toEqual(symbols);
    }
  });

  it('picks a rung for a long skewed sequence and static for a short one', () => {
    const prior = new AdaptivePrior([ones(8)], 8, undefined, 'w');
    expect(prior.members).toBe(8);
    const skewed = sequence(1, 1000, 8, 0.95);
    const bytes = encodeAll(prior, skewed);
    expect(selector(prior, bytes)).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(forge(prior, [ones(8)], 0, skewed).length / 2);
    expect(decodeAll(prior, bytes, zeros(skewed.length))).toEqual(skewed);
    const short = [5, 2];
    expect(selector(prior, encodeAll(prior, short))).toBe(0);
    expect(encodeAll(prior, short)).toEqual(forge(prior, [ones(8)], 0, short));
  });

  it('picks static for text that matches its weights and a rung for text that does not', () => {
    const weights = [[40, 20, 10, 5, 2, 1, 1, 1]];
    const prior = new AdaptivePrior(weights, 8, undefined, 'w');
    const draw = (seed: number, table: readonly number[]) => {
      const random = mulberry32(seed);
      const total = sum(table);
      return Array.from({ length: 300 }, () => {
        let r = random() * total;
        let i = 0;
        while (r >= table[i]) {
          r -= table[i++];
        }
        return i;
      });
    };
    const matching = draw(7, weights[0]);
    const reversed = draw(8, [...weights[0]].reverse());
    expect(selector(prior, encodeAll(prior, matching))).toBe(0);
    expect(selector(prior, encodeAll(prior, reversed))).toBeGreaterThan(0);
  });

  it.each([2, 3, 8, 98])(
    'decodes a message forged under every coding of %i members, and encodes as the coding it picks',
    (m) => {
      const random = mulberry32(m);
      const weights = [Array.from({ length: m }, () => 1 + Math.floor(random() * 9))];
      const prior = new AdaptivePrior(weights, m, undefined, 'w');
      const symbols = sequence(m, 300, m, 0.5);
      const rows = zeros(symbols.length);
      const forged = Array.from({ length: 1 + prior.rungs.length }, (_, coding) =>
        forge(prior, weights, coding, symbols)
      );
      forged.forEach((bytes, coding) => {
        expect(selector(prior, bytes)).toBe(coding);
        expect(decodeAll(prior, bytes, rows)).toEqual(symbols);
      });
      const bytes = encodeAll(prior, symbols);
      const chosen = selector(prior, bytes);
      expect(bytes).toEqual(forged[chosen]);
      // Fewest bits, give or take how the message ends.
      for (const other of forged) {
        expect(bytes.length).toBeLessThanOrEqual(other.length + 1);
      }
    }
  );

  it.each([0, 1, 2, 3])('learns each row of a multi-row prior apart, under coding %i', (coding) => {
    const weights = [
      [8, 1, 1],
      [1, 8, 1],
      [1, 1, 8],
    ];
    const prior = new AdaptivePrior(weights, 3, 16, 'w');
    expect(prior.rungs).toEqual([1, 2, 6]);
    const random = mulberry32(coding + 40);
    const symbols = sequence(coding + 41, 200, 3, 0.3);
    const rows = symbols.map(() => Math.floor(random() * 3));
    const bytes = forge(prior, weights, coding, symbols, rows, 16);
    expect(decodeAll(prior, bytes, rows)).toEqual(symbols);
    const encoded = encodeAll(prior, symbols, rows);
    expect(encoded).toEqual(
      forge(prior, weights, selector(prior, encoded, rows[0]), symbols, rows, 16)
    );
  });

  it('writes a value written once per message in its static form, without a selector', () => {
    const prior = new AdaptivePrior([[3, 1, 2]], 3, undefined, 'w');
    for (const symbol of [0, 1, 2]) {
      const bytes = encodeAll(prior, [symbol]);
      const plain = new Encoder();
      writeTable(plain, buildWeights([3, 1, 2], 3, 'w'), symbol);
      expect(bytes).toEqual(plain.output());
      expect(decodeAll(prior, bytes, [0])).toEqual([symbol]);
    }
  });

  it('codes weights scaled by a constant at about the same cost', () => {
    const symbols = sequence(6, 1000, 2, 0.4);
    const small = new AdaptivePrior([[9, 1]], 2, 32, 'w');
    const large = new AdaptivePrior([[9000, 1000]], 2, 32, 'w');
    const bytes = encodeAll(large, symbols);
    // Wider totals only change how the message ends.
    expect(Math.abs(bytes.length - encodeAll(small, symbols).length)).toBeLessThanOrEqual(2);
    expect(decodeAll(large, bytes, zeros(symbols.length))).toEqual(symbols);
  });

  it('writes nothing for a lone member', () => {
    const prior = new AdaptivePrior([[3]], 1, undefined, 'w');
    const bytes = encodeAll(prior, [0, 0, 0]);
    expect(bytes).toEqual(new Encoder().output());
    expect(decodeAll(prior, bytes, [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('writes one selector per prior per message, with two priors interleaved', () => {
    const a = new AdaptivePrior([ones(4)], 4, undefined, 'w');
    const b = new AdaptivePrior([ones(3)], 3, undefined, 'w');
    const skewed = sequence(3, 300, 4, 0.9);
    const spread = sequence(4, 300, 3);
    const enc = new Encoder();
    for (let i = 0; i < skewed.length; i++) {
      a.write(enc, skewed[i]);
      b.write(enc, spread[i]);
    }
    const dec = new Decoder(enc.output());
    for (let i = 0; i < skewed.length; i++) {
      expect([a.read(dec), b.read(dec)]).toEqual([skewed[i], spread[i]]);
    }
    dec.finalize();
    // A second message starts over: static first value, then its own selector.
    expect(encodeAll(a, [1, 2])).toEqual(forge(a, [ones(4)], 0, [1, 2]));
  });

  it('refuses a position outside its members and a row outside its rows', () => {
    const prior = new AdaptivePrior([ones(3), ones(3)], 3, undefined, 'w');
    expect(() => prior.write(new Encoder(), 3)).toThrow(
      new RangeError('Position 3 is outside [0, 3)')
    );
    expect(() => prior.write(new Encoder(), -1)).toThrow(
      new RangeError('Position -1 is outside [0, 3)')
    );
    expect(() => prior.write(new Encoder(), 0.5)).toThrow(
      new TypeError('Position 0.5 is not an integer')
    );
    for (const row of [2, -1, 0.5, NaN]) {
      expect(() => prior.write(new Encoder(), 0, row)).toThrow(
        new RangeError(`Row ${row} is outside [0, 2)`)
      );
      expect(() => prior.read(new Decoder(new Encoder().output()), row)).toThrow(
        new RangeError(`Row ${row} is outside [0, 2)`)
      );
    }
    const lone = new AdaptivePrior([[1]], 1, undefined, 'x');
    expect(() => lone.write(new Encoder(), 7)).toThrow(
      new RangeError('Position 7 is outside [0, 1)')
    );
  });
});

describe('AdaptivePrior exclusion and learning', () => {
  /**
   * A seeded script over `m` members in two rows: values skewed to member
   * 0, some with members excluded (now and then all but the value), some
   * learned, as `mode` asks. The first value is known from its exclusion or
   * learned, so the first written value comes later.
   */
  const script = (m: number, mode: 'excluded' | 'learned' | 'both'): Script => {
    const random = mulberry32(m * 7 + mode.length);
    const symbols = sequence(m * 3 + mode.length, 400, m, 0.6);
    const rows = symbols.map(() => (random() < 0.3 ? 1 : 0));
    const excluded = symbols.map((symbol, i) => {
      if (mode === 'learned') {
        return [];
      }
      const others = [...Array(m).keys()].filter((member) => member !== symbol);
      if (i === 0 || random() < 0.1) {
        return others;
      }
      return others.filter(() => random() < 0.3);
    });
    const learned = symbols.map((_, i) =>
      mode === 'excluded' ? false : i === 0 || i === 3 || random() < 0.3
    );
    return { symbols, rows, excluded, learned };
  };

  it.each([
    [3, 'excluded'],
    [5, 'excluded'],
    [8, 'excluded'],
    [3, 'learned'],
    [5, 'learned'],
    [5, 'both'],
    [8, 'both'],
  ] as const)(
    'decodes a message of %i members with values %s, forged under every coding, and encodes as one of them',
    (m, mode) => {
      const random = mulberry32(m + 100);
      const weights = [0, 1].map(() =>
        Array.from({ length: m }, () => 1 + Math.floor(random() * 9))
      );
      const prior = new AdaptivePrior(weights, m, undefined, 'w');
      const run = script(m, mode);
      const forged = Array.from({ length: 1 + prior.rungs.length }, (_, coding) =>
        forgeScript(prior, weights, coding, run)
      );
      forged.forEach((bytes) => {
        expect(decodeScript(prior, bytes, run)).toEqual(run.symbols);
      });
      const bytes = encodeScript(prior, run);
      expect(forged).toContainEqual(bytes);
      expect(decodeScript(prior, bytes, run)).toEqual(run.symbols);
    }
  );

  it('writes the same as before with nothing excluded', () => {
    const prior = new AdaptivePrior([ones(8)], 8, undefined, 'w');
    const symbols = sequence(1, 300, 8, 0.9);
    const enc = new Encoder();
    const none = new Exclusion(8);
    symbols.forEach((symbol) => prior.write(enc, symbol, 0, none));
    expect(enc.output()).toEqual(encodeAll(prior, symbols));
  });

  it('writes nothing for a value its exclusion leaves alone, and still learns it', () => {
    const prior = new AdaptivePrior([ones(3)], 3, undefined, 'w');
    const enc = new Encoder();
    prior.write(enc, 1, 0, exclusionOf(prior, [0, 2]));
    expect(enc.output()).toEqual(new Encoder().output());
    const dec = new Decoder(new Encoder().output());
    expect(prior.read(dec, 0, exclusionOf(prior, [2, 0]))).toBe(1);
    dec.finalize();

    const tail = sequence(9, 200, 3, 0.9);
    const lead = new Array<number>(40).fill(2);
    const known: Script = {
      symbols: [...lead, ...tail],
      rows: zeros(lead.length + tail.length),
      excluded: lead.map(() => [0, 1]),
      learned: [],
    };
    const learned: Script = { ...known, excluded: [], learned: lead.map(() => true) };
    const bytes = encodeScript(prior, known);
    expect(bytes).toEqual(encodeScript(prior, learned));
    expect(bytes).not.toEqual(encodeAll(prior, tail));
    expect(decodeScript(prior, bytes, known)).toEqual(known.symbols);
  });

  it('keeps nothing learned under the static coding', () => {
    // A short message stays static; values learned after its selector are dropped.
    const prior = new AdaptivePrior([ones(4)], 4, undefined, 'w');
    const run: Script = {
      symbols: [3, 1, 0, 0, 2],
      rows: zeros(5),
      excluded: [],
      learned: [true, false, false, true, false],
    };
    const bytes = encodeScript(prior, run);
    expect(bytes).toEqual(forgeScript(prior, [ones(4)], 0, run));
    expect(decodeScript(prior, bytes, run)).toEqual(run.symbols);
  });

  it('refuses a position outside its members and a row outside its rows on either side', () => {
    const prior = new AdaptivePrior([ones(3), ones(3)], 3, undefined, 'w');
    for (const side of [new Encoder(), new Decoder(new Encoder().output())]) {
      expect(() => prior.learn(side, 3)).toThrow(new RangeError('Position 3 is outside [0, 3)'));
      expect(() => prior.learn(side, -1)).toThrow(new RangeError('Position -1 is outside [0, 3)'));
      expect(() => prior.learn(side, 0.5)).toThrow(new TypeError('Position 0.5 is not an integer'));
      for (const row of [2, -1, 0.5, NaN]) {
        expect(() => prior.learn(side, 0, row)).toThrow(
          new RangeError(`Row ${row} is outside [0, 2)`)
        );
      }
    }
  });

  it('learns nothing for a lone member', () => {
    const prior = new AdaptivePrior([[3]], 1, undefined, 'w');
    const enc = new Encoder();
    prior.learn(enc, 0);
    prior.write(enc, 0);
    expect(enc.output()).toEqual(new Encoder().output());
    const dec = new Decoder(new Encoder().output());
    prior.learn(dec, 0);
    expect(prior.read(dec)).toBe(0);
    dec.finalize();
    expect(() => prior.learn(enc, 1)).toThrow(new RangeError('Position 1 is outside [0, 1)'));
  });
});

describe('AdaptivePrior estimate', () => {
  const weights = [[5, 3, 2, 1, 1], ones(5)];
  const symbols = [0, 1, 0, 2, 0, 0, 3, 1];

  /** The second rung's live table of row 0 after `symbols`, built by hand. */
  const handLive = (prior: AdaptivePrior): LiveCounts => {
    const live = new LiveCounts(
      buildWeights(weights[0], 5, 'w'),
      prior.rungs[1],
      DEFAULT_ADAPTIVE_WINDOW
    );
    symbols.forEach((symbol) => live.learn(symbol));
    return live;
  };

  it("gives a member's bucket in the second rung's live table, excluded members ruled out", () => {
    const prior = new AdaptivePrior(weights, 5, undefined, 'w');
    const enc = new Encoder();
    symbols.forEach((symbol, i) =>
      i % 2 === 0 ? prior.write(enc, symbol) : prior.learn(enc, symbol)
    );
    const live = handLive(prior);
    for (let pos = 0; pos < 5; pos++) {
      expect(prior.estimate(enc, pos)).toEqual(live.bucket(pos));
    }
    const excluded = new Exclusion(5);
    excluded.add(0);
    excluded.add(3);
    expect(prior.estimate(enc, 4, 0, excluded)).toEqual(excludedBucket(live, excluded, 4));
    // Row 1 has learned nothing: its weights at the rung's prior.
    expect(prior.estimate(enc, 2, 1)).toEqual([
      2 * prior.rungs[1],
      prior.rungs[1],
      5 * prior.rungs[1],
    ]);
  });

  it('learns nothing, so writing after an estimate writes the same', () => {
    const plain = new AdaptivePrior(weights, 5, undefined, 'w');
    const estimated = new AdaptivePrior(weights, 5, undefined, 'w');
    const a = new Encoder();
    const b = new Encoder();
    symbols.forEach((symbol) => {
      plain.write(a, symbol);
      estimated.estimate(b, symbol);
      estimated.estimate(b, symbol, 1);
      estimated.write(b, symbol);
    });
    expect(b.output()).toEqual(a.output());
  });

  it('estimates a lone member as its whole table', () => {
    const prior = new AdaptivePrior([[3]], 1, undefined, 'w');
    expect(prior.estimate(new Encoder(), 0)).toEqual([0, 3 * prior.rungs[1], 3 * prior.rungs[1]]);
  });

  it('refuses a position outside its members and a row outside its rows', () => {
    const prior = new AdaptivePrior(weights, 5, undefined, 'w');
    const enc = new Encoder();
    expect(() => prior.estimate(enc, 5)).toThrow(new RangeError('Position 5 is outside [0, 5)'));
    expect(() => prior.estimate(enc, 0.5)).toThrow(new TypeError('Position 0.5 is not an integer'));
    expect(() => prior.estimate(enc, 0, 2)).toThrow(new RangeError('Row 2 is outside [0, 2)'));
  });
});

describe('Lineage', () => {
  const rows = (members: number, count = 1) => Array.from({ length: count }, () => ones(members));
  const prior = (members: number, count = 1, lineage?: Lineage) =>
    new AdaptivePrior(rows(members, count), members, undefined, 'w', lineage);

  it('pairs each prior a later node builds with the root prior built at the same place', () => {
    const root = new Lineage();
    const first = prior(3, 1, root);
    const second = prior(5, 2, root);
    const later = new Lineage(root);
    expect(later.pair(3, rows(3), 'w')).toBe(first);
    later.join(prior(3));
    expect(later.pair(5, rows(5, 2), 'w')).toBe(second);
    expect(new Lineage().pair(3, rows(3), 'w')).toBeUndefined();
  });

  it('refuses a prior past the root, or of other members or weights', () => {
    const root = new Lineage();
    prior(3, 1, root);
    const refusal = (at: number) =>
      new TypeError(`w adaptive prior ${at} does not match its lineage's`);
    const later = new Lineage(root);
    expect(() => later.pair(4, rows(4), 'w')).toThrow(refusal(0));
    expect(() => later.pair(3, rows(3, 2), 'w')).toThrow(refusal(0));
    expect(() => later.pair(3, [[1, 1]], 'w')).toThrow(refusal(0));
    expect(() => later.pair(3, [[1, 2, 1]], 'w')).toThrow(refusal(0));
    later.join(prior(3));
    expect(() => later.pair(3, rows(3), 'w')).toThrow(refusal(1));
  });

  it('takes a prior only once it is built', () => {
    const root = new Lineage();
    expect(() => new AdaptivePrior([[1, 0]], 2, undefined, 'w', root)).toThrow(TypeError);
    const first = prior(2, 1, root);
    expect(new Lineage(root).pair(2, rows(2), 'w')).toBe(first);
  });

  it('rides on adaptive options', () => {
    const lineage = new Lineage();
    const options = withLineage({ window: 5 }, lineage);
    expect(options.window).toBe(5);
    expect(lineageOf(options)).toBe(lineage);
    expect(lineageOf({ window: 5 })).toBeUndefined();
    expect(lineageOf(undefined)).toBeUndefined();
  });
});

describe('AdaptivePrior in a lineage', () => {
  const weights = [[5, 3, 2, 1, 1], ones(5)];
  const kin = (window?: number) => {
    const root = new Lineage();
    const gatherer = new AdaptivePrior(weights, 5, window, 'w', root);
    const node = () => new AdaptivePrior(weights, 5, window, 'w', new Lineage(root));
    return { gatherer, node };
  };

  /** The gathered table of row 0 after `values`, by hand, at the second rung's prior. */
  const gathered = (gatherer: AdaptivePrior, values: readonly number[], window = 1024) => {
    const live = new LiveCounts(buildWeights(weights[0], 5, 'w'), gatherer.rungs[1], window);
    values.forEach((value) => live.learn(value));
    return live;
  };

  it('starts from what its kin learned, its own values counting on top', () => {
    const { gatherer, node } = kin();
    const [a, b] = [node(), node()];
    const enc = new Encoder();
    const first = [0, 1, 0, 2];
    first.forEach((value) => a.write(enc, value));
    const all = gathered(gatherer, first);
    // Nothing of its own yet: the gathered table, counted as BLEND_SHARE observations.
    for (let pos = 0; pos < 5; pos++) {
      const [cum, freq, total] = all.bucket(pos);
      expect(b.estimate(enc, pos)).toEqual([
        cum * BLEND_SHARE,
        freq * BLEND_SHARE,
        total * BLEND_SHARE,
      ]);
    }
    b.write(enc, 3);
    b.learn(enc, 3);
    const after = gathered(gatherer, [...first, 3, 3]);
    const [cum, freq] = after.bucket(3);
    expect(b.estimate(enc, 3)).toEqual([
      cum * BLEND_SHARE,
      freq * BLEND_SHARE + 2 * after.total,
      after.total * (BLEND_SHARE + 2),
    ]);
  });

  it('decodes what it encodes, rows, exclusions and learned values included', () => {
    const { node } = kin(8);
    const script = sequence(4, 300, 5, 0.5);
    const encoders = [node(), node()];
    const enc = new Encoder();
    const lone = new Exclusion(5);
    [1, 2, 3, 4].forEach((pos) => lone.add(pos));
    const some = new Exclusion(5);
    some.add(4);
    const step = (i: number) => ({
      row: i % 3 === 0 ? 1 : 0,
      excluded: i % 7 === 0 ? some : undefined,
    });
    script.forEach((value, i) => {
      const { row, excluded } = step(i);
      const prior = encoders[i % 2];
      if (value === 4) {
        prior.learn(enc, value, row);
      } else {
        prior.write(enc, value, row, excluded);
      }
    });
    encoders[0].write(enc, 0, 0, lone);
    const decoders = [encoders[0], encoders[1]];
    const dec = new Decoder(enc.output());
    script.forEach((value, i) => {
      const { row, excluded } = step(i);
      const prior = decoders[i % 2];
      if (value === 4) {
        prior.learn(dec, value, row);
      } else {
        expect(prior.read(dec, row, excluded)).toBe(value);
      }
    });
    expect(decoders[0].read(dec, 0, lone)).toBe(0);
    dec.finalize();
  });

  it('halves its own counts past its window, and writes nothing for a lone member', () => {
    const { gatherer, node } = kin();
    const prior = node();
    const enc = new Encoder();
    for (let i = 0; i < 1100; i++) prior.write(enc, 0);
    const all = gathered(gatherer, Array<number>(1100).fill(0));
    // 1025 own observations halve to 512, then 75 more.
    expect(prior.estimate(enc, 0)[2]).toBe(all.total * (BLEND_SHARE + 587));
    const root = new Lineage();
    new AdaptivePrior([[1]], 1, undefined, 'w', root);
    const lone = new AdaptivePrior([[1]], 1, undefined, 'w', new Lineage(root));
    const quiet = new Encoder();
    lone.write(quiet, 0);
    expect(quiet.output()).toEqual(new Encoder().output());
  });

  it('refuses a root whose gathered table, counted with its own, overflows', () => {
    const root = new Lineage();
    new AdaptivePrior([[2 ** 33, 1]], 2, undefined, 'w', root);
    expect(() => new AdaptivePrior([[2 ** 33, 1]], 2, undefined, 'w', new Lineage(root))).toThrow(
      new RangeError(
        'w adaptive prior 2 and window 1024 overflow with weights totalling 8830452761604'
      )
    );
  });
});
