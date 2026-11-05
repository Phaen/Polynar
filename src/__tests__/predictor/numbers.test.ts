import { CorruptInputError, Decoder, Encoder } from '../../packer';
import type { MemberTable } from '../../packer';
import { exp2Fix, log2Fix } from '../../predictor/arith';
import { resolve } from '../../predictor/options';
import { NumberCoder, keepHeaviest } from '../../predictor/numbers';
import { loadedPriors } from '../../predictor/prior';
import { Session, session } from '../../predictor/session';
import type { NumberRange, PlainNumber } from '../../predictor/session';
import type { CompressOptions, PathKey, RangeBuckets } from '../../predictor/types';

const MAX = Number.MAX_SAFE_INTEGER;
const opts = (o: CompressOptions = {}) => resolve(o, loadedPriors.text, 'test');

/** The plain spelling of an unbounded integer: a sign and a term (any magnitude). */
const PLAIN: PlainNumber = {
  write: (enc, x) => {
    enc.compose(x < 0 ? 1 : 0, 2);
    enc.composeTerm(Math.abs(x));
  },
  read: (dec) => {
    const neg = dec.parse(2) === 1;
    const m = dec.parseTerm();
    return neg ? 0 - m : m;
  },
};

/** The plain spelling of an integer in [lo, hi]. */
const within = (lo: number, hi: number): PlainNumber => ({
  write: (enc, x) => enc.compose(x - lo, hi - lo + 1),
  read: (dec) => lo + dec.parse(hi - lo + 1),
});

/** A declared prior over [lo, hi] by integer weights, as a node's `.weights()` gives it. */
function weighted(lo: number, weights: readonly number[]): RangeBuckets & PlainNumber {
  const cums = [0];
  for (const w of weights) cums.push(cums[cums.length - 1] + w);
  const total = cums[cums.length - 1];
  return {
    bucketOf: (v) => [cums[v - lo], weights[v - lo], total],
    write: (enc, x) => enc.composeWeighted(cums[x - lo], weights[x - lo], total),
    read: (dec) =>
      lo +
      dec.parseWeighted(total, (r) => {
        let i = 0;
        while (cums[i + 1] <= r) i++;
        return [i, cums[i], weights[i]];
      }),
  };
}

type Op =
  | {
      readonly path: PathKey;
      readonly x: number;
      readonly range?: NumberRange;
      readonly plain?: PlainNumber;
    }
  | 'enter'
  | 'leave';

function run(
  s: Session,
  ops: readonly Op[],
  o: CompressOptions,
  each: (op: Exclude<Op, string>) => void
): void {
  void s;
  void o;
  for (const op of ops) {
    if (op === 'enter') s.enterRecord();
    else if (op === 'leave') s.leaveRecord();
    else each(op);
  }
}

/** Encodes the ops through one session, decodes them through another, and returns the bytes. */
function tripOps(ops: readonly Op[], o: CompressOptions = {}): Uint8Array {
  const r = opts(o);
  const enc = new Encoder();
  const se = session(enc);
  run(se, ops, o, (op) =>
    se.number(op.path, r, op.range ?? {}, op.plain ?? PLAIN).write(enc, op.x)
  );
  const bytes = enc.output();
  const dec = new Decoder(bytes);
  const sd = session(dec);
  const got: number[] = [];
  run(sd, ops, o, (op) =>
    got.push(sd.number(op.path, r, op.range ?? {}, op.plain ?? PLAIN).read(dec))
  );
  dec.finalize();
  expect(got).toEqual(
    ops
      .filter((op): op is Exclude<Op, string> => op !== 'enter' && op !== 'leave')
      .map((op) => op.x + 0)
  );
  return bytes;
}

