/**
 * Random schemas, values, codec options and corruptions, shared by the
 * property fuzz (src/__tests__/fuzz.test.ts) and the differential fuzz
 * (scripts/diff-fuzz.ts).
 *
 * A case describes its schema rather than holding a built node: `build`
 * constructs it against any copy of the library, so two module instances get
 * the same schema, and `src` spells it as readable source. Every draw comes
 * from the generator installed with `useRng`, so a caller that seeds it gets
 * reproducible cases.
 */

import * as lib from '../index';
import type { Charset } from '../index';
import { mulberry32 } from './support';

/** A copy of the library: the working tree's, or any other version's. */
export type Lib = typeof lib;
/** A node built by one copy; other copies' node types differ, so it stays untyped. */
type Node = any;

let next: () => number = mulberry32(1);

/** Installs the generator every draw below comes from. */
export const useRng = (rng: () => number): void => {
  next = rng;
};

export const rand = (): number => next();
export const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
export const pick = <T>(xs: readonly T[]): T => xs[randInt(0, xs.length - 1)];

/** A schema built the same way on any copy, a value generator and its source form. */
export interface Case {
  build: (m: Lib) => Node;
  gen: () => unknown;
  src: string;
  /**
   * Set when the schema holds a p.versioned with an older version: bytes of
   * that version decode to a migrated value, which re-encodes as the newest
   * version, so decodable input is not always its value's canonical spelling.
   */
  migrates?: boolean;
}

const json = (v: unknown): string => JSON.stringify(v);

export const randString = (max: number): string => {
  let s = '';
  const length = randInt(0, max);
  while (s.length < length) {
    // Half ASCII, half anywhere in [0, 0x10FFFF]: over enough runs this
    // yields astral characters, lone surrogates, and adjacent lead+trail
    // picks that merge into one code point.
    const code = rand() < 0.5 ? randInt(32, 126) : randInt(0, 0x10ffff);
    if (code > 0xffff && s.length + 2 > length) {
      continue;
    }
    s += String.fromCodePoint(code);
  }
  return s;
};

export const randBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, () => randInt(0, 255));

const randWeights = (n: number, max: number): number[] =>
  Array.from({ length: n }, () => randInt(1, max));

const FLOAT_SCRATCH = new Float64Array(1);
const FLOAT_BITS = new BigUint64Array(FLOAT_SCRATCH.buffer);

// Steps a value a few doubles up or down. Neighbours of a cheap fraction are
// the adversarial region for the float codec: their rounding intervals abut
// the fraction's, and the significand search must not claim its name.
const nudge = (value: number): number => {
  FLOAT_SCRATCH[0] = value;
  FLOAT_BITS[0] += BigInt(randInt(-3, 3));
  return Number.isFinite(FLOAT_SCRATCH[0]) ? FLOAT_SCRATCH[0] : value;
};

// Covers all three significand spellings — noise, ratios, decimals, dyadics
// and scientific magnitudes — plus the values with no [1, 2) significand at
// all: zeros, subnormals and the extremes of the finite range, which live on
// the flat paths the fraction search never reaches.
const FLOAT_GENS = [
  () => (rand() * 2 - 1) * 10 ** randInt(-20, 20),
  () => randInt(1, 5000) / randInt(1, 5000),
  () => randInt(-99999, 99999) / 10 ** randInt(0, 6),
  () => randInt(1, 1000) * 2 ** randInt(-30, 30),
  () => Number(`${randInt(1, 9999)}e${rand() < 0.5 ? '-' : ''}${randInt(0, 300)}`),
  () => pick([0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, 2 ** -1022]),
  () => randInt(1, 2 ** 40) * 2 ** -1074,
] as const;

// Nudges a share of every family so the codec also sees the doubles adjacent
// to cheap fractions, binade edges and the subnormal boundary.
export const randFloat = (): number => {
  const raw = pick(FLOAT_GENS)();
  const value = Number.isFinite(raw) ? raw : 1.5;
  return rand() < 0.3 ? nudge(value) : value;
};

/**
 * An increasing integer CDF `a·d² + b·d` over offsets `d` from `shift`:
 * linear (level weights) or quadratic (weights growing toward the top of the
 * range), with its source.
 */
const randCdf = (shift: number): { fn: (v: number) => number; src: string } => {
  const a = randInt(0, 3);
  const b = randInt(1, 5);
  return {
    fn: (v) => a * (v - shift) ** 2 + b * (v - shift),
    src: `(v) => ${a} * (v - ${shift}) ** 2 + ${b} * (v - ${shift})`,
  };
};

