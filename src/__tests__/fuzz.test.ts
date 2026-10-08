/**
 * Property fuzz — two invariants over randomly generated schemas and values:
 * round-trip identity (decode(encode(v)) equals v) and canonical closure
 * (bytes that decode at all must re-encode to exactly themselves, so no value
 * ever has a second wire spelling). Both are checked over the byte and text
 * transports, and against corrupted inputs (padding, tampering, truncation).
 * The generator is seeded, so every run exercises the same cases and a
 * failure is reproducible.
 */

import { CharSets, p, PNode, buildProseModel } from '../index';
import type { Charset } from '../index';

const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(0x5eed);
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[randInt(0, xs.length - 1)];

interface Case {
  node: PNode<unknown>;
  gen: () => unknown;
}

const randString = (max: number): string => {
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

const FLOAT_SCRATCH = new Float64Array(1);
const FLOAT_BITS = new BigUint64Array(FLOAT_SCRATCH.buffer);

// Step a value a few doubles up or down. Neighbours of a cheap fraction are
// the adversarial region for the float codec: their rounding intervals abut
// the fraction's, and the significand search must not claim its name.
const nudge = (value: number): number => {
  FLOAT_SCRATCH[0] = value;
  FLOAT_BITS[0] += BigInt(randInt(-3, 3));
  return Number.isFinite(FLOAT_SCRATCH[0]) ? FLOAT_SCRATCH[0] : value;
};

// Cover all three significand spellings — noise, ratios, decimals, dyadics
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

// Nudge a share of every family so the codec also sees the doubles adjacent
// to cheap fractions, binade edges and the subnormal boundary.
const randFloat = (): number => {
  const raw = pick(FLOAT_GENS)();
  const value = Number.isFinite(raw) ? raw : 1.5;
  return rand() < 0.3 ? nudge(value) : value;
};

// A random increasing integer CDF over offsets from zero: linear (level
// weights) or quadratic (weights growing toward the top of the range).
const randCdf = (): ((d: number) => number) => {
  const a = randInt(0, 3);
  const b = randInt(1, 5);
  return (d) => a * d * d + b * d;
};

const randBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, () => randInt(0, 255));