/** Round-trips values at one path and returns the bytes. */
function trip(
  values: readonly number[],
  range: NumberRange = {},
  plain: PlainNumber = PLAIN,
  o: CompressOptions = {}
): Uint8Array {
  const path = {};
  return tripOps(
    values.map((x) => ({ path, x, range, plain })),
    o
  );
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('number predictor round trips', () => {
  it('learns a constant: later values cost a fraction of a bit', () => {
    const few = trip(new Array<number>(4).fill(7)).length;
    const many = trip(new Array<number>(200).fill(7)).length;
    expect(many - few).toBeLessThan(10);
  });

  it('learns a counter through the step', () => {
    const counter = trip(Array.from({ length: 300 }, (_, i) => 1000 + 3 * i)).length;
    const r = rng(1);
    const noise = trip(Array.from({ length: 300 }, () => 1000 + Math.floor(r() * 900))).length;
    expect(counter * 4).toBeLessThan(noise);
  });

  it('codes a millisecond timestamp series', () => {
    const r = rng(2);
    let t = 1_700_000_000_000;
    const ts = Array.from({ length: 200 }, () => (t += 1000 + Math.floor(r() * 50)));
    expect(trip(ts).length).toBeLessThan(200 * 2);
  });

  it('codes multimodal, negative and random values across magnitudes', () => {
    const r = rng(3);
    const modes = [-5000, 12, 7_000_000];
    trip(Array.from({ length: 200 }, (_, i) => modes[i % 3] + Math.floor(r() * 5) - 2));
    trip(
      Array.from({ length: 150 }, () => {
        const m = Math.floor(2 ** Math.floor(r() * 53) * r());
        return r() < 0.5 ? -m : m;
      })
    );
    trip([0, -0, 0, -1, 1, MAX, -MAX, MAX, MAX - 1, -MAX + 1, 0, MAX]);
  });

  it('passes values beyond the safe integers through the plain spelling, outside the history', () => {
    trip([2 ** 60, 5, -(2 ** 70), 5, 2 ** 53, 5, 2 ** 60, 6, 2 ** 60]);
    const path = {};
    // A tail value never becomes a sibling either.
    tripOps(['enter', { path, x: 2 ** 60 }, { path: {}, x: 3 }, 'leave']);
  });

  it('keeps hitting the top candidate on long runs and misses when the run breaks', () => {
    const v = [...new Array<number>(20).fill(5), 6, ...new Array<number>(20).fill(5), 9, 9, 9];
    trip(v);
  });

  it('codes far values that only NOVELTY reaches', () => {
    trip([1, 2, 1, 2, 1, 2, 2 ** 52, 1, -(2 ** 52), 3]);
  });

  it('codes differences past the safe integers and a seen range as wide', () => {
    const v: number[] = [];
    for (let i = 0; i < 24; i++) v.push(i % 2 === 0 ? -(2 ** 52) + i : 2 ** 52 - i);
    v.push(0, 12345, -77);
    trip(v);
  });

  it('weighs references older than 127 values in the last recency bucket', () => {
    const r = rng(10);
    trip(
      Array.from({ length: 140 }, () => Math.floor(r() * 50)),
      {},
      PLAIN,
      { history: 130, quantisation: 2 ** 20 }
    );
  });

  it('keeps NOVELTY in the mixture when the references outweigh it by far', () => {
    trip(new Array<number>(12).fill(2 ** 50 + 3));
  });

  it('works with a short history and a fine quantisation', () => {
    const r = rng(4);
    trip(
      Array.from({ length: 100 }, () => Math.floor(r() * 40)),
      {},
      PLAIN,
      { history: 3, quantisation: 4096 }
    );
  });
});

describe('number predictor bounds', () => {
  it('codes within both bounds, uniform first value, classes clipped at the bounds', () => {
    const r = rng(5);
    const v = Array.from({ length: 200 }, () => -5 + Math.floor(r() * 26));
    v.push(-5, -5, 20, 20, -5, 20, 19, -4);
    trip(v, { lo: -5, hi: 20 }, within(-5, 20));
  });

  it('codes a single allowed value', () => {
    trip([3, 3, 3, 3], { lo: 3, hi: 3 }, within(3, 3));
  });

  it('clips a stepped centre to the bounds', () => {
    // An increasing run teaches a positive step; at the max the centre stays inside.
    const v = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 100, 100, 95, 100];
    trip(v, { lo: 0, hi: 100 }, within(0, 100));
    trip(
      v.map((x) => -x),
      { lo: -100, hi: 0 },
      within(-100, 0)
    );
  });

  it('codes from a lone min or a lone max as a distance, with no sign', () => {
    const r = rng(6);
    const v = Array.from({ length: 100 }, () => 10 + Math.floor(r() * 2 ** Math.floor(r() * 30)));
    trip(v, { lo: 10 });
    trip(
      v.map((x) => -x),
      { hi: -10 }
    );
    trip([10, 10, 11, 2 ** 60, 10], { lo: 10 });
  });

  it('codes over the widest bounds and bounds past the safe integers', () => {
    trip(
      [0, 1, -1, MAX, -MAX, 0],
      { lo: -MAX, hi: MAX },
      {
        write: (enc, x) => enc.composeBig(BigInt(x) + BigInt(MAX), 2n * BigInt(MAX) + 1n),
        read: (dec) => Number(dec.parseBig(2n * BigInt(MAX) + 1n) - BigInt(MAX)),
      }
    );
    // A min past the safe integers: values near it are distances in reach, others go plain.
    const lo = -(2 ** 60);
    trip([lo, lo + 2 ** 10, 5, lo, lo + 2 ** 10], { lo });
    trip([-lo, 7, -lo - 2 ** 12], { hi: -lo });
  });

  it('takes a declared prior as NOVELTY’s exact prior', () => {
    const w = weighted(0, [1, 5, 0, 30, 2, 2, 1, 8]);
    const r = rng(7);
    const pick = [0, 1, 3, 4, 5, 6, 7];
    const v = Array.from({ length: 120 }, () => pick[Math.floor(r() * pick.length)]);
    trip(v, { lo: 0, hi: 7, prior: w }, w);
  });
});

