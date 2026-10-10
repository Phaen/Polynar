/**
 * Differential fuzz: the working tree against a git ref.
 *
 *   npm run fuzz:diff -- <ref> [seed] [iterations]
 *
 * Both sides are bundled from `src/index.ts` and fed the same random cases:
 * schemas with values (priors, prose, charsets, block sizes, plus corrupted
 * inputs: truncated, padded, flipped, out-of-charset) and raw packer symbol
 * sequences aimed at block-boundary ties. Encode output, decode results and
 * thrown errors (class, name and message) must match. Any divergence prints
 * with its seed, iteration and a readable schema, and the exit code is 1.
 *
 * Refs from e0700c1 on run, on either API shape: the one-`encode` options
 * form and the older `encodeString`/`toUint8Array` options form. Byte output
 * with a string charset exists only in the former, so those cases are
 * skipped against the latter. Earlier refs, with positional charsets, are
 * refused.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { build } from 'esbuild';

type Charset = string | [number, number];
type Mod = any;
type Node = any;

/** Layout of one message, in the current API's terms. */
interface Opts {
  type: 'binary' | 'text';
  charset?: Charset;
  blockBits?: number;
}

/** One side of the comparison: a bundle and calls shaped for its API. */
interface Side {
  label: string;
  mod: Mod;
  supports(o: Opts): boolean;
  encode(node: Node, value: unknown, o: Opts): Uint8Array | string;
  decode(node: Node, input: Uint8Array | string, o: Opts): unknown;
  output(enc: any, o: Opts): Uint8Array | string;
  decoder(input: Uint8Array | string, o: Opts): any;
}

const side = (label: string, mod: Mod): Side => {
  if (typeof mod.Encoder.prototype.output === 'function') {
    const opts = (o: Opts) => ({ type: o.type, charset: o.charset, blockBits: o.blockBits });
    return {
      label,
      mod,
      supports: () => true,
      encode: (node, value, o) => node.encode(value, opts(o)),
      decode: (node, input, o) => node.decode(input, opts(o)),
      output: (enc, o) => enc.output(opts(o)),
      decoder: (input, o) => new mod.Decoder(input, opts(o)),
    };
  }
  if (typeof mod.Encoder.prototype.toUint8Array === 'function' && takesOptions(mod)) {
    const opts = (o: Opts) =>
      o.type === 'text'
        ? { charset: o.charset, blockBits: o.blockBits }
        : { range: o.charset, blockBits: o.blockBits };
    return {
      label,
      mod,
      supports: (o) => o.type === 'text' || o.charset === undefined || Array.isArray(o.charset),
      encode: (node, value, o) =>
        o.type === 'text' ? node.encodeString(value, opts(o)) : node.encode(value, opts(o)),
      decode: (node, input, o) =>
        typeof input === 'string' ? node.decodeString(input, opts(o)) : node.decode(input, opts(o)),
      output: (enc, o) => (o.type === 'text' ? enc.toString(opts(o)) : enc.toUint8Array(opts(o))),
      decoder: (input, o) => new mod.Decoder(input, opts(o)),
    };
  }
  throw new Error(
    `${label}: unsupported API shape; refs from e0700c1 on (options objects) are supported`
  );
};

/** Whether `toString` takes an options object rather than a bare charset. */
const takesOptions = (mod: Mod): boolean => {
  try {
    new mod.Encoder().toString({ charset: '01' });
    return true;
  } catch {
    return false;
  }
};

// ---------- randomness ----------

const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let rand = mulberry32(1);
const reseed = (seed: number, iteration: number, half: number): void => {
  rand = mulberry32(Math.imul(seed, 0x9e3779b1) ^ Math.imul(iteration + 1, 0x85ebca6b) ^ half);
};
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[randInt(0, xs.length - 1)];

// ---------- canonical rendering, for comparing outcomes ----------

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const show = (v: unknown): string => {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v !== 'object' || v === null) return String(v);
  if (v instanceof Date) return `Date(${v.getTime()})`;
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return `${view.constructor.name}(${hexOf(bytes)})`;
  }
  if (Array.isArray(v)) return `[${v.map(show).join(',')}]`;
  const entries = Object.keys(v).map((k) => `${JSON.stringify(k)}:${show((v as any)[k])}`);
  return `{${entries.join(',')}}`;
};

type Outcome = string;
const attempt = (f: () => unknown): Outcome => {
  try {
    return `ok ${show(f())}`;
  } catch (e) {
    const err = e as Error;
    return `throw ${err?.constructor?.name}/${err?.name}: ${err?.message}`;
  }
};

// ---------- schema cases ----------

/** A schema built the same way on any side, a value generator and its source form. */
interface Case {
  mk: (m: Mod) => Node;
  gen: () => unknown;
  src: string;
}

const randString = (max: number): string => {
  let s = '';
  const length = randInt(0, max);
  while (s.length < length) {
    const code = rand() < 0.5 ? randInt(32, 126) : randInt(0, 0x10ffff);
    if (code > 0xffff && s.length + 2 > length) continue;
    s += String.fromCodePoint(code);
  }
  return s;
};

const randBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, () => randInt(0, 255));