const scalarCase = (): Case => {
  switch (randInt(0, 10)) {
    case 0: {
      const lo = randInt(-1000, 0);
      const hi = lo + randInt(0, 2000);
      // Weighted half the time, like bool and enum below.
      const bounded = p.int().min(lo).max(hi);
      const node =
        rand() < 0.5
          ? bounded
          : bounded.weights(Array.from({ length: hi - lo + 1 }, () => randInt(1, 1000)));
      return { node, gen: () => randInt(lo, hi) };
    }
    case 1:
      return { node: p.int(), gen: () => randInt(-(2 ** 40), 2 ** 40) };
    case 2: {
      // One bound only: the offset rides the term encoding, counting away
      // from the bound. Large offsets cross into the escaped term form.
      const bound = randInt(-1e6, 1e6);
      const offset = (): number => (rand() < 0.5 ? randInt(0, 1e4) : randInt(0, 2 ** 44));
      return rand() < 0.5
        ? { node: p.int().min(bound), gen: () => bound + offset() }
        : { node: p.int().max(bound), gen: () => bound - offset() };
    }
    case 3: {
      const [step, scale] = pick([
        [0.01, 100],
        [0.1, 10],
        [0.5, 10],
        [1, 1],
        [5, 1],
      ] as const);
      const scaledStep = Math.round(step * scale);
      // Values and bounds come from the same scaled-integer grid the node
      // uses, so they are exact multiples by construction.
      const grid = (k: number): number => (k * scaledStep) / scale;
      const kLo = randInt(-100000, 0);
      const kHi = kLo + randInt(0, 200000);
      switch (randInt(0, 3)) {
        case 0:
          return { node: p.decimal(step), gen: () => grid(randInt(-100000, 100000)) };
        case 1:
          return {
            node: p.decimal(step).min(grid(kLo)),
            gen: () => grid(kLo + randInt(0, 200000)),
          };
        case 2:
          return {
            node: p.decimal(step).max(grid(kHi)),
            gen: () => grid(kHi - randInt(0, 200000)),
          };
        default: {
          const bounded = p.decimal(step).min(grid(kLo)).max(grid(kHi));
          const cdf = randCdf();
          return {
            node: rand() < 0.5 ? bounded : bounded.cdf((k) => cdf(k - kLo)),
            gen: () => grid(randInt(kLo, kHi)),
          };
        }
      }
    }
    case 4:
      return { node: p.float(), gen: randFloat };
    case 5: {
      switch (randInt(0, 3)) {
        case 0:
          return { node: p.string(), gen: () => randString(10) };
        case 1: {
          // A bounded length packs as a radix slot instead of a term.
          const max = randInt(0, 12);
          // A floor half the time: the prefix then counts up from it.
          if (rand() < 0.5) {
            const min = randInt(0, max);
            return {
              node: p.string().min(min).max(max),
              gen: () => 'x'.repeat(min) + randString(max - min),
            };
          }
          return { node: p.string().max(max), gen: () => randString(max) };
        }
        case 2:
          // English half the time, else a model counted from random text.
          return {
            node: p
              .string()
              .prose(
                rand() < 0.5 ? undefined : buildProseModel('q' + randString(30), { minCount: 1 })
              ),
            gen: () => randString(10),
          };
        default: {
          // Both charset kinds: an indexed alphabet and a code-unit range.
          if (rand() < 0.5) {
            const alphabet = pick([
              CharSets.digit,
              CharSets.hex,
              CharSets.alpha,
              CharSets.printable,
            ]);
            return {
              node: p.string().charset(alphabet),
              gen: () =>
                Array.from({ length: randInt(0, 10) }, () =>
                  alphabet.charAt(randInt(0, alphabet.length - 1))
                ).join(''),
            };
          }
          const lo = randInt(0, 60000);
          const hi = lo + randInt(1, 5000);
          return {
            node: p.string().charset([lo, hi]),
            gen: () =>
              Array.from({ length: randInt(0, 10) }, () =>
                String.fromCharCode(randInt(lo, hi))
              ).join(''),
          };
        }
      }
    }
    case 6: {
      // Weighted half the time: the prior changes the wire, never the values.
      const node = rand() < 0.5 ? p.bool() : p.bool().weights([randInt(1, 200), randInt(1, 200)]);
      return { node, gen: () => rand() < 0.5 };
    }
    case 7: {
      // Membership is identity, so members can mix types freely.
      const pool = ['aa', 'bb', 'cc', 0, 1, -17, 3.5, true, false, null];
      const members = [...pool].sort(() => rand() - 0.5).slice(0, randInt(2, 6));
      const node =
        rand() < 0.5
          ? p.enum(members)
          : p.enum(members).weights(members.map(() => randInt(1, 1000)));
      return { node, gen: () => pick(members) };
    }
    case 8: {
      // One member per kind: the generators below cover number, string,
      // boolean, null, array and bytes without overlap.
      const options: Case[] = [
        { node: p.int().min(-50).max(50), gen: () => randInt(-50, 50) },
        { node: p.string().max(6), gen: () => randString(6) },
        { node: p.bool(), gen: () => rand() < 0.5 },
        { node: p.null(), gen: () => null },
        { node: p.array(p.int().min(0).max(9)).max(3), gen: () => [randInt(0, 9)] },
        { node: p.bytes().max(4), gen: () => randBytes(randInt(0, 4)) },
      ]
        .sort(() => rand() - 0.5)
        .slice(0, randInt(2, 3));
      const union = p.union(options.map((o) => o.node));
      return {
        node: rand() < 0.5 ? union : union.weights(options.map(() => randInt(1, 1000))),
        gen: () => pick(options).gen(),
      };
    }
    case 9: {
      const max = randInt(0, 40);
      switch (randInt(0, 2)) {
        case 0:
          return { node: p.bytes(), gen: () => randBytes(randInt(0, max)) };
        case 1:
          return { node: p.bytes().max(max), gen: () => randBytes(randInt(0, max)) };
        default:
          // A fixed count spends nothing on the prefix.
          return { node: p.bytes().length(max), gen: () => randBytes(max) };
      }
    }
    default: {
      // Precision floors the timestamp, so values are random timestamps
      // floored by one round trip through the node: only bucket starts
      // satisfy the identity invariant.
      const unit = pick([
        'millisecond',
        'millisecond',
        'second',
        'minute',
        'hour',
        'day',
        'week',
        'month',
        'year',
      ] as const);
      const step = unit === 'minute' && rand() < 0.2 ? 15 : randInt(1, 4);
      // Rough bucket length, only for sizing bounded spans.
      const ms =
        step *
        {
          millisecond: 1,
          second: 1_000,
          minute: 60_000,
          hour: 3_600_000,
          day: 86_400_000,
          week: 604_800_000,
          month: 2_678_400_000,
          year: 31_622_400_000,
        }[unit];
      const base = p.date().precision(unit, step);
      const floored = (node: PNode<Date>, ts: number): Date =>
        node.decode(node.encode(new Date(ts)));
      switch (randInt(0, 3)) {
        case 0:
          return { node: base, gen: () => floored(base, randInt(-8e15, 8e15)) };
        case 1: {
          const min = randInt(-1e12, 1e12);
          const node = base.min(rand() < 0.5 ? min : new Date(min));
          return { node, gen: () => floored(node, min + randInt(0, 1e15)) };
        }
        case 2: {
          const max = randInt(-1e12, 1e12);
          const node = base.max(max);
          return { node, gen: () => floored(node, max - randInt(0, 1e15)) };
        }
        default: {
          const min = randInt(-1e12, 1e12);
          const max = min + randInt(0, 1000) * ms;
          const bounded = base.min(min).max(max);
          const cdf = randCdf();
          const node = rand() < 0.5 ? bounded : bounded.cdf((b) => cdf(b));
          return { node, gen: () => floored(node, randInt(min, max)) };
        }
      }
    }
  }
};