const intCase = (): Case => {
  const lo = randInt(-1000, 0);
  const hi = lo + randInt(0, rand() < 0.5 ? 300 : 2000);
  const any = (): number => (rand() < 0.2 ? pick([lo, hi]) : randInt(lo, hi));
  const base = `p.int().min(${lo}).max(${hi})`;
  switch (randInt(0, 4)) {
    case 0:
      return { build: (m) => m.p.int().min(lo).max(hi), gen: any, src: base };
    case 1: {
      const w = randWeights(hi - lo + 1, 1000);
      return {
        build: (m) => m.p.int().min(lo).max(hi).weights(w),
        gen: any,
        src: `${base}.weights(${json(w)})`,
      };
    }
    case 2: {
      const cdf = randCdf(lo);
      return {
        build: (m) => m.p.int().min(lo).max(hi).cdf(cdf.fn),
        gen: any,
        src: `${base}.cdf(${cdf.src})`,
      };
    }
    case 3: {
      // One value holds nearly all the weight, so its frequency sits near
      // the total, and runs of it are likely.
      const heavy = randInt(lo, hi);
      const w = Array.from({ length: hi - lo + 1 }, (_, i) =>
        lo + i === heavy ? randInt(2 ** 30, 2 ** 45) : randInt(1, 3)
      );
      return {
        build: (m) => m.p.int().min(lo).max(hi).weights(w),
        gen: () => (rand() < 0.9 ? heavy : any()),
        src: `${base}.weights(${json(w)})`,
      };
    }
    default: {
      // A wide range whose zero holds nearly all of a total near 2^50.
      const max = 2 ** randInt(20, 40);
      const heavy = randInt(2 ** 40, 2 ** 50);
      return {
        build: (m) =>
          m.p
            .int()
            .min(0)
            .max(max)
            .cdf((v) => (v === 0 ? 0 : heavy + v)),
        gen: () => (rand() < 0.9 ? 0 : randInt(0, max)),
        src: `p.int().min(0).max(${max}).cdf((v) => (v === 0 ? 0 : ${heavy} + v))`,
      };
    }
  }
};

const unboundedIntCase = (): Case => ({
  build: (m) => m.p.int(),
  gen: () => {
    const r = rand();
    return r < 0.2
      ? randInt(-(2 ** 53) + 1, 2 ** 53 - 1)
      : r < 0.6
        ? randInt(-(2 ** 40), 2 ** 40)
        : randInt(-1e6, 1e6);
  },
  src: 'p.int()',
});

// One bound only: the offset rides the term encoding, counting away from the
// bound. Large offsets cross into the escaped term form.
const halfBoundedIntCase = (): Case => {
  const bound = randInt(-1e6, 1e6);
  const offset = (): number => (rand() < 0.5 ? randInt(0, 1e4) : randInt(0, 2 ** 44));
  return rand() < 0.5
    ? {
        build: (m) => m.p.int().min(bound),
        gen: () => bound + offset(),
        src: `p.int().min(${bound})`,
      }
    : {
        build: (m) => m.p.int().max(bound),
        gen: () => bound - offset(),
        src: `p.int().max(${bound})`,
      };
};

const decimalCase = (): Case => {
  const [step, scale] = pick([
    [0.01, 100],
    [0.1, 10],
    [0.5, 10],
    [1, 1],
    [5, 1],
  ] as const);
  const scaledStep = Math.round(step * scale);
  // Values and bounds come from the same scaled-integer grid the node uses,
  // so they are exact multiples by construction.
  const grid = (k: number): number => (k * scaledStep) / scale;
  const kLo = randInt(-100000, 0);
  const kHi = kLo + randInt(0, rand() < 0.5 ? 2000 : 200000);
  switch (randInt(0, 3)) {
    case 0:
      return {
        build: (m) => m.p.decimal(step),
        gen: () => grid(randInt(-100000, 100000)),
        src: `p.decimal(${step})`,
      };
    case 1:
      return {
        build: (m) => m.p.decimal(step).min(grid(kLo)),
        gen: () => grid(kLo + randInt(0, 200000)),
        src: `p.decimal(${step}).min(${grid(kLo)})`,
      };
    case 2:
      return {
        build: (m) => m.p.decimal(step).max(grid(kHi)),
        gen: () => grid(kHi - randInt(0, 200000)),
        src: `p.decimal(${step}).max(${grid(kHi)})`,
      };
    default: {
      const src = `p.decimal(${step}).min(${grid(kLo)}).max(${grid(kHi)})`;
      const gen = (): number => grid(randInt(kLo, kHi));
      if (rand() < 0.5) {
        return { build: (m) => m.p.decimal(step).min(grid(kLo)).max(grid(kHi)), gen, src };
      }
      const cdf = randCdf(kLo);
      return {
        build: (m) => m.p.decimal(step).min(grid(kLo)).max(grid(kHi)).cdf(cdf.fn),
        gen,
        src: `${src}.cdf(${cdf.src})`,
      };
    }
  }
};