const FLOAT_SCRATCH = new Float64Array(1);
const FLOAT_BITS = new BigUint64Array(FLOAT_SCRATCH.buffer);
const nudge = (value: number): number => {
  FLOAT_SCRATCH[0] = value;
  FLOAT_BITS[0] += BigInt(randInt(-3, 3));
  return Number.isFinite(FLOAT_SCRATCH[0]) ? FLOAT_SCRATCH[0] : value;
};
const FLOAT_GENS = [
  () => (rand() * 2 - 1) * 10 ** randInt(-20, 20),
  () => randInt(1, 5000) / randInt(1, 5000),
  () => randInt(-99999, 99999) / 10 ** randInt(0, 6),
  () => randInt(1, 1000) * 2 ** randInt(-30, 30),
  () => Number(`${randInt(1, 9999)}e${rand() < 0.5 ? '-' : ''}${randInt(0, 300)}`),
  () => pick([0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, 2 ** -1022]),
  () => randInt(1, 2 ** 40) * 2 ** -1074,
] as const;
const randFloat = (): number => {
  const raw = pick(FLOAT_GENS)();
  const value = Number.isFinite(raw) ? raw : 1.5;
  return rand() < 0.3 ? nudge(value) : value;
};

/** An increasing integer CDF `a·d² + b·d` over offsets from `shift`, with its source. */
const randCdf = (shift: number): { fn: (v: number) => number; src: string } => {
  const a = randInt(0, 3);
  const b = randInt(1, 5);
  return {
    fn: (v) => a * (v - shift) ** 2 + b * (v - shift),
    src: `(v) => ${a} * (v - ${shift}) ** 2 + ${b} * (v - ${shift})`,
  };
};

const randWeights = (n: number, max: number): number[] =>
  Array.from({ length: n }, () => randInt(1, max));

const lit = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : show(v));

const STRING_CHARSETS = ['digit', 'hex', 'alpha', 'printable', 'urlSafe'] as const;