describe('number predictor records', () => {
  it('predicts a number from an earlier one of its record', () => {
    const a = {};
    const b = {};
    const r = rng(8);
    const ops: Op[] = [];
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(r() * 1e6);
      ops.push('enter', { path: a, x }, { path: b, x: x + 17 }, 'leave');
    }
    const linked = tripOps(ops).length;
    const flat = tripOps(ops.filter((op) => op !== 'enter' && op !== 'leave')).length;
    expect(linked).toBeLessThan(flat - 60);
  });

  it('lets an inner record’s numbers join the outer record when it closes', () => {
    const a = {};
    const b = {};
    const c = {};
    const ops: Op[] = [];
    for (let i = 0; i < 20; i++) {
      ops.push(
        'enter',
        'enter',
        { path: a, x: 100 * i },
        'leave',
        { path: b, x: 100 * i + 1 },
        'leave'
      );
    }
    tripOps(ops);
    // Leaving without an outer record, or with none open, keeps nothing.
    const s = new Session();
    s.leaveRecord();
    tripOps(['leave', { path: c, x: 1 }]);
  });

  it('breaks a tie between equal candidates toward the lower centre', () => {
    const ops: Op[] = [
      'enter',
      { path: {}, x: 100 },
      { path: {}, x: 50 },
      { path: {}, x: 50 },
      'leave',
    ];
    tripOps(ops);
    tripOps(['enter', { path: {}, x: 100 }, { path: {}, x: 50 }, { path: {}, x: 100 }, 'leave']);
  });

  it('takes the record’s latest `history` numbers as siblings', () => {
    const ops: Op[] = ['enter'];
    for (let i = 0; i < 6; i++) ops.push({ path: {}, x: 10 * i });
    ops.push('leave');
    tripOps(ops, { history: 2 });
  });

  it('keeps derived paths of one node apart', () => {
    const node = {};
    const ops: Op[] = [];
    for (let i = 0; i < 30; i++)
      ops.push({ path: [node, 0], x: i }, { path: [node, 1], x: -i * 1000 });
    tripOps(ops);
  });
});

/**
 * A decoder that makes the choices it is given, in order: for a weighted read the entry (a number,
 * or a function of the table), for a digit the digit; a mixture puts back nothing.
 */
function scripted(
  members: readonly (number | ((t: MemberTable) => number))[],
  digits: readonly number[] = [],
  bigs: readonly bigint[] = []
): Decoder {
  const real = new Decoder(new Uint8Array(64));
  let m = 0;
  let d = 0;
  let b = 0;
  return Object.assign(Object.create(real) as Decoder, {
    parseMember: (_: number, t: MemberTable) => {
      const c = members[m++];
      return typeof c === 'function' ? c(t) : c;
    },
    parse: () => digits[d++],
    parseBig: () => bigs[b++],
    parseMixture: () => undefined,
  });
}

/** The entries of a coded distribution. */
const entries = (t: MemberTable): number => (t as unknown as { n: number }).n;