const STRING_CHARSETS = ['digit', 'hex', 'alpha', 'printable', 'urlSafe'] as const;

const stringCase = (): Case => {
  switch (randInt(0, 3)) {
    case 0:
      return { build: (m) => m.p.string(), gen: () => randString(10), src: 'p.string()' };
    case 1: {
      // A bounded length packs as a radix slot instead of a term; a floor
      // half the time, which the prefix then counts up from.
      const max = randInt(0, 12);
      const min = rand() < 0.5 ? randInt(0, max) : 0;
      return {
        build: (m) => m.p.string().min(min).max(max),
        gen: () => 'x'.repeat(min) + randString(max - min),
        src: `p.string().min(${min}).max(${max})`,
      };
    }
    case 2: {
      // English half the time, else a model counted from random text.
      if (rand() < 0.5) {
        return {
          build: (m) => m.p.string().prose(),
          gen: () => (rand() < 0.5 ? randString(10) : pick(['the cat', 'Hello, world!', 'qu'])),
          src: 'p.string().prose()',
        };
      }
      const corpus = 'q' + randString(30);
      return {
        build: (m) => m.p.string().prose(m.buildProseModel(corpus, { minCount: 1 })),
        gen: () => randString(10),
        src: `p.string().prose(buildProseModel(${json(corpus)}, { minCount: 1 }))`,
      };
    }
    default: {
      // Both charset kinds: an indexed alphabet and a code-unit range.
      if (rand() < 0.5) {
        const name = pick(STRING_CHARSETS);
        const alphabet = lib.CharSets[name];
        return {
          build: (m) => m.p.string().charset(m.CharSets[name]),
          gen: () =>
            Array.from({ length: randInt(0, 10) }, () =>
              alphabet.charAt(randInt(0, alphabet.length - 1))
            ).join(''),
          src: `p.string().charset(CharSets.${name})`,
        };
      }
      const lo = randInt(0, 50000);
      const hi = lo + randInt(1, 5000);
      return {
        build: (m) => m.p.string().charset([lo, hi]),
        gen: () =>
          Array.from({ length: randInt(0, 10) }, () => String.fromCharCode(randInt(lo, hi))).join(
            ''
          ),
        src: `p.string().charset([${lo}, ${hi}])`,
      };
    }
  }
};

// The prior changes the wire, never the values.
const boolCase = (): Case => {
  switch (randInt(0, 2)) {
    case 0:
      return { build: (m) => m.p.bool(), gen: () => rand() < 0.5, src: 'p.bool()' };
    case 1: {
      const w = randWeights(2, 200);
      return {
        build: (m) => m.p.bool().weights(w),
        gen: () => rand() < 0.5,
        src: `p.bool().weights(${json(w)})`,
      };
    }
    default: {
      const w = [randInt(2 ** 30, 2 ** 45), randInt(1, 3)];
      return {
        build: (m) => m.p.bool().weights(w),
        gen: () => rand() < 0.95,
        src: `p.bool().weights(${json(w)})`,
      };
    }
  }
};

// Membership is identity, so members can mix types freely.
const enumCase = (): Case => {
  const pool = ['aa', 'bb', 'cc', 0, 1, -17, 3.5, true, false, null];
  const members = [...pool].sort(() => rand() - 0.5).slice(0, randInt(1, 6));
  const src = `p.enum(${json(members)})`;
  if (rand() < 0.5) {
    return { build: (m) => m.p.enum(members), gen: () => pick(members), src };
  }
  const w = randWeights(members.length, 1000);
  return {
    build: (m) => m.p.enum(members).weights(w),
    gen: () => pick(members),
    src: `${src}.weights(${json(w)})`,
  };
};