const scalarCase = (): Case => {
  switch (randInt(0, 10)) {
    case 0: {
      const lo = randInt(-1000, 0);
      const hi = lo + randInt(0, 300);
      const gen = () => (rand() < 0.2 ? pick([lo, hi]) : randInt(lo, hi));
      const base = `p.int().min(${lo}).max(${hi})`;
      switch (randInt(0, 2)) {
        case 0:
          return { mk: (m) => m.p.int().min(lo).max(hi), gen, src: base };
        case 1: {
          const w = randWeights(hi - lo + 1, 1000);
          return {
            mk: (m) => m.p.int().min(lo).max(hi).weights(w),
            gen,
            src: `${base}.weights(${show(w)})`,
          };
        }
        default: {
          const cdf = randCdf(lo);
          return {
            mk: (m) => m.p.int().min(lo).max(hi).cdf(cdf.fn),
            gen,
            src: `${base}.cdf(${cdf.src})`,
          };
        }
      }
    }
    case 1:
      return {
        mk: (m) => m.p.int(),
        gen: () => (rand() < 0.2 ? randInt(-(2 ** 53) + 1, 2 ** 53 - 1) : randInt(-1e6, 1e6)),
        src: 'p.int()',
      };
    case 2: {
      const bound = randInt(-1e6, 1e6);
      const offset = (): number => (rand() < 0.5 ? randInt(0, 1e4) : randInt(0, 2 ** 44));
      return rand() < 0.5
        ? {
            mk: (m) => m.p.int().min(bound),
            gen: () => bound + offset(),
            src: `p.int().min(${bound})`,
          }
        : {
            mk: (m) => m.p.int().max(bound),
            gen: () => bound - offset(),
            src: `p.int().max(${bound})`,
          };
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
      const grid = (k: number): number => (k * scaledStep) / scale;
      const kLo = randInt(-100000, 0);
      const kHi = kLo + randInt(0, 2000);
      switch (randInt(0, 3)) {
        case 0:
          return {
            mk: (m) => m.p.decimal(step),
            gen: () => grid(randInt(-100000, 100000)),
            src: `p.decimal(${step})`,
          };
        case 1:
          return {
            mk: (m) => m.p.decimal(step).min(grid(kLo)),
            gen: () => grid(kLo + randInt(0, 200000)),
            src: `p.decimal(${step}).min(${grid(kLo)})`,
          };
        case 2:
          return {
            mk: (m) => m.p.decimal(step).max(grid(kHi)),
            gen: () => grid(kHi - randInt(0, 200000)),
            src: `p.decimal(${step}).max(${grid(kHi)})`,
          };
        default: {
          const src = `p.decimal(${step}).min(${grid(kLo)}).max(${grid(kHi)})`;
          const gen = () => grid(randInt(kLo, kHi));
          if (rand() < 0.5) {
            return { mk: (m) => m.p.decimal(step).min(grid(kLo)).max(grid(kHi)), gen, src };
          }
          const cdf = randCdf(kLo);
          return {
            mk: (m) => m.p.decimal(step).min(grid(kLo)).max(grid(kHi)).cdf(cdf.fn),
            gen,
            src: `${src}.cdf(${cdf.src})`,
          };
        }
      }
    }
    case 4:
      return { mk: (m) => m.p.float(), gen: randFloat, src: 'p.float()' };
    case 5: {
      switch (randInt(0, 3)) {
        case 0:
          return { mk: (m) => m.p.string(), gen: () => randString(10), src: 'p.string()' };
        case 1: {
          const max = randInt(0, 12);
          const min = rand() < 0.5 ? randInt(0, max) : 0;
          return {
            mk: (m) => m.p.string().min(min).max(max),
            gen: () => 'x'.repeat(min) + randString(max - min),
            src: `p.string().min(${min}).max(${max})`,
          };
        }
        case 2: {
          if (rand() < 0.5) {
            return {
              mk: (m) => m.p.string().prose(),
              gen: () => (rand() < 0.5 ? randString(10) : pick(['the cat', 'Hello, world!', 'qu'])),
              src: 'p.string().prose()',
            };
          }
          const corpus = 'q' + randString(30);
          return {
            mk: (m) => m.p.string().prose(m.buildProseModel(corpus, { minCount: 1 })),
            gen: () => randString(10),
            src: `p.string().prose(buildProseModel(${JSON.stringify(corpus)}, { minCount: 1 }))`,
          };
        }
        default: {
          if (rand() < 0.5) {
            const name = pick(STRING_CHARSETS);
            return {
              mk: (m) => m.p.string().charset(m.CharSets[name]),
              gen: () => {
                const alphabet: string = (globalCharSets as any)[name];
                return Array.from({ length: randInt(0, 10) }, () =>
                  alphabet.charAt(randInt(0, alphabet.length - 1))
                ).join('');
              },
              src: `p.string().charset(CharSets.${name})`,
            };
          }
          const lo = randInt(0, 50000);
          const hi = lo + randInt(1, 5000);
          return {
            mk: (m) => m.p.string().charset([lo, hi]),
            gen: () =>
              Array.from({ length: randInt(0, 10) }, () =>
                String.fromCharCode(randInt(lo, hi))
              ).join(''),
            src: `p.string().charset([${lo}, ${hi}])`,
          };
        }
      }
    }
    case 6: {
      if (rand() < 0.5) return { mk: (m) => m.p.bool(), gen: () => rand() < 0.5, src: 'p.bool()' };
      const w = randWeights(2, 200);
      return {
        mk: (m) => m.p.bool().weights(w),
        gen: () => rand() < 0.5,
        src: `p.bool().weights(${show(w)})`,
      };
    }
    case 7: {
      const pool = ['aa', 'bb', 'cc', 0, 1, -17, 3.5, true, false, null];
      const members = [...pool].sort(() => rand() - 0.5).slice(0, randInt(1, 6));
      const src = `p.enum([${members.map(lit).join(', ')}])`;
      if (rand() < 0.5) return { mk: (m) => m.p.enum(members), gen: () => pick(members), src };
      const w = randWeights(members.length, 1000);
      return {
        mk: (m) => m.p.enum(members).weights(w),
        gen: () => pick(members),
        src: `${src}.weights(${show(w)})`,
      };
    }
    case 8: {
      const members: Case[] = [
        {
          mk: (m) => m.p.int().min(-50).max(50),
          gen: () => randInt(-50, 50),
          src: 'p.int().min(-50).max(50)',
        },
        { mk: (m) => m.p.string().max(6), gen: () => randString(6), src: 'p.string().max(6)' },
        { mk: (m) => m.p.bool(), gen: () => rand() < 0.5, src: 'p.bool()' },
        { mk: (m) => m.p.null(), gen: () => null, src: 'p.null()' },
        {
          mk: (m) => m.p.array(m.p.int().min(0).max(9)).max(3),
          gen: () => [randInt(0, 9)],
          src: 'p.array(p.int().min(0).max(9)).max(3)',
        },
        {
          mk: (m) => m.p.binary().max(4),
          gen: () => randBytes(randInt(0, 4)),
          src: 'p.binary().max(4)',
        },
      ];
      const options = members.sort(() => rand() - 0.5).slice(0, randInt(2, 3));
      const src = `p.union([${options.map((o) => o.src).join(', ')}])`;
      const gen = () => pick(options).gen();
      if (rand() < 0.5) return { mk: (m) => m.p.union(options.map((o) => o.mk(m))), gen, src };
      const w = randWeights(options.length, 1000);
      return {
        mk: (m) => m.p.union(options.map((o) => o.mk(m))).weights(w),
        gen,
        src: `${src}.weights(${show(w)})`,
      };
    }
    case 9: {
      const max = randInt(0, 40);
      if (rand() < 0.5) {
        const [name, size] = pick([
          ['Int16Array', 2],
          ['Float64Array', 8],
          ['BigUint64Array', 8],
        ] as const);
        const type = globalThis[name];
        return {
          mk: (m) => m.p.binary(type).max(max),
          gen: () => new type(randBytes(randInt(0, max) * size).buffer as ArrayBuffer),
          src: `p.binary(${name}).max(${max})`,
        };
      }
      switch (randInt(0, 2)) {
        case 0:
          return {
            mk: (m) => m.p.binary(),
            gen: () => randBytes(randInt(0, max)),
            src: 'p.binary()',
          };
        case 1:
          return {
            mk: (m) => m.p.binary().max(max),
            gen: () => randBytes(randInt(0, max)),
            src: `p.binary().max(${max})`,
          };
        default:
          return {
            mk: (m) => m.p.binary().length(max),
            gen: () => randBytes(max),
            src: `p.binary().length(${max})`,
          };
      }
    }
    default:
      return dateCase();
  }
};

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

