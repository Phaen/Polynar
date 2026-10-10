/**
 * BlockBound against an exact oracle. The oracle carries the block's
 * rationals V/den, U/den, S/den and the tight bound as plain BigInts, with no
 * regimes, scaling or error margins, and answers every question BlockBound
 * answers straight from the recurrences: per symbol of `total` states and
 * `freq` weight the candidate is V + U·(total−1), S takes the larger of
 * itself and the candidate, then V' = (V + U·(total−freq))·freq,
 * U' = U·total, den' = den·freq, and S and the capacities scale by freq.
 *
 * Random symbol sequences drive both side by side the way the encoder and
 * the decoder drive BlockBound, plus a mode that asks every question in
 * random order, and every answer must agree. The sequences aim at the spots
 * where the float regime's margins are thinnest: bit lengths just past a
 * 256-bit scale step, candidates landing on or one off a power of the base
 * or the cap, totals near 2^53, extreme weights, and long weighted runs
 * that rescale and fall back to exact arithmetic.
 *
 * The run is seeded and every iteration draws from its own generator, so a
 * failure names the seed and iteration that reproduce it. FUZZ scales the
 * iteration count and FUZZ_SEED picks another seed.
 */

import { BlockBound } from '../packer/bound';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const SCALE = Math.max(1, Number(process.env.FUZZ ?? 1));
const SEED = Number(process.env.FUZZ_SEED ?? 0xb0c4d);
const ITERATIONS = Math.round(400 * SCALE);

const BASES = [2, 3, 7, 10, 64, 95, 255, 256, 1000, 65535] as const;
const BLOCK_BITS = [128, 128, 2048, 2048, 4096, 65536] as const;

const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform in [lo, hi], exact up to 2^53. */
  int(lo: number, hi: number): number {
    const r =
      (Math.floor(this.next() * 2 ** 32) * 2 ** 21 + Math.floor(this.next() * 2 ** 21)) / 2 ** 53;
    return lo + Math.floor(r * (hi - lo + 1));
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)];
  }
}

const bitLen = (x: bigint): number => (x === 0n ? 0 : x.toString(2).length);

const blockDigitsCache = new Map<string, number>();

/** The largest d with base^d ≤ 2^blockBits, by repeated multiplication. */
function blockDigitsOf(base: number, blockBits: number): number {
  const key = `${base}/${blockBits}`;
  let digits = blockDigitsCache.get(key);
  if (digits === undefined) {
    const limit = 1n << BigInt(blockBits);
    const b = BigInt(base);
    let power = 1n;
    digits = 0;
    while (power * b <= limit) {
      power *= b;
      digits++;
    }
    blockDigitsCache.set(key, digits);
  }
  return digits;
}

class Oracle {
  readonly blockDigits: number;
  readonly cap: bigint;
  private readonly baseBig: bigint;
  capacity: bigint;
  capacityIsCap = true;
  V = 1n;
  U = 1n;
  S = 1n;
  den = 1n;
  tightV = 1n;
  tightDen = 1n;

  constructor(
    readonly base: number,
    blockBits: number
  ) {
    this.baseBig = BigInt(base);
    this.blockDigits = blockDigitsOf(base, blockBits);
    this.cap = this.pow(this.blockDigits);
    this.capacity = this.cap;
  }

  pow(d: number): bigint {
    return this.baseBig ** BigInt(d);
  }

  reset(digits: number): void {
    this.capacity = this.pow(digits);
    this.capacityIsCap = digits === this.blockDigits;
    this.V = 1n;
    this.U = 1n;
    this.S = 1n;
    this.den = 1n;
    this.tightV = 1n;
    this.tightDen = 1n;
  }

  candidate(k: number): bigint {
    return this.V + this.U * BigInt(k - 1);
  }

  exceedsCap(total: number): boolean {
    return this.candidate(total) > this.cap * this.den;
  }

  exceedsCapacity(total: number): boolean {
    return !this.capacityIsCap && this.candidate(total) > this.capacity * this.den;
  }

  indexExceedsCapacity(total: number, count: number): boolean {
    return count >= total
      ? this.exceedsCapacity(total)
      : this.candidate(count) > this.capacity * this.den;
  }

  update(total: number, freq: number, count: number): void {
    const c = this.candidate(total);
    const asIndex = this.candidate(count);
    this.tightV = this.S > asIndex ? this.S : asIndex;
    this.tightDen = this.den;
    if (c > this.S) {
      this.S = c;
    }
    const f = BigInt(freq);
    this.V = (this.V + this.U * BigInt(total - freq)) * f;
    this.U *= BigInt(total);
    this.S *= f;
    this.den *= f;
  }

  /** The smallest d with base^d·den ≥ x. */
  digits(x: bigint, den: bigint): number {
    let d = Math.max(0, Math.floor((bitLen(x) - bitLen(den)) / Math.log2(this.base)));
    while (d > 0 && this.pow(d - 1) * den >= x) {
      d--;
    }
    while (this.pow(d) * den < x) {
      d++;
    }
    return d;
  }

  digitsForS(): number {
    return this.digits(this.S, this.den);
  }