// One member per kind: the generators below cover number, string, boolean,
// null, array and bytes without overlap.
const unionCase = (): Case => {
  const members: Case[] = [
    {
      build: (m) => m.p.int().min(-50).max(50),
      gen: () => randInt(-50, 50),
      src: 'p.int().min(-50).max(50)',
    },
    { build: (m) => m.p.string().max(6), gen: () => randString(6), src: 'p.string().max(6)' },
    { build: (m) => m.p.bool(), gen: () => rand() < 0.5, src: 'p.bool()' },
    { build: (m) => m.p.null(), gen: () => null, src: 'p.null()' },
    {
      build: (m) => m.p.array(m.p.int().min(0).max(9)).max(3),
      gen: () => [randInt(0, 9)],
      src: 'p.array(p.int().min(0).max(9)).max(3)',
    },
    {
      build: (m) => m.p.binary().max(4),
      gen: () => randBytes(randInt(0, 4)),
      src: 'p.binary().max(4)',
    },
  ];
  const options = members.sort(() => rand() - 0.5).slice(0, randInt(2, 3));
  const src = `p.union([${options.map((o) => o.src).join(', ')}])`;
  const gen = (): unknown => pick(options).gen();
  if (rand() < 0.5) {
    return { build: (m) => m.p.union(options.map((o) => o.build(m))), gen, src };
  }
  const w = randWeights(options.length, 1000);
  return {
    build: (m) => m.p.union(options.map((o) => o.build(m))).weights(w),
    gen,
    src: `${src}.weights(${json(w)})`,
  };
};

const binaryCase = (): Case => {
  // Whole multiples of 32 bytes put a uniform run's product exactly on a
  // 256-bit scale step.
  const max = rand() < 0.3 ? 32 * randInt(1, 4) : randInt(0, 40);
  // Raw bits, so any element pattern must survive: random bytes become
  // random Int16, Float64 (NaN payloads included) and BigUint64 values.
  if (rand() < 0.5) {
    const name = pick(['Int16Array', 'Float64Array', 'BigUint64Array'] as const);
    const type = globalThis[name];
    return {
      build: (m) => m.p.binary(type as typeof Int16Array).max(max),
      gen: () =>
        new type(randBytes(randInt(0, max) * type.BYTES_PER_ELEMENT).buffer as ArrayBuffer),
      src: `p.binary(${name}).max(${max})`,
    };
  }
  switch (randInt(0, 2)) {
    case 0:
      return {
        build: (m) => m.p.binary(),
        gen: () => randBytes(randInt(0, max)),
        src: 'p.binary()',
      };
    case 1:
      return {
        build: (m) => m.p.binary().max(max),
        gen: () => randBytes(randInt(0, max)),
        src: `p.binary().max(${max})`,
      };
    default:
      // A fixed count spends nothing on the prefix.
      return {
        build: (m) => m.p.binary().length(max),
        gen: () => randBytes(max),
        src: `p.binary().length(${max})`,
      };
  }
};

/** Rough bucket lengths, only for sizing bounded spans. */
const DATE_MS = {
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_678_400_000,
  year: 31_622_400_000,
} as const;
type DateUnit = keyof typeof DATE_MS;
const DATE_UNITS: DateUnit[] = ['millisecond', ...(Object.keys(DATE_MS) as DateUnit[])];