// Values are bucket starts, floored through the working tree's node: only
// those decode back to themselves. A side that floors differently shows up
// as a decode divergence.
const dateCase = (): Case => {
  const unit = pick(Object.keys(DATE_MS) as (keyof typeof DATE_MS)[]);
  const step = randInt(1, 4);
  const ms = step * DATE_MS[unit];
  const base = `p.date().precision('${unit}', ${step})`;
  const floored = (node: Node, ts: number): Date => node.decode(node.encode(new Date(ts)));
  const withNode = (mk: (m: Mod) => Node, src: string, ts: () => number): Case => {
    let local: Node;
    return {
      mk,
      src,
      gen: () => floored((local ??= mk(globalMod)), ts()),
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
      return withNode(
        (m) => m.p.date().precision(unit, step).min(min),
        `${base}.min(${min})`,
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
      const cdf = randCdf(Math.floor(min / ms) - 1000);
      return withNode(
        (m) => m.p.date().precision(unit, step).min(min).max(max).cdf(cdf.fn),
        `${src}.cdf(${cdf.src})`,
        () => randInt(min, max)
      );
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
      return randFloat();
    case 4:
      return randString(6);
    case 5:
      return new Date(randInt(-8e15, 8e15));
    case 6:
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

const anyCase = (): Case => ({
  mk: (m) => m.p.any(),
  gen: () => anyValue(2, true),
  src: 'p.any()',
});

const trees = new WeakMap<Mod, Node>();
const treeOf = (m: Mod): Node => {
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
  mk: treeOf,
  gen: () => treeValue(randInt(0, 3)),
  src: 'Tree /* p.object({ v: p.int().min(0).max(9), kids: p.array(p.lazy(() => Tree)).max(3) }) */',
});

const arrayCase = (depth: number): Case => {
  const item = randomCase(depth - 1);
  const length = randInt(0, 4);
  const steps: { apply: (n: Node) => Node; src: string }[] = [];
  let free = false;
  let lo = 0;
  let hi = 0;
  const add = (src: string, apply: (n: Node) => Node) => steps.push({ src, apply });
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
      lo = randInt(0, length);
      add(`.min(${lo})`, (n) => n.min(lo));
      if (rand() < 0.5) {
        hi = length + randInt(0, 3);
        add(`.max(${hi})`, (n) => n.max(hi));
        free = true;
      }
      break;
  }
  if (free && rand() < 0.5) {
    if (rand() < 0.5) {
      const cdf = randCdf(0);
      add(`.cdf(${cdf.src})`, (n) => n.cdf(cdf.fn));
    } else {
      const w = randWeights(hi - lo + 1, 100);
      add(`.weights(${show(w)})`, (n) => n.weights(w));
    }
  }
  return {
    mk: (m) => steps.reduce((n, s) => s.apply(n), m.p.array(item.mk(m))),
    gen: () => Array.from({ length }, () => item.gen()),
    src: `p.array(${item.src})${steps.map((s) => s.src).join('')}`,
  };
};

const objectCase = (depth: number): Case => {
  const fields: { key: string; c: Case; mode: 'plain' | 'optional' | 'nullable'; w?: number[] }[] =
    [];
  for (let i = 0, n = randInt(0, 3); i < n; i++) {
    const r = rand();
    const mode = r < 0.2 ? 'optional' : r < 0.35 ? 'nullable' : 'plain';
    fields.push({
      key: `f${i}`,
      c: randomCase(depth - 1),
      mode,
      w: mode === 'optional' && rand() < 0.5 ? randWeights(2, 100) : undefined,
    });
  }
  const wrap = (m: Mod, f: (typeof fields)[number]): Node => {
    const inner = f.c.mk(m);
    if (f.mode === 'nullable') return m.p.nullable(inner);
    if (f.mode === 'plain') return inner;
    const opt = m.p.optional(inner);
    return f.w ? opt.weights(f.w) : opt;
  };
  const fieldSrc = (f: (typeof fields)[number]): string =>
    f.mode === 'plain' ? f.c.src : `p.${f.mode}(${f.c.src})${f.w ? `.weights(${show(f.w)})` : ''}`;
  return {
    mk: (m) => m.p.object(Object.fromEntries(fields.map((f) => [f.key, wrap(m, f)]))),
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

const taggedCase = (depth: number): Case => {
  const members: [string, Case][] = [];
  for (let i = 0, n = randInt(1, 3); i < n; i++) members.push([`m${i}`, objectCase(depth - 1)]);
  const w = rand() < 0.5 ? randWeights(members.length, 1000) : undefined;
  const mk = (m: Mod): Node => {
    const node = m.p.tagged('t', Object.fromEntries(members.map(([tag, c]) => [tag, c.mk(m)])));
    return w ? node.weights(w) : node;
  };
  return {
    mk,
    gen: () => {
      const [tag, c] = pick(members);
      return { t: tag, ...(c.gen() as object) };
    },
    src:
      `p.tagged('t', { ${members.map(([tag, c]) => `${tag}: ${c.src}`).join(', ')} })` +
      (w ? `.weights(${show(w)})` : ''),
  };
};

const versionedCase = (inner: Case): Case => {
  if (rand() < 0.5) {
    return {
      mk: (m) => m.p.versioned(inner.mk(m)),
      gen: inner.gen,
      src: `p.versioned(${inner.src})`,
    };
  }
  const first = scalarCase();
  return {
    mk: (m) => m.p.versioned(first.mk(m), [inner.mk(m), () => undefined]),
    gen: inner.gen,
    src: `p.versioned(${first.src}, [${inner.src}, () => undefined])`,
  };
};

const randomCase = (depth: number): Case => {
  const chosen =
    depth > 0 && rand() < 0.4
      ? pick([arrayCase, objectCase, taggedCase, anyCase, lazyCase] as const)(depth)
      : rand() < 0.9
        ? scalarCase()
        : anyCase();
  return rand() < 0.1 ? versionedCase(chosen) : chosen;
};

// ---------- layouts and corruptions ----------

const TEXT_CHARSETS: (Charset | undefined)[] = [
  undefined,
  'urlSafe',
  'digit',
  'hex',
  'printable',
  [0, 0xd7ff],
  [0x2800, 0x28ff],
];
const BYTE_CHARSETS: (Charset | undefined)[] = [
  undefined,
  undefined,
  [0, 127],
  [32, 126],
  'printable',
];
const BLOCK_BITS = [undefined, undefined, undefined, 128, 256, 1000];

const resolveCharset = (c: Charset | undefined): Charset | undefined =>
  typeof c === 'string' ? (globalCharSets as any)[c] : c;

const randOpts = (): Opts => {
  const type = rand() < 0.5 ? 'binary' : 'text';
  const charset = resolveCharset(pick(type === 'text' ? TEXT_CHARSETS : BYTE_CHARSETS));
  return { type, charset, blockBits: pick(BLOCK_BITS) };
};

/** The codes a layout spells messages in. */
const codesOf = (o: Opts): { has: (c: number) => boolean; random: () => number } => {
  const c = o.charset ?? (o.type === 'text' ? (globalCharSets as any).base64 : [0, 255]);
  if (typeof c === 'string') {
    return {
      has: (x) => c.includes(String.fromCharCode(x)),
      random: () => c.charCodeAt(randInt(0, c.length - 1)),
    };
  }
  return { has: (x) => x >= c[0] && x <= c[1], random: () => randInt(c[0], c[1]) };
};

const corruptions = (
  enc: Uint8Array | string,
  o: Opts
): { what: string; input: Uint8Array | string }[] => {
  const codes = codesOf(o);
  const arr = typeof enc === 'string' ? [...enc].map((ch) => ch.charCodeAt(0)) : [...enc];
  const pack = (xs: number[]) =>
    typeof enc === 'string' ? String.fromCharCode(...xs) : Uint8Array.from(xs);
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

const showInput = (input: Uint8Array | string): string =>
  typeof input === 'string' ? JSON.stringify(input) : `hex ${hexOf(input)}`;

// ---------- raw packer sequences ----------

type Sym =
  | { k: 'u'; v: number; r: number }
  | { k: 't'; v: number }
  | { k: 'w'; cum: number; freq: number; total: number; index: number; count: number };
type Bucket = readonly [number, number, number];

const MAX = Number.MAX_SAFE_INTEGER;
const TOTALS = [
  2,
  3,
  4,
  5,
  7,
  8,
  9,
  16,
  27,
  31,
  32,
  64,
  81,
  100,
  107,
  243,
  255,
  256,
  257,
  321,
  1000,
  65536,
  2 ** 20,
  2 ** 31,
  2 ** 40,
  2 ** 52,
  2 ** 53 - 1,
  2 ** 53 - 2,
  3002399751580331,
  84179432287299,
  28059810762433,
];

/** Decode-side lookups for a weighted symbol: unit buckets around its own. */
const lookupsOf = (w: Extract<Sym, { k: 'w' }>) => {
  const { cum, freq, total } = w;
  const members = Math.min(w.count, total);
  if (members >= total) {
    const locate = (r: number): Bucket =>
      r < cum ? [0, 0, cum] : r < cum + freq ? [1, cum, freq] : [2, cum + freq, total - cum - freq];
    return { locate, at: (i: number): Bucket => [i, i, 1] };
  }
  const index = w.index;
  const after = members - index - 1;
  const afterStart = cum + freq;
  const firstWidth = total - afterStart - (after - 1);
  const at = (i: number): Bucket => {
    if (i < index) return i < index - 1 ? [i, i, 1] : [i, index - 1, cum - (index - 1)];
    if (i === index) return [i, cum, freq];
    if (i === index + 1) return [i, afterStart, firstWidth];
    return [i, afterStart + firstWidth + (i - index - 2), 1];
  };
  const locate = (r: number): Bucket => {
    if (r < cum) return at(Math.min(r, index - 1));
    if (r < cum + freq) return at(index);
    const k = r - afterStart;
    return k < firstWidth ? at(index + 1) : at(index + 2 + (k - firstWidth));
  };
  return { locate, at };
};

const genUniform = (): Sym => {
  const r = rand() < 0.5 ? pick(TOTALS) : randInt(2, rand() < 0.5 ? 1000 : MAX);
  const v = rand() < 0.3 ? r - 1 : rand() < 0.3 ? 0 : randInt(0, r - 1);
  return { k: 'u', v, r };
};

const genWeighted = (total?: number): Sym => {
  total ??= rand() < 0.5 ? pick(TOTALS) : randInt(1, rand() < 0.5 ? 1000 : MAX);
  const fc = rand();
  const freq =
    fc < 0.2
      ? 1
      : fc < 0.4
        ? Math.max(1, total - 1)
        : fc < 0.5
          ? total
          : fc < 0.6
            ? Math.max(1, Math.floor(total / 2))
            : randInt(1, total);
  const cum = rand() < 0.3 ? 0 : rand() < 0.3 ? total - freq : randInt(0, total - freq);
  let count = total;
  let index = cum;
  if (rand() < 0.5) {
    index = randInt(0, Math.min(cum, 50));
    count = index + 1 + randInt(0, Math.min(total - cum - freq, 50));
  }
  return { k: 'w', cum, freq, total, index, count };
};

const genTerm = (): Sym => ({
  k: 't',
  v: rand() < 0.6 ? randInt(0, 100) : rand() < 0.5 ? randInt(0, 2 ** 32) : randInt(0, MAX),
});

/** Exact block-bound tracker, used only to aim symbol totals at ties. */
class Oracle {
  V = 1n;
  U = 1n;
  den = 1n;
  constructor(readonly cap: bigint) {}
  reset(): void {
    this.V = 1n;
    this.U = 1n;
    this.den = 1n;
  }
  fits(total: number): boolean {
    return this.V + this.U * BigInt(total - 1) <= this.cap * this.den;
  }
  update(total: number, freq: number): void {
    const t = BigInt(total);
    const f = BigInt(freq);
    if (f === 1n) this.V = this.V + this.U * (t - 1n);
    else {
      this.V = (this.V + this.U * (t - f)) * f;
      this.den *= f;
    }
    this.U *= t;
  }
  totalFor(target: bigint, exact: boolean): number | undefined {
    const num = target * this.den - this.V;
    if (num < 0n || (exact && num % this.U !== 0n)) return undefined;
    const t = num / this.U + 1n;
    if (t < 1n) return undefined;
    return Number(t > BigInt(MAX) ? BigInt(MAX) : t);
  }
}

const genSequence = (base: number, cap: bigint, digits: number): Sym[] => {
  const n = randInt(1, pick([5, 30, 200, 1500]));
  const syms: Sym[] = [];
  const oracle = new Oracle(cap);
  const style = rand();
  const half = (): Sym =>
    rand() < 0.5
      ? { k: 'w', cum: 0, freq: 2, total: 4, index: 0, count: 4 }
      : { k: 'u', v: randInt(0, 1), r: 2 };
  for (let i = 0; i < n; i++) {
    let s: Sym;
    if (style < 0.25 && rand() < 0.6) {
      const target = rand() < 0.5 ? cap : BigInt(base) ** BigInt(randInt(0, digits));
      const which = rand();
      let t = oracle.totalFor(target, which < 0.4);
      if (t !== undefined && which >= 0.7 && t < MAX) t += 1;
      s =
        t === undefined || t < 2
          ? half()
          : rand() < 0.5
            ? { k: 'u', v: randInt(0, t - 1), r: t }
            : genWeighted(t);
    } else if (style < 0.5) {
      s = pick([genUniform, () => genWeighted(), genTerm])();
    } else if (style < 0.75) {
      s = rand() < 0.8 ? half() : genWeighted();
    } else {
      s = rand() < 0.85 ? genUniform() : rand() < 0.5 ? genWeighted() : genTerm();
    }
    syms.push(s);
    if (s.k !== 't') {
      const total = s.k === 'u' ? s.r : s.total;
      if (!oracle.fits(total)) oracle.reset();
      oracle.update(total, s.k === 'u' ? 1 : s.freq);
    }
  }
  return syms;
};

const plainWeighted = (s: Extract<Sym, { k: 'w' }>): boolean =>
  s.count === s.total && s.index === s.cum;

/** One sequence written through a side's packer into a message. */
const packEncodeRaw = (sd: Side, syms: Sym[], o: Opts): Uint8Array | string => {
  const enc = new sd.mod.Encoder();
  for (const s of syms) {
    if (s.k === 'u') enc.compose(s.v, s.r);
    else if (s.k === 't') enc.composeTerm(s.v);
    else if (plainWeighted(s)) enc.composeWeighted(s.cum, s.freq, s.total);
    else enc.composeWeighted(s.cum, s.freq, s.total, { index: s.index, count: s.count });
  }
  return sd.output(enc, o);
};

const packEncode = (sd: Side, syms: Sym[], o: Opts): Outcome =>
  attempt(() => packEncodeRaw(sd, syms, o));

const packDecode = (sd: Side, input: Uint8Array | string, syms: Sym[], o: Opts): Outcome[] => {
  let dec: any;
  const opened = attempt(() => (dec = sd.decoder(input, o)));
  if (opened.startsWith('throw')) return [opened];
  const out: Outcome[] = [];
  for (const s of syms) {
    const r = attempt(() => {
      if (s.k === 'u') return dec.parse(s.r);
      if (s.k === 't') return dec.parseTerm();
      const { locate, at } = lookupsOf(s);
      return plainWeighted(s)
        ? dec.parseWeighted(s.total, locate)
        : dec.parseWeighted(s.total, locate, { count: s.count, at });
    });
    out.push(r);
    if (r.startsWith('throw')) return out;
  }
  out.push(attempt(() => dec.finalize()));
  return out;
};

/** Greedy shrink: drop chunks of symbols while the predicate still holds. */
const shrink = (syms: Sym[], diverges: (s: Sym[]) => boolean): Sym[] => {
  let cur = syms;
  for (let changed = true; changed; ) {
    changed = false;
    for (let chunk = Math.max(1, cur.length >> 1); chunk >= 1; chunk >>= 1) {
      for (let i = 0; i + chunk <= cur.length; ) {
        const cand = [...cur.slice(0, i), ...cur.slice(i + chunk)];
        if (cand.length > 0 && diverges(cand)) {
          cur = cand;
          changed = true;
        } else i += chunk;
      }
    }
  }
  return cur;
};

const BASES = [2, 3, 4, 5, 7, 8, 10, 16, 36, 64, 100, 127, 128, 255, 256, 1000, 4096, 55295, 55296];

// ---------- driver ----------

let globalMod: Mod;
let globalCharSets: Record<string, string>;

interface Divergence {
  half: 'schema' | 'packer';
  iteration: number;
  kind: string;
  detail: string[];
}

/** What differs between two outcomes of one stage: output, error class, or message wording only. */
const classify = (stage: string, a: Outcome, b: Outcome): string => {
  const thrown = (x: Outcome) => (x.startsWith('throw') ? x.slice(6, x.indexOf(':')) : undefined);
  const [ea, eb] = [thrown(a), thrown(b)];
  if (ea === undefined && eb === undefined) return `${stage}: different result`;
  if (ea === undefined || eb === undefined) return `${stage}: one side throws`;
  return ea === eb ? `${stage}: error message only` : `${stage}: error class`;
};

const sh = (cmd: string, args: string[], cwd: string): string =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const bundle = async (root: string, outfile: string): Promise<Mod> => {
  await build({
    entryPoints: [join(root, 'src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'error',
  });
  return import(pathToFileURL(outfile).href);
};

const main = async (): Promise<number> => {
  const [ref, seedArg, itersArg] = process.argv.slice(2);
  if (!ref) {
    console.error('usage: npm run fuzz:diff -- <ref> [seed] [iterations]');
    return 2;
  }
  const seed = Number(seedArg ?? 1);
  const iterations = Number(itersArg ?? 1000);
  const root = sh('git', ['rev-parse', '--show-toplevel'], resolve(__dirname));
  const commit = sh('git', ['rev-parse', '--verify', `${ref}^{commit}`], root);
  const tmp = mkdtempSync(join(tmpdir(), 'polynar-diff-'));
  const tree = join(tmp, 'ref');
  try {
    sh('git', ['worktree', 'add', '--detach', tree, commit], root);
    const cur = side('working tree', await bundle(root, join(tmp, 'current.mjs')));
    const old = side(`${ref} (${commit.slice(0, 7)})`, await bundle(tree, join(tmp, 'ref.mjs')));
    globalMod = cur.mod;
    globalCharSets = cur.mod.CharSets;

    const divergences: Divergence[] = [];
    let skipped = 0;
    let decodes = 0;

    for (let it = 0; it < iterations; it++) {
      reseed(seed, it, 0);
      const c = randomCase(2);
      const o = randOpts();
      let value: unknown;
      try {
        // One value in twenty belongs to a different schema, to compare errors.
        value = rand() < 0.05 ? randomCase(1).gen() : c.gen();
      } catch {
        continue;
      }
      if (!cur.supports(o) || !old.supports(o)) {
        skipped++;
        continue;
      }
      const nodes = [cur, old].map((sd) => {
        try {
          return { node: c.mk(sd.mod) };
        } catch (e) {
          return {
            error: attempt(() => {
              throw e;
            }),
          };
        }
      });
      const header = [`schema  ${c.src}`, `value   ${show(value)}`, `options ${JSON.stringify(o)}`];
      if (nodes[0].error || nodes[1].error) {
        if (nodes[0].error !== nodes[1].error) {
          divergences.push({
            half: 'schema',
            iteration: it,
            kind: classify('build', nodes[0].error ?? 'ok', nodes[1].error ?? 'ok'),
            detail: [
              ...header,
              `build   ${cur.label}: ${nodes[0].error ?? 'ok'}`,
              `build   ${old.label}: ${nodes[1].error ?? 'ok'}`,
            ],
          });
        }
        continue;
      }
      let encoded: Uint8Array | string | undefined;
      const encodes = [cur, old].map((sd, i) =>
        attempt(() => {
          const out = sd.encode(nodes[i].node, value, o);
          if (i === 0) encoded = out;
          return out;
        })
      );
      if (encodes[0] !== encodes[1]) {
        divergences.push({
          half: 'schema',
          iteration: it,
          kind: classify('encode', encodes[0], encodes[1]),
          detail: [
            ...header,
            `encode  ${cur.label}: ${encodes[0]}`,
            `encode  ${old.label}: ${encodes[1]}`,
          ],
        });
        continue;
      }
      if (encoded === undefined) continue;
      reseed(seed, it, 1);
      for (const { what, input } of [
        { what: 'as encoded', input: encoded },
        ...corruptions(encoded, o),
      ]) {
        decodes++;
        const results = [cur, old].map((sd, i) =>
          attempt(() => sd.decode(nodes[i].node, input, o))
        );
        if (results[0] !== results[1]) {
          divergences.push({
            half: 'schema',
            iteration: it,
            kind: classify(
              what === 'as encoded' ? 'decode' : 'corrupt decode',
              results[0],
              results[1]
            ),
            detail: [
              ...header,
              `input   ${what}: ${showInput(input)}`,
              `decode  ${cur.label}: ${results[0]}`,
              `decode  ${old.label}: ${results[1]}`,
            ],
          });
          break;
        }
      }
    }

    for (let it = 0; it < iterations; it++) {
      reseed(seed, it, 2);
      const base = pick(BASES);
      const blockBits = pick([undefined, undefined, 128, 512]);
      const bits = BigInt(blockBits ?? 2048);
      let digits = 1;
      let cap = BigInt(base);
      while (cap * BigInt(base) <= 1n << bits) {
        cap *= BigInt(base);
        digits++;
      }
      const type = base <= 256 && rand() < 0.5 ? 'binary' : 'text';
      const o: Opts = {
        type,
        charset: type === 'binary' && base === 256 && rand() < 0.5 ? undefined : [0, base - 1],
        blockBits,
      };
      const syms = genSequence(base, cap, digits);
      const encodes = [cur, old].map((sd) => packEncode(sd, syms, o));
      const encDiverges = (s: Sym[]) => packEncode(cur, s, o) !== packEncode(old, s, o);
      if (encodes[0] !== encodes[1]) {
        divergences.push({
          half: 'packer',
          iteration: it,
          kind: classify('packer encode', encodes[0], encodes[1]),
          detail: [
            `options ${JSON.stringify(o)}`,
            `symbols ${JSON.stringify(shrink(syms, encDiverges))} (shrunk from ${syms.length})`,
            `encode  ${cur.label}: ${packEncode(cur, syms, o).slice(0, 200)}`,
            `encode  ${old.label}: ${packEncode(old, syms, o).slice(0, 200)}`,
          ],
        });
        continue;
      }
      if (encodes[0].startsWith('throw')) continue;
      const encoded = packEncodeRaw(cur, syms, o);
      reseed(seed, it, 3);
      for (const { what, input } of [
        { what: 'as encoded', input: encoded },
        ...corruptions(encoded, o),
      ]) {
        decodes++;
        const a = packDecode(cur, input, syms, o);
        const b = packDecode(old, input, syms, o);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          const step = a.findIndex((x, i) => x !== b[i]);
          divergences.push({
            half: 'packer',
            iteration: it,
            kind: classify(
              what === 'as encoded' ? 'packer decode' : 'packer corrupt decode',
              a[step],
              b[step]
            ),
            detail: [
              `options ${JSON.stringify(o)}`,
              `symbols ${JSON.stringify(syms.length > 40 ? syms.slice(0, step + 1) : syms)}${syms.length > 40 ? ` (first ${step + 1} of ${syms.length})` : ''}`,
              `input   ${what}: ${showInput(input).slice(0, 400)}`,
              `step    ${step}`,
              `decode  ${cur.label}: ${a[step]}`,
              `decode  ${old.label}: ${b[step]}`,
            ],
          });
          break;
        }
      }
    }

    console.log(
      `polynar diff fuzz: working tree vs ${old.label}, seed ${seed}, ${iterations} iterations per half`
    );
    console.log(
      `  ${decodes} decodes compared, ${skipped} schema cases skipped (layout unsupported by one side)`
    );
    console.log(`  ${divergences.length} divergence(s)`);
    const kinds = new Map<string, number>();
    for (const d of divergences) kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1);
    for (const [kind, n] of [...kinds].sort((x, y) => y[1] - x[1]))
      console.log(`    ${n}\t${kind}`);
    // The first of each kind, then the earliest of the rest, up to ten.
    const firsts = [...kinds.keys()].map((k) => divergences.find((d) => d.kind === k)!);
    const shown = [...new Set([...firsts, ...divergences])].slice(0, 10);
    for (const d of shown) {
      console.log(`\n[${d.half}] ${d.kind} — seed ${seed} iteration ${d.iteration}`);
      for (const line of d.detail) console.log(`  ${line}`);
    }
    if (divergences.length > shown.length)
      console.log(`\n… ${divergences.length - shown.length} more`);
    return divergences.length > 0 ? 1 : 0;
  } finally {
    try {
      sh('git', ['worktree', 'remove', '--force', tree], root);
    } catch {
      // The worktree may not exist when its creation failed.
    }
    rmSync(tmp, { recursive: true, force: true });
  }
};

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  }
);