describe('number predictor on corrupt input', () => {
  const o = opts();

  it('stops on garbage within the read limit', () => {
    const r = rng(9);
    const short = opts({ history: 4 });
    for (let k = 0; k < 8; k++) {
      const bytes = Uint8Array.from({ length: 24 }, () => Math.floor(r() * 256));
      const dec = new Decoder(bytes, { limit: 200 });
      const s = session(dec);
      const path = {};
      expect(() => {
        for (let i = 0; i < 100_000; i++) s.number(path, short, {}, PLAIN).read(dec);
      }).toThrow();
    }
  });

  it('refuses a magnitude class past the safe integers', () => {
    const dec = scripted([0, 60]);
    expect(() => session(dec).number({}, o, {}, PLAIN).read(dec)).toThrow(CorruptInputError);
  });

  it('refuses a distance its bound cannot reach exactly', () => {
    const lo = -(2 ** 60);
    const dec = scripted([0, 20], [1]);
    expect(() => session(dec).number({}, o, { lo }, PLAIN).read(dec)).toThrow(CorruptInputError);
    const dec2 = scripted([0, 20], [1]);
    expect(() => session(dec2).number({}, o, { hi: -lo }, PLAIN).read(dec2)).toThrow(
      CorruptInputError
    );
  });

  it('refuses a kernel offset past the safe integers', () => {
    // 0, then a miss through the kernel at 0 into its widest class, to its far end.
    const path = {};
    const dec = scripted([0, 0, 1, 0, 53], [], [2n ** 53n - 1n]);
    const s = session(dec);
    expect(s.number(path, o, {}, PLAIN).read(dec)).toBe(0);
    expect(() => s.number(path, o, {}, PLAIN).read(dec)).toThrow(CorruptInputError);
    // MAX, then one above it through the kernel's first class.
    const dec2 = scripted([0, 53, 0, 1, 0, 0], [2 ** 52 - 1, 0]);
    const s2 = session(dec2);
    expect(s2.number(path, o, {}, PLAIN).read(dec2)).toBe(MAX);
    expect(() => s2.number(path, o, {}, PLAIN).read(dec2)).toThrow(CorruptInputError);
  });

  it('reads a value of weight 0 under the declared prior', () => {
    // 0 from the plain prior, then a miss through the kernel at 0 into the class of 2 and 3.
    const w = weighted(0, [1, 5, 0, 30]);
    const plain: PlainNumber = { write: w.write, read: () => 0 };
    const range = { lo: 0, hi: 3, prior: w };
    const path = {};
    const dec = scripted([0, 1, 0, 1], [0]);
    const s = session(dec);
    expect(s.number(path, o, range, plain).read(dec)).toBe(0);
    expect(s.number(path, o, range, plain).read(dec)).toBe(2);
  });

  it('reads a seen range wider than the safe integers', () => {
    // −2^52, 2^52 (NOVELTY), then the range component.
    const path = {};
    const dec = scripted([0, 53, 1, 1, 1, 53, 0, 1, (t) => entries(t) - 2], [0, 0], [5n]);
    const s = session(dec);
    expect(s.number(path, o, {}, PLAIN).read(dec)).toBe(-(2 ** 52));
    expect(s.number(path, o, {}, PLAIN).read(dec)).toBe(2 ** 52);
    const x = s.number(path, o, {}, PLAIN).read(dec);
    expect(x === -(2 ** 52) + 5 || x === -(2 ** 52) + 6).toBe(true);
  });
});

describe('keepHeaviest', () => {
  const keep = (w: number[], n: number, k: number): number[] => {
    const out = w.slice();
    keepHeaviest(out, n, k, new Float64Array(n));
    return out;
  };

  /** The reference: positives by weight, heaviest first, ties by index, the first k kept. */
  const bySort = (w: readonly number[], n: number, k: number): number[] => {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (w[i] > 0) idx.push(i);
    idx.sort((a, b) => w[b] - w[a] || a - b);
    const out = w.slice();
    for (let r = k; r < idx.length; r++) out[idx[r]] = 0;
    return out;
  };

  it('leaves fewer than k positives and exactly k as they are', () => {
    expect(keep([0, 4, 0, 2, 7], 5, 4)).toEqual([0, 4, 0, 2, 7]);
    expect(keep([3, 0, 1, 2], 4, 3)).toEqual([3, 0, 1, 2]);
    expect(keep([], 0, 1)).toEqual([]);
  });

  it('keeps the lower index among weights equal to the k-th', () => {
    expect(keep([5, 3, 3, 3, 1], 5, 3)).toEqual([5, 3, 3, 0, 0]);
    expect(keep([1, 3, 0, 3, 5, 3], 6, 2)).toEqual([0, 3, 0, 0, 5, 0]);
    expect(keep([2, 2, 2, 2], 4, 1)).toEqual([2, 0, 0, 0]);
    expect(keep([2, 2, 2, 2], 4, 3)).toEqual([2, 2, 2, 0]);
  });

  it('leaves the entries past n, NOVELTY and RANGE, when they are the lightest', () => {
    expect(keep([9, 8, 7, 1, 1], 3, 2)).toEqual([9, 8, 0, 1, 1]);
    expect(keep([1, 9, 8, 7, 0, 1], 4, 1)).toEqual([0, 9, 0, 0, 0, 1]);
  });

  it('matches the sort over random weights, ties and zeros', () => {
    const r = rng(41);
    for (let t = 0; t < 3000; t++) {
      const n = Math.floor(r() * 200);
      const tail = Math.floor(r() * 3);
      const spread = [2, 5, 50, 2 ** 40][t % 4];
      const w = Array.from({ length: n + tail }, () =>
        r() < 0.2 ? 0 : 1 + Math.floor(r() * spread)
      );
      const k = 1 + Math.floor(r() * 24);
      expect(keep(w, n, k)).toEqual(bySort(w, n, k));
    }
  });
});