// Precision floors the timestamp, so values are random timestamps floored by
// one round trip through the working tree's node: only bucket starts satisfy
// the identity invariant. A copy that floors differently shows up as a
// decode divergence.
const dateCase = (): Case => {
  const unit = pick(DATE_UNITS);
  const step = unit === 'minute' && rand() < 0.2 ? 15 : randInt(1, 4);
  const ms = step * DATE_MS[unit];
  const base = `p.date().precision('${unit}', ${step})`;
  const withNode = (build: (m: Lib) => Node, src: string, ts: () => number): Case => {
    let local: Node;
    return {
      build,
      src,
      gen: () => {
        local ??= build(lib);
        return local.decode(local.encode(new Date(ts())));
      },
    };
  };
  switch (randInt(0, 3)) {
    case 0:
      return withNode(
        (m) => m.p.date().precision(unit, step),
        base,
        () => randInt(-8e15, 8e15)
      );
    case 1: {
      const min = randInt(-1e12, 1e12);
      if (rand() < 0.5) {
        return withNode(
          (m) => m.p.date().precision(unit, step).min(min),
          `${base}.min(${min})`,
          () => min + randInt(0, 1e15)
        );
      }
      return withNode(
        (m) => m.p.date().precision(unit, step).min(new Date(min)),
        `${base}.min(new Date(${min}))`,
        () => min + randInt(0, 1e15)
      );
    }
    case 2: {
      const max = randInt(-1e12, 1e12);
      return withNode(
        (m) => m.p.date().precision(unit, step).max(max),
        `${base}.max(${max})`,
        () => max - randInt(0, 1e15)
      );
    }
    default: {
      const min = randInt(-1e12, 1e12);
      const max = min + randInt(0, 1000) * ms;
      const src = `${base}.min(${min}).max(${max})`;
      if (rand() < 0.5) {
        return withNode(
          (m) => m.p.date().precision(unit, step).min(min).max(max),
          src,
          () => randInt(min, max)
        );
      }
      // The cdf sees bucket numbers from the epoch; an anchor safely below
      // min's bucket keeps it increasing across the range.
      const cdf = randCdf(Math.floor(min / ms) - 1000);
      return withNode(
        (m) => m.p.date().precision(unit, step).min(min).max(max).cdf(cdf.fn),
        `${src}.cdf(${cdf.src})`,
        () => randInt(min, max)
      );
    }
  }
};

export const scalarCase = (): Case => {
  switch (randInt(0, 10)) {
    case 0:
      return intCase();
    case 1:
      return unboundedIntCase();
    case 2:
      return halfBoundedIntCase();
    case 3:
      return decimalCase();
    case 4:
      return { build: (m) => m.p.float(), gen: randFloat, src: 'p.float()' };
    case 5:
      return stringCase();
    case 6:
      return boolCase();
    case 7:
      return enumCase();
    case 8:
      return unionCase();
    case 9:
      return binaryCase();
    default:
      return dateCase();
  }
};

const ANY_TYPED_ARRAYS = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
] as const;

export const anyValue = (depth: number, top = false): unknown => {
  switch (randInt(0, depth > 0 ? 11 : 7)) {
    case 0:
      return null;
    case 1:
      return rand() < 0.5;
    case 2:
      return randInt(-1e6, 1e6);
    case 3:
      // Integer-valued doubles (dyadics, huge magnitudes) take the int tag,
      // everything else the float tag, so one generator feeds both.
      return randFloat();
    case 4:
      return randString(6);
    case 5:
      return new Date(randInt(-8e15, 8e15));
    case 6: {
      // Raw bits: random bytes make every element pattern of the class.
      const type = pick(ANY_TYPED_ARRAYS);
      return new type(randBytes(randInt(0, 3) * type.BYTES_PER_ELEMENT).buffer as ArrayBuffer);
    }
    case 7:
      // A required object field reads undefined as absent, so the top of a
      // field value stays defined; anywhere deeper it is a real value.
      return top ? randString(3) : undefined;
    case 8:
      return Array.from({ length: randInt(0, 3) }, () => anyValue(depth - 1));
    case 9: {
      const record: Record<string, unknown> = {};
      for (let i = 0, n = randInt(0, 3); i < n; i++) {
        record[`k${i}${randString(2)}`] = anyValue(depth - 1);
      }
      return record;
    }
    case 10:
      return new Map(
        Array.from({ length: randInt(0, 3) }, () => [anyValue(depth - 1), anyValue(depth - 1)])
      );
    default:
      return new Set(Array.from({ length: randInt(0, 3) }, () => anyValue(depth - 1)));
  }
};

const anyCase = (): Case => ({
  build: (m) => m.p.any(),
  gen: () => anyValue(2, true),
  src: 'p.any()',
});

const trees = new WeakMap<Lib, Node>();
const treeOf = (m: Lib): Node => {
  if (!trees.has(m)) {
    const tree: Node = m.p.object({
      v: m.p.int().min(0).max(9),
      kids: m.p.array(m.p.lazy(() => tree)).max(3),
    });
    trees.set(m, tree);
  }
  return trees.get(m);
};
const treeValue = (depth: number): unknown => ({
  v: randInt(0, 9),
  kids: depth > 0 ? Array.from({ length: randInt(0, 3) }, () => treeValue(depth - 1)) : [],
});

const lazyCase = (): Case => ({
  build: treeOf,
  gen: () => treeValue(randInt(0, 3)),
  src: 'Tree /* p.object({ v: p.int().min(0).max(9), kids: p.array(p.lazy(() => Tree)).max(3) }) */',
});