const anyValue = (depth: number, top = false): unknown => {
  switch (randInt(0, depth > 0 ? 8 : 6)) {
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
    case 6:
      // A required object field reads undefined as absent, so the top of a
      // field value must stay defined; anywhere deeper it is a real value.
      return top ? randString(3) : undefined;
    case 7:
      return Array.from({ length: randInt(0, 3) }, () => anyValue(depth - 1));
    default: {
      const record: Record<string, unknown> = {};
      for (let i = 0, n = randInt(0, 3); i < n; i++) {
        record[`k${i}${randString(2)}`] = anyValue(depth - 1);
      }
      return record;
    }
  }
};

const anyCase = (): Case => ({ node: p.any(), gen: () => anyValue(2, true) });

const arrayCase = (depth: number): Case => {
  const item = randomCase(depth - 1);
  const length = randInt(0, 4);
  let node = p.array(item.node as never);
  let free = false;
  let lo = 0;
  let hi = 0;
  switch (randInt(0, 3)) {
    case 1:
      hi = length + randInt(0, 3);
      node = node.max(hi);
      free = true;
      break;
    case 2:
      node = node.length(length);
      break;
    case 3:
      // A raised floor packs the count as its offset from the minimum.
      lo = randInt(0, length);
      node = node.min(lo);
      if (rand() < 0.5) {
        hi = length + randInt(0, 3);
        node = node.max(hi);
        free = true;
      }
      break;
  }
  // A count prior needs a max and a free length.
  if (free && rand() < 0.5) {
    node =
      rand() < 0.5
        ? node.cdf(randCdf())
        : node.weights(Array.from({ length: hi - lo + 1 }, () => randInt(1, 100)));
  }
  return { node, gen: () => Array.from({ length }, () => item.gen()) };
};

const objectCase = (depth: number): Case => {
  const fields: Record<string, Case> = {};
  const shape: Record<string, PNode<unknown>> = {};
  const optional = new Set<string>();
  for (let i = 0, n = randInt(1, 3); i < n; i++) {
    const key = `f${i}`;
    fields[key] = randomCase(depth - 1);
    if (rand() < 0.3) {
      optional.add(key);
      const opt = fields[key].node.optional();
      shape[key] = rand() < 0.5 ? opt : opt.weights([randInt(1, 100), randInt(1, 100)]);
    } else {
      shape[key] = fields[key].node;
    }
  }
  return {
    node: p.object(shape as never) as PNode<unknown>,
    gen: () => {
      const value: Record<string, unknown> = {};
      for (const key of Object.keys(fields)) {
        if (!optional.has(key) || rand() < 0.5) {
          value[key] = fields[key].gen();
        }
      }
      return value;
    },
  };
};