  tightFitsAnotherDigit(): boolean {
    return this.tightV * this.baseBig <= this.capacity * this.tightDen;
  }

  indexDecision(total: number, count: number): { indexed: boolean; digits: number } {
    const asIndex = this.candidate(count);
    const digits = this.digits(this.S > asIndex ? this.S : asIndex, this.den);
    return { indexed: this.digits(this.candidate(total), this.den) > digits, digits };
  }
}

interface Sym {
  total: number;
  freq: number;
  count: number;
}

/**
 * Lazily produces a case's symbols in segments of one strategy each. Some
 * strategies read the oracle's state to land a candidate on a target.
 */
class Symbols {
  private queue: Sym[] = [];

  constructor(
    private readonly rng: Rng,
    private readonly oracle: Oracle
  ) {}

  next(): Sym {
    if (this.queue.length === 0) {
      this.refill();
    }
    return this.queue.shift() as Sym;
  }

  private total(): number {
    const rng = this.rng;
    const base = this.oracle.base;
    const a = rng.int(1, 52);
    switch (rng.int(0, 7)) {
      case 0:
        return rng.int(2, 16);
      case 1:
        return Math.max(2, base + rng.int(-1, 1));
      case 2:
        return 2 ** a;
      case 3:
        return Math.max(2, 2 ** a + rng.pick([-1, 1]));
      case 4:
        return MAX_SAFE - rng.int(0, 3);
      case 5:
        return rng.int(2 ** 52, MAX_SAFE);
      case 6:
        return Math.max(2, rng.int(2 ** (a - 1), 2 ** a));
      default:
        return rng.int(2, MAX_SAFE);
    }
  }

  private freq(total: number): number {
    const rng = this.rng;
    const small = rng.int(1, Math.min(16, total - 1));
    switch (rng.int(0, 5)) {
      case 0:
        return 1;
      case 1:
        return total - 1;
      case 2:
        return Math.max(1, Math.floor(total / 2));
      case 3:
        return small;
      case 4:
        return total - small;
      default:
        return rng.int(1, total - 1);
    }
  }

  private count(total: number): number {
    const rng = this.rng;
    switch (rng.int(0, 5)) {
      case 0:
        return 1;
      case 1:
        return Math.max(1, total - 1);
      case 2:
        return rng.int(1, total);
      default:
        return total;
    }
  }

  private sym(total: number, weighted: boolean): Sym {
    return {
      total,
      freq: weighted ? this.freq(total) : 1,
      count: this.rng.chance(0.15) ? this.count(total) : total,
    };
  }

  /** The largest power of the base that a total can hold, as its exponent. */
  private maxPowerExponent(): number {
    let j = 1;
    while (this.oracle.base ** (j + 1) <= MAX_SAFE) {
      j++;
    }
    return j;
  }

  private refill(): void {
    const rng = this.rng;
    const oracle = this.oracle;
    const q = this.queue;
    switch (rng.int(0, 5)) {
      case 0: {
        // A uniform run.
        const n = rng.int(1, 60);
        for (let i = 0; i < n; i++) {
          q.push(this.sym(this.total(), false));
        }
        break;
      }
      case 1: {
        // A weighted run, long enough to rescale the doubles.
        const n = rng.int(1, 80);
        for (let i = 0; i < n; i++) {
          q.push(this.sym(this.total(), rng.chance(0.8)));
        }
        break;
      }
      case 2: {
        // Powers of the base, then a weighted total one off a power: the
        // digit bound lands on or beside base^d.
        const jMax = this.maxPowerExponent();
        const j = rng.int(1, jMax);
        const n = rng.int(0, Math.ceil(oracle.blockDigits / j) + 1);
        for (let i = 0; i < n; i++) {
          q.push({ total: oracle.base ** j, freq: 1, count: oracle.base ** j });
        }
        const total = Math.max(2, oracle.base ** rng.int(1, jMax) + rng.int(-1, 1));
        q.push(this.sym(total, true));
        break;
      }
      case 3: {
        // Uniform totals near 2^53 up to a product 1 to 60 bits past a
        // multiple of 256, then a weighted symbol.
        let product = oracle.U / oracle.den;
        const target =
          256 * rng.int(1, Math.max(1, Math.floor(bitLen(oracle.cap) / 256))) + rng.int(1, 60);
        while (bitLen(product) + 53 < target) {
          const total = rng.int(2 ** 52, MAX_SAFE);
          q.push({ total, freq: 1, count: total });
          product *= BigInt(total);
        }
        if (product > 0n && bitLen(product) < target) {
          const lo = ((1n << BigInt(target - 1)) + product - 1n) / product;
          const hi = ((1n << BigInt(target)) - 1n) / product;
          if (lo <= hi && hi <= BigInt(MAX_SAFE) && lo >= 2n) {
            const total = rng.int(Number(lo), Number(hi));
            q.push({ total, freq: 1, count: total });
          }
        }
        q.push(this.sym(this.total(), true));
        break;
      }
      case 4: {
        // One symbol whose candidate lands on, or one off, the cap, the
        // capacity or a power of the base, as close as the state allows.
        const d = oracle.digitsForS();
        const target =
          rng.pick([oracle.cap, oracle.capacity, oracle.pow(d), oracle.pow(d + 1)]) * oracle.den +
          BigInt(rng.int(-1, 1));
        const k = (target - oracle.V) / oracle.U + 1n + BigInt(rng.int(-1, 1));
        const total = k >= 2n && k <= BigInt(MAX_SAFE) ? Number(k) : this.total();
        q.push(this.sym(total, rng.chance(0.5)));
        break;
      }
      default: {
        // Extreme weights.
        const n = rng.int(1, 20);
        for (let i = 0; i < n; i++) {
          const total = this.total();
          q.push({ total, freq: rng.pick([1, total - 1]), count: total });
        }
      }
    }
  }
}