interface Step {
  apply: (n: Node) => Node;
  src: string;
}

/**
 * Count methods for a container that will hold `length` items: none, a max,
 * a fixed length, or a floor with an optional max, and with a max and a free
 * length now and then a prior.
 */
const countSteps = (length: number): Step[] => {
  const steps: Step[] = [];
  const add = (src: string, apply: (n: Node) => Node): void => {
    steps.push({ src, apply });
  };
  let free = false;
  let lo = 0;
  let hi = 0;
  switch (randInt(0, 3)) {
    case 1:
      hi = length + randInt(0, 3);
      add(`.max(${hi})`, (n) => n.max(hi));
      free = true;
      break;
    case 2:
      add(`.length(${length})`, (n) => n.length(length));
      break;
    case 3:
      // A raised floor packs the count as its offset from the minimum.
      lo = randInt(0, length);
      add(`.min(${lo})`, (n) => n.min(lo));
      if (rand() < 0.5) {
        hi = length + randInt(0, 3);
        add(`.max(${hi})`, (n) => n.max(hi));
        free = true;
      }
      break;
  }
  // A count prior needs a max and a free length.
  if (free && rand() < 0.5) {
    if (rand() < 0.5) {
      const cdf = randCdf(0);
      add(`.cdf(${cdf.src})`, (n) => n.cdf(cdf.fn));
    } else {
      const w = randWeights(hi - lo + 1, 100);
      add(`.weights(${json(w)})`, (n) => n.weights(w));
    }
  }
  return steps;
};

const withSteps = (node: Node, steps: Step[]): Node => steps.reduce((n, s) => s.apply(n), node);

const arrayCase = (depth: number): Case => {
  const item = randomCase(depth - 1);
  // Now and then a long run of leaf items, which crosses block boundaries;
  // a multiple of 256 puts a run of bits exactly on a 256-bit scale step.
  const long = (): number => (rand() < 0.5 ? randInt(100, 3000) : 256 * randInt(1, 8));
  const length = depth === 1 && rand() < 0.15 ? long() : randInt(0, 4);
  const steps = countSteps(length);
  return {
    build: (m) => withSteps(m.p.array(item.build(m)), steps),
    migrates: item.migrates,
    gen: () => Array.from({ length }, () => item.gen()),
    src: `p.array(${item.src})${steps.map((s) => s.src).join('')}`,
  };
};

// Keys and items come from nodes with far more values than a collection
// holds, so drawing until the collection is full always gets there.
const keyCase = (): Case =>
  pick([
    unboundedIntCase,
    halfBoundedIntCase,
    anyCase,
    (): Case => ({ build: (m) => m.p.string(), gen: () => randString(6), src: 'p.string()' }),
    (): Case => ({ build: (m) => m.p.float(), gen: randFloat, src: 'p.float()' }),
  ])();

/** Draws entries until `size` reports `length`; repeated keys only overwrite. */
const fill = <T>(into: T, size: (c: T) => number, length: number, add: (c: T) => void): T => {
  while (size(into) < length) add(into);
  return into;
};

// One map, record or set over random keys, values and count methods. A
// record's keys include integer-like ones, which an object lists first.
const collectionCase = (depth: number): Case => {
  const length = randInt(0, 4);
  const steps = countSteps(length);
  const value = randomCase(depth - 1);
  const tail = steps.map((s) => s.src).join('');
  switch (randInt(0, 2)) {
    case 0: {
      const key = keyCase();
      return {
        build: (m) => withSteps(m.p.map(key.build(m), value.build(m)), steps),
        migrates: value.migrates,
        gen: () =>
          fill(
            new Map(),
            (c) => c.size,
            length,
            (c) => c.set(key.gen(), value.gen())
          ),
        src: `p.map(${key.src}, ${value.src})${tail}`,
      };
    }
    case 1:
      return {
        build: (m) => withSteps(m.p.record(value.build(m)), steps),
        migrates: value.migrates,
        gen: () =>
          fill<Record<string, unknown>>(
            {},
            (c) => Object.keys(c).length,
            length,
            (c) => {
              c[rand() < 0.3 ? String(randInt(0, 30)) : randString(4)] = value.gen();
            }
          ),
        src: `p.record(${value.src})${tail}`,
      };
    default: {
      const item = keyCase();
      return {
        build: (m) => withSteps(m.p.set(item.build(m)), steps),
        gen: () =>
          fill(
            new Set(),
            (c) => c.size,
            length,
            (c) => c.add(item.gen())
          ),
        src: `p.set(${item.src})${tail}`,
      };
    }
  }
};

