/**
 * Property fuzz — two invariants over randomly generated schemas and values:
 * round-trip identity (decode(encode(v)) equals v) and canonical closure
 * (bytes that decode at all must re-encode to exactly themselves, so no value
 * ever has a second wire spelling). The generator is seeded, so every run
 * exercises the same cases and a failure is reproducible.
 */

import { p, PNode } from '../index';

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
  for (let i = 0; i < length; i++) {
    // Stay below the surrogate range so every code unit is a whole character.
    s += String.fromCharCode(randInt(32, 0xd7ff));
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

const scalarCase = (): Case => {
  switch (randInt(0, 7)) {
    case 0: {
      const lo = randInt(-1000, 0);
      const hi = lo + randInt(0, 2000);
      return { node: p.int().min(lo).max(hi), gen: () => randInt(lo, hi) };
    }
    case 1:
      return { node: p.int(), gen: () => randInt(-(2 ** 40), 2 ** 40) };
    case 2: {
      const [step, scale] = pick([
        [0.01, 100],
        [0.1, 10],
        [0.5, 10],
        [1, 1],
        [5, 1],
      ] as const);
      const scaledStep = Math.round(step * scale);
      // Values come from the same scaled-integer grid the node uses, so they
      // are exact multiples by construction.
      return {
        node: p.decimal(step),
        gen: () => (randInt(-100000, 100000) * scaledStep) / scale,
      };
    }
    case 3: {
      // Cover all three significand spellings — noise, ratios, decimals,
      // dyadics and scientific magnitudes — and nudge a share of them so the
      // codec also sees the doubles adjacent to every cheap fraction.
      const floatGen = pick([
        () => (rand() * 2 - 1) * 10 ** randInt(-20, 20),
        () => randInt(1, 5000) / randInt(1, 5000),
        () => randInt(-99999, 99999) / 10 ** randInt(0, 6),
        () => randInt(1, 1000) * 2 ** randInt(-30, 30),
        () => Number(`${randInt(1, 9999)}e${rand() < 0.5 ? '-' : ''}${randInt(0, 300)}`),
      ] as const);
      return {
        node: p.float(),
        gen: () => {
          const raw = floatGen();
          const value = Number.isFinite(raw) && raw !== 0 ? raw : 1.5;
          return rand() < 0.3 ? nudge(value) : value;
        },
      };
    }
    case 4:
      return { node: p.string(), gen: () => randString(10) };
    case 5:
      return { node: p.bool(), gen: () => rand() < 0.5 };
    case 6: {
      const list = ['aa', 'bb', 'cc', 'dd', 'ee'].slice(0, randInt(2, 5));
      return { node: p.enum(list), gen: () => pick(list) };
    }
    default: {
      const min = randInt(-1e13, 0);
      return {
        node: rand() < 0.5 ? p.date() : p.date().min(new Date(min)),
        gen: () => new Date(randInt(min, 1e13)),
      };
    }
  }
};

const anyValue = (depth: number): unknown => {
  switch (randInt(0, depth > 0 ? 6 : 4)) {
    case 0:
      return null;
    case 1:
      return rand() < 0.5;
    case 2:
      return randInt(-1e6, 1e6);
    case 3:
      return rand() * 1000;
    case 4:
      return randString(6);
    case 5:
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

const anyCase = (): Case => ({ node: p.any(), gen: () => anyValue(2) });

const arrayCase = (depth: number): Case => {
  const item = randomCase(depth - 1);
  const length = randInt(0, 4);
  let node = p.array(item.node as never);
  const mode = randInt(0, 2);
  if (mode === 1) node = node.max(length + randInt(0, 3));
  if (mode === 2) node = node.length(length);
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
      shape[key] = fields[key].node.optional();
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

const randomCase = (depth: number): Case => {
  if (depth > 0 && rand() < 0.4) {
    return pick([arrayCase, objectCase, () => anyCase()] as const)(depth);
  }
  return rand() < 0.9 ? scalarCase() : anyCase();
};

describe('Property fuzz', () => {
  it('round-trips and re-encodes canonically over random schemas', () => {
    for (let i = 0; i < 300; i++) {
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
    for (let i = 0; i < 300; i++) {
      const { node, gen } = randomCase(2);
      const bytes = node.encode(gen() as never);
      for (let m = 0; m < 3; m++) {
        const mutated =
          bytes.length === 0 || rand() < 0.2
            ? Uint8Array.of(...bytes, randInt(0, 255)) // padding
            : (() => {
                const copy = Uint8Array.from(bytes);
                const at = randInt(0, copy.length - 1);
                copy[at] = (copy[at] + randInt(1, 255)) % 256; // tampering
                return copy;
              })();
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
});