describe('number predictor top search', () => {
  /** The coder's step internals; kind 1 is a spike. */
  interface Step {
    nc: number;
    refs: number;
    kind: Int32Array;
    at: Float64Array;
    lw: Float64Array;
    K: Float64Array;
    mass: Float64Array;
    off: number;
    offR: number;
    ncent: number;
    cents: Float64Array;
    spCell: number;
    spC: number;
    spot(C: number, v: number): void;
    kern(cell: number, c: number): number;
    rowSum(C: number): number;
    massAt(ci: number): number;
    findTop(): void;
  }
  const proto = NumberCoder.prototype as unknown as Step;
  const findTop = proto.findTop;

  /** Codes the ops, checking every step's masses against a sum over its references one by one. */
  function checked(ops: readonly Op[], o: CompressOptions = {}): number {
    let probes = 0;
    proto.findTop = function (this: Step): void {
      for (let i = 0; i < this.nc; i++) {
        expect(this.mass[i]).toBe(exp2Fix(this.K[i] + this.off));
        if (i < this.refs && this.kind[i] !== 1) {
          expect(this.K[i]).toBe(this.lw[i] + log2Fix(this.rowSum(this.at[i])) - this.offR);
        }
      }
      for (let ci = 0; ci < this.ncent; ci++) {
        const v = this.cents[ci];
        let m = 0;
        for (let i = 0; i < this.refs; i++) {
          if (this.kind[i] === 1) {
            if (this.at[i] === v) m += this.mass[i];
            continue;
          }
          this.spot(this.at[i], v);
          m += exp2Fix(this.lw[i] + this.kern(this.spCell, this.spC) + this.off);
        }
        expect(this.massAt(ci)).toBe(m);
        probes++;
      }
      findTop.call(this);
    };
    try {
      tripOps(ops, o);
    } finally {
      proto.findTop = findTop;
    }
    return probes;
  }

  const at = (values: readonly number[], range: NumberRange = {}): Op[] => {
    const path = {};
    return values.map((x) => ({ path, x, range }));
  };

  it('sums each centre’s mass as its references one by one, unbounded and bounded', () => {
    const r = rng(61);
    expect(checked(at(new Array<number>(40).fill(7)))).toBeGreaterThan(0);
    checked(at(Array.from({ length: 60 }, () => Math.floor(r() * 2 ** 40))), { history: 9 });
    checked(at(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 10 : 20))));
    checked(at(Array.from({ length: 60 }, (_, i) => 1000 + 60 * (i - Math.floor(i / 3)))));
    checked(at([-(2 ** 52), 2 ** 52, -(2 ** 52) + 1, 2 ** 52 - 1, 0]));
    checked(
      at(
        Array.from({ length: 60 }, () => Math.floor(r() * 21)),
        { lo: 0, hi: 20 }
      )
    );
    checked(
      at(
        Array.from({ length: 40 }, () => 5 + Math.floor(r() * 9)),
        { lo: 5 }
      )
    );
  });

  it('sums each centre’s mass with siblings', () => {
    const ops: Op[] = [];
    const a = {};
    const b = {};
    for (let i = 0; i < 30; i++)
      ops.push('enter', { path: a, x: i % 5 }, { path: b, x: 3 }, 'leave');
    expect(checked(ops)).toBeGreaterThan(0);
  });
});