interface Field {
  key: string;
  c: Case;
  mode: 'plain' | 'optional' | 'nullable';
  w?: [number, number];
}

const objectCase = (depth: number): Case => {
  const fields: Field[] = [];
  for (let i = 0, n = randInt(0, 3); i < n; i++) {
    const r = rand();
    const mode = r < 0.25 ? 'optional' : r < 0.4 ? 'nullable' : 'plain';
    fields.push({
      key: `f${i}`,
      c: randomCase(depth - 1),
      mode,
      w: mode === 'optional' && rand() < 0.5 ? [randInt(1, 100), randInt(1, 100)] : undefined,
    });
  }
  const wrap = (m: Lib, f: Field): Node => {
    const inner = f.c.build(m);
    if (f.mode === 'nullable') return m.p.nullable(inner);
    if (f.mode === 'plain') return inner;
    const opt = m.p.optional(inner);
    return f.w ? opt.weights(f.w) : opt;
  };
  const fieldSrc = (f: Field): string =>
    f.mode === 'plain' ? f.c.src : `p.${f.mode}(${f.c.src})${f.w ? `.weights(${json(f.w)})` : ''}`;
  return {
    build: (m) => m.p.object(Object.fromEntries(fields.map((f) => [f.key, wrap(m, f)]))),
    migrates: fields.some((f) => f.c.migrates),
    gen: () => {
      const value: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.mode === 'optional' && rand() < 0.5) continue;
        value[f.key] = f.mode === 'nullable' && rand() < 0.5 ? null : f.c.gen();
      }
      return value;
    },
    src: `p.object({ ${fields.map((f) => `${f.key}: ${fieldSrc(f)}`).join(', ')} })`,
  };
};

// Members are object cases, whose keys (f0..f2) never collide with the tag.
const taggedCase = (depth: number): Case => {
  const members: [string, Case][] = [];
  for (let i = 0, n = randInt(1, 3); i < n; i++) members.push([`m${i}`, objectCase(depth - 1)]);
  const w = rand() < 0.5 ? randWeights(members.length, 1000) : undefined;
  const build = (m: Lib): Node => {
    const node = m.p.tagged('t', Object.fromEntries(members.map(([tag, c]) => [tag, c.build(m)])));
    return w ? node.weights(w) : node;
  };
  return {
    build,
    migrates: members.some(([, c]) => c.migrates),
    gen: () => {
      const [tag, c] = pick(members);
      return { t: tag, ...(c.gen() as object) };
    },
    src:
      `p.tagged('t', { ${members.map(([tag, c]) => `${tag}: ${c.src}`).join(', ')} })` +
      (w ? `.weights(${json(w)})` : ''),
  };
};

// A weighted symbol, then a uniform run whose radix product is exactly a
// power of two on a 256-bit scale step: the message's bound sits just past
// the step, where the float regime's margins are thinnest.
const stepCase = (): Case => {
  const w = randWeights(2, 20);
  const flag = `flag: p.bool().weights(${json(w)})`;
  if (rand() < 0.5) {
    const length = 32 * randInt(1, 6);
    return {
      build: (m) => m.p.object({ flag: m.p.bool().weights(w), data: m.p.binary().length(length) }),
      gen: () => ({ flag: rand() < 0.5, data: randBytes(length) }),
      src: `p.object({ ${flag}, data: p.binary().length(${length}) })`,
    };
  }
  const length = 256 * randInt(1, 6);
  return {
    build: (m) =>
      m.p.object({ flag: m.p.bool().weights(w), bits: m.p.array(m.p.bool()).length(length) }),
    gen: () => ({ flag: rand() < 0.5, bits: Array.from({ length }, () => rand() < 0.5) }),
    src: `p.object({ ${flag}, bits: p.array(p.bool()).length(${length}) })`,
  };
};

// A version prefix alone, or a later version over a scalar first one.
const versionedCase = (inner: Case): Case => {
  if (rand() < 0.5) {
    return {
      build: (m) => m.p.versioned(inner.build(m)),
      gen: inner.gen,
      migrates: inner.migrates,
      src: `p.versioned(${inner.src})`,
    };
  }
  const first = scalarCase();
  return {
    build: (m) => m.p.versioned(first.build(m), [inner.build(m), () => undefined]),
    gen: inner.gen,
    migrates: true,
    src: `p.versioned(${first.src}, [${inner.src}, () => undefined])`,
  };
};