// Members are object cases, whose keys (f0..f2) never collide with the tag.
const taggedCase = (depth: number): Case => {
  const members: Record<string, Case> = {};
  for (let i = 0, n = randInt(1, 3); i < n; i++) {
    members[`m${i}`] = objectCase(depth - 1);
  }
  const tags = Object.keys(members);
  const shape = Object.fromEntries(tags.map((tag) => [tag, members[tag].node]));
  const tagged = p.tagged('t', shape as never);
  return {
    node: rand() < 0.5 ? tagged : tagged.weights(tags.map(() => randInt(1, 1000))),
    gen: () => {
      const tag = pick(tags);
      return { t: tag, ...(members[tag].gen() as object) };
    },
  };
};

const randomCase = (depth: number): Case => {
  if (depth > 0 && rand() < 0.4) {
    return pick([arrayCase, objectCase, taggedCase, () => anyCase()] as const)(depth);
  }
  return rand() < 0.9 ? scalarCase() : anyCase();
};

describe('Property fuzz', () => {
  it('round-trips and re-encodes canonically over random schemas', () => {
    for (let i = 0; i < 1000; i++) {
      const { node, gen } = randomCase(2);
      const value = gen();
      const bytes = node.encode(value as never);
      const decoded = node.decode(bytes);
      expect(decoded).toEqual(value);
      // Canonical closure: our own output re-encodes to itself, byte for byte.
      expect(node.encode(decoded as never)).toEqual(bytes);
    }
  });

  it('mutated bytes either throw or decode to something that owns those bytes', () => {
    for (let i = 0; i < 1000; i++) {
      const { node, gen } = randomCase(2);
      const bytes = node.encode(gen() as never);
      for (let m = 0; m < 3; m++) {
        const mode = bytes.length === 0 ? 0 : randInt(0, 3);
        let mutated: Uint8Array;
        if (mode === 0) {
          mutated = Uint8Array.of(...bytes, randInt(0, 255)); // padding
        } else if (mode === 1) {
          mutated = bytes.subarray(0, randInt(0, bytes.length - 1)); // truncation
        } else {
          const copy = Uint8Array.from(bytes);
          const at = randInt(0, copy.length - 1);
          copy[at] = (copy[at] + randInt(1, 255)) % 256; // tampering
          mutated = copy;
        }
        let decoded: unknown;
        try {
          decoded = node.decode(mutated);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
          continue;
        }
        // If corrupted bytes slip through, they must at least be a canonical
        // encoding of what they decoded to — one spelling per value, always.
        expect(node.encode(decoded as never)).toEqual(mutated);
      }
    }
  });

  it('round-trips through the text transport and rejects tampered text', () => {
    const transports: readonly (Charset | undefined)[] = [
      undefined, // the library default (Base64)
      CharSets.digit,
      CharSets.hex,
      CharSets.printable,
      [0, 65535],
      [0x2800, 0x28ff],
    ];
    const randChar = (charset: Charset | undefined): string => {
      const c = charset ?? CharSets.Base64;
      return typeof c === 'string'
        ? c.charAt(randInt(0, c.length - 1))
        : String.fromCharCode(randInt(c[0], c[1]));
    };

    for (let i = 0; i < 500; i++) {
      const { node, gen } = randomCase(2);
      const charset = pick(transports);
      const value = gen();
      const str = node.encodeString(value as never, charset);
      const decoded = node.decodeString(str, charset);
      expect(decoded).toEqual(value);
      expect(node.encodeString(decoded as never, charset)).toBe(str);

      // One character substituted (or appended, when the text is empty) from
      // the same transport alphabet: decode must reject it or own it.
      let mutated: string;
      if (str.length === 0) {
        mutated = randChar(charset);
      } else {
        const at = randInt(0, str.length - 1);
        let c = randChar(charset);
        while (c === str.charAt(at)) c = randChar(charset);
        mutated = str.slice(0, at) + c + str.slice(at + 1);
      }
      let corrupt: unknown;
      try {
        corrupt = node.decodeString(mutated, charset);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        continue;
      }
      expect(node.encodeString(corrupt as never, charset)).toBe(mutated);
    }
  });
});