type Mode = 'encoder' | 'decoder' | 'random';

function runCase(iteration: number): void {
  const rng = new Rng((SEED ^ Math.imul(iteration + 1, 0x9e3779b9)) >>> 0);
  const base = rng.pick(BASES);
  const blockBits = rng.pick(BLOCK_BITS);
  const mode = rng.pick<Mode>(['encoder', 'decoder', 'random']);
  const length = rng.int(1, rng.chance(0.2) ? 2000 : 300);

  const bound = new BlockBound(base, blockBits);
  const oracle = new Oracle(base, blockBits);
  const symbols = new Symbols(rng, oracle);
  let where = 'construction';

  const check = <T>(question: string, got: T, want: T): T => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(
        `seed=${SEED} iteration=${iteration} base=${base} blockBits=${blockBits} mode=${mode} ` +
          `${where}: ${question} gave ${JSON.stringify(got)}, exact ${JSON.stringify(want)}`
      );
    }
    return got;
  };

  check('blockDigits', bound.blockDigits, oracle.blockDigits);

  const ask = {
    cap: (s: Sym) =>
      check(`exceedsCap(${s.total})`, bound.exceedsCap(s.total), oracle.exceedsCap(s.total)),
    capacity: (s: Sym) =>
      check(
        `exceedsCapacity(${s.total})`,
        bound.exceedsCapacity(s.total),
        oracle.exceedsCapacity(s.total)
      ),
    index: (s: Sym) =>
      check(
        `indexExceedsCapacity(${s.total}, ${s.count})`,
        bound.indexExceedsCapacity(s.total, s.count),
        oracle.indexExceedsCapacity(s.total, s.count)
      ),
    decision: (s: Sym) =>
      check(
        `indexDecision(${s.total}, ${s.count})`,
        bound.indexDecision(s.total, s.count),
        oracle.indexDecision(s.total, s.count)
      ),
    digits: () => check('digitsForS()', bound.digitsForS(), oracle.digitsForS()),
    tight: () =>
      check(
        'tightFitsAnotherDigit()',
        bound.tightFitsAnotherDigit(),
        oracle.tightFitsAnotherDigit()
      ),
  };

  const update = (s: Sym, freq = s.freq): void => {
    bound.update(s.total, freq, s.count);
    oracle.update(s.total, freq, s.count);
  };

  let i = 0;
  let block = 0;
  while (i < length) {
    const full = mode !== 'decoder' || rng.chance(0.4);
    const digits = full ? oracle.blockDigits : rng.int(0, oracle.blockDigits);
    if (mode === 'encoder') {
      bound.reset();
    } else {
      bound.reset(digits);
    }
    oracle.reset(digits);
    const start = i;
    let ended = false;

    while (i < length) {
      const s = symbols.next();
      where = `block ${block} symbol ${i} (total ${s.total}, freq ${s.freq}, count ${s.count})`;
      if (mode === 'encoder') {
        if (ask.cap(s)) {
          break;
        }
        if (i === length - 1 && s.count < s.total) {
          ask.decision(s);
        }
        update(s);
      } else if (mode === 'decoder') {
        if (ask.cap(s)) {
          break;
        }
        if (ask.capacity(s)) {
          if (!ask.index(s)) {
            update(s, 1);
            i++;
            ended = true;
          }
          break;
        }
        update(s);
      } else {
        const questions: (keyof typeof ask)[] = (
          ['capacity', 'index', 'decision', 'digits', 'tight'] as const
        ).filter(() => rng.chance(0.3));
        questions.splice(rng.int(0, questions.length), 0, 'cap');
        let closes = false;
        for (const name of questions) {
          const answer = ask[name](s);
          if ((name === 'cap' || name === 'capacity') && answer === true) {
            closes = true;
          }
        }
        if (closes) {
          break;
        }
        update(s);
      }
      i++;
    }

    where = `end of block ${block} after symbol ${i - 1}`;
    if (mode === 'encoder') {
      ask.digits();
    } else if (mode === 'decoder') {
      ask.tight();
    } else {
      ask.digits();
      ask.tight();
      const s = symbols.next();
      ask.decision(s);
    }
    if (ended) {
      return;
    }
    if (i === start) {
      i++;
    }
    block++;
  }
}

describe('BlockBound against an exact oracle', () => {
  it(`agrees on every decision over ${ITERATIONS} random symbol sequences`, () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      runCase(iteration);
    }
  });
});