/** A random schema nested up to `depth` levels below its root, with values for it. */
export const randomCase = (depth: number): Case => {
  if (depth > 1 && rand() < 0.05) {
    return stepCase();
  }
  const chosen =
    depth > 0 && rand() < 0.4
      ? pick([arrayCase, objectCase, taggedCase, anyCase, lazyCase, collectionCase] as const)(depth)
      : rand() < 0.9
        ? scalarCase()
        : anyCase();
  // One case in ten under a version prefix, so the prefix is fuzzed too.
  return rand() < 0.1 ? versionedCase(chosen) : chosen;
};

// ---------- codec options ----------

/** Layout of one message. */
export interface Opts {
  type: 'binary' | 'text';
  charset?: Charset;
  blockBits?: number;
}

// Digit bases from 3 to 1000 symbols, both charset kinds, beside the defaults.
const TEXT_CHARSETS: readonly (Charset | undefined)[] = [
  undefined,
  '012',
  lib.CharSets.urlSafe,
  lib.CharSets.digit,
  lib.CharSets.hex,
  lib.CharSets.printable,
  [0, 0xd7ff],
  [0x2800, 0x28ff],
  [0x4e00, 0x4e00 + 999],
];
const BYTE_CHARSETS: readonly (Charset | undefined)[] = [
  undefined,
  undefined,
  '012',
  [0, 127],
  [32, 126],
  lib.CharSets.printable,
];
const BLOCK_BITS = [undefined, undefined, 128, 256, 1000, 4096, 65536];

/** A random message layout: `type` when given, else either, at a random charset and block size. */
export const randOpts = (type: Opts['type'] = rand() < 0.5 ? 'binary' : 'text'): Opts => ({
  type,
  charset: pick(type === 'text' ? TEXT_CHARSETS : BYTE_CHARSETS),
  blockBits: pick(BLOCK_BITS),
});

// ---------- corruptions ----------

/** The codes a layout spells messages in. */
const codesOf = (o: Opts): { has: (c: number) => boolean; random: () => number } => {
  const c = o.charset ?? (o.type === 'text' ? lib.CharSets.base64 : [0, 255]);
  if (typeof c === 'string') {
    return {
      has: (x) => c.includes(String.fromCharCode(x)),
      random: () => c.charCodeAt(randInt(0, c.length - 1)),
    };
  }
  return { has: (x) => x >= c[0] && x <= c[1], random: () => randInt(c[0], c[1]) };
};

/**
 * Corrupted copies of a message: the last code dropped, a truncation, one
 * code replaced by another of the layout's codes, one code appended, and one
 * code from outside the layout inserted.
 */
export const corruptions = (
  enc: Uint8Array | string,
  o: Opts
): { what: string; input: Uint8Array | string }[] => {
  const codes = codesOf(o);
  const arr =
    typeof enc === 'string'
      ? Array.from({ length: enc.length }, (_, i) => enc.charCodeAt(i))
      : Array.from(enc);
  // Built code by code rather than spread as arguments: a long message would
  // overflow the call stack.
  const pack = (xs: number[]): Uint8Array | string =>
    typeof enc === 'string' ? xs.map((x) => String.fromCharCode(x)).join('') : Uint8Array.from(xs);
  const out: { what: string; input: Uint8Array | string }[] = [];
  const len = arr.length;
  if (len > 0) {
    out.push({ what: 'drop last', input: pack(arr.slice(0, len - 1)) });
    out.push({ what: 'truncate', input: pack(arr.slice(0, randInt(0, len - 1))) });
    const at = randInt(0, len - 1);
    const flipped = [...arr];
    flipped[at] = codes.random();
    if (flipped[at] !== arr[at]) out.push({ what: `flip at ${at}`, input: pack(flipped) });
  }
  out.push({ what: 'pad', input: pack([...arr, codes.random()]) });
  const limit = o.type === 'text' ? 65535 : 255;
  for (let tries = 0; tries < 20; tries++) {
    const x = randInt(0, limit);
    if (!codes.has(x) && !(o.type === 'text' && x >= 0xd800 && x <= 0xdfff)) {
      const at = randInt(0, len);
      out.push({
        what: `out-of-charset ${x} at ${at}`,
        input: pack([...arr.slice(0, at), x, ...arr.slice(at)]),
      });
      break;
    }
  }
  return out;
};
