/**
 * Differential fuzz: the working tree against the latest published release,
 * or against any git ref. See USAGE below.
 *
 * Without a ref the other side is the `polynar-published` devDependency, an
 * alias of `polynar@latest`. With a ref, that commit is checked out into a
 * temporary detached worktree and its `src/index.ts` is imported directly;
 * the worktree is removed afterwards. The two copies load as separate module
 * instances, so neither sees the other's module state.
 *
 * Both sides are fed the same random cases: schemas with values (priors,
 * prose, charsets, plus corrupted inputs: truncated, padded, flipped,
 * out-of-charset) and raw packer symbol sequences aimed at the streaming
 * coder's edges: totals at its windows' renormalisation thresholds, at the
 * switch to a BigInt state and up to 2^53, wide buckets folded through the
 * spread map at the message's end, final states on a digit boundary, empty
 * and single-symbol messages, and trailing zeros read past the input against
 * the decode limit. Encode output, decode results and thrown errors (class,
 * name and message) must match. Any
 * divergence prints with its seed, iteration and a readable schema, and the
 * exit code is 1.
 *
 * A side whose API predates the working tree's is reported and nothing is
 * compared (exit code 0). Bad arguments print the usage and exit with 2. Under
 * GitHub Actions a skip raises a notice annotation, and a divergence raises a
 * warning annotation and writes the report to the job summary.
 */

import { execFileSync } from 'child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parseArgs } from 'util';
import * as current from '../src/index';
import { ransWindow } from '../src/packer/constants';
import * as published from 'polynar-published';
import { version as publishedVersion } from 'polynar-published/package.json';
import { mulberry32 } from '../src/__tests__/support';
import {
  corruptions,
  pick,
  rand,
  randInt,
  randOpts,
  randomCase,
  useRng,
} from '../src/__tests__/random-schemas';
import type { Opts } from '../src/__tests__/random-schemas';

type Mod = any;
type Node = any;

/** One side of the comparison: a module and its codec calls. */
interface Side {
  label: string;
  mod: Mod;
  encode(node: Node, value: unknown, o: Opts): Uint8Array | string;
  decode(node: Node, input: Uint8Array | string, o: Opts): unknown;
  output(enc: any, o: Opts): Uint8Array | string;
  decoder(input: Uint8Array | string, o: Opts, limit?: number): any;
}

const side = (label: string, mod: Mod): Side => {
  const opts = (o: Opts) => ({ type: o.type, charset: o.charset });
  return {
    label,
    mod,
    encode: (node, value, o) => node.encode(value, opts(o)),
    decode: (node, input, o) => node.decode(input, opts(o)),
    output: (enc, o) => enc.output(opts(o)),
    decoder: (input, o, limit) =>
      new mod.Decoder(input, limit === undefined ? opts(o) : { ...opts(o), limit }),
  };
};

/**
 * The codec API both sides need for any comparison at all. Factories added
 * since don't count here: a schema that uses one is skipped on its own.
 */
const missingApi = (mod: Mod): string[] => {
  const missing = ['p', 'Encoder', 'Decoder'].filter((k) => !(k in mod));
  if (typeof mod.Encoder?.prototype?.output !== 'function') missing.push('Encoder#output');
  return missing;
};

/** Whether every `p.*` factory a schema's source names exists in a copy of the library. */
const hasFactories = (mod: Mod, src: string): boolean =>
  [...src.matchAll(/\bp\.(\w+)\(/g)].every(([, name]) => typeof mod.p[name] === 'function');

// ---------- randomness ----------

const reseed = (seed: number, iteration: number, half: number): void => {
  useRng(mulberry32(Math.imul(seed, 0x9e3779b1) ^ Math.imul(iteration + 1, 0x85ebca6b) ^ half));
};

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
  if (v instanceof Map) return `Map{${[...v].map(([k, x]) => `${show(k)}=>${show(x)}`).join(',')}}`;
  if (v instanceof Set) return `Set{${[...v].map(show).join(',')}}`;
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

const showInput = (input: Uint8Array | string): string =>
  typeof input === 'string' ? JSON.stringify(input) : `hex ${hexOf(input)}`;

// ---------- raw packer sequences ----------

type Sym =
  | { k: 'u'; v: number; r: number }
  | { k: 't'; v: number }
  | { k: 'w'; cum: number; freq: number; total: number };

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

/** Decode-side lookup for a weighted symbol: the buckets below, at and above its own. */
const locateOf =
  ({ cum, freq, total }: Extract<Sym, { k: 'w' }>) =>
  (r: number): readonly [number, number, number] =>
    r < cum ? [0, 0, cum] : r < cum + freq ? [1, cum, freq] : [2, cum + freq, total - cum - freq];

const clampTotal = (t: bigint): number => Number(t < 2n ? 2n : t > BigInt(MAX) ? BigInt(MAX) : t);

/** A value of `r` states, at either end more often than inside. */
const valueIn = (r: number): number =>
  rand() < 0.3 ? r - 1 : rand() < 0.3 ? 0 : randInt(0, r - 1);

const genUniform = (r?: number): Sym => {
  r ??= rand() < 0.5 ? pick(TOTALS) : randInt(2, rand() < 0.5 ? 1000 : MAX);
  return { k: 'u', v: valueIn(r), r };
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
  return { k: 'w', cum, freq, total };
};

const genTerm = (): Sym => ({
  k: 't',
  v: rand() < 0.6 ? randInt(0, 100) : rand() < 0.5 ? randInt(0, 2 ** 32) : randInt(0, MAX),
});

const genAny = (): Sym => pick([() => genUniform(), () => genWeighted(), genTerm])();

/**
 * The windows the coder opens for a sequence's symbols in base `size`,
 * mirrored in BigInt to aim totals at their edges: k = max(1, ⌊L/T⌋, ⌈B/T⌉),
 * B = k·f of the last coded symbol. `limit` is the largest A = k·T for which
 * size·A is a safe integer; past it the state is a BigInt.
 */
class Windows {
  readonly L: bigint;
  readonly limit: bigint;
  B = 0n;
  last = 2n;

  constructor(readonly size: number) {
    this.L = BigInt(ransWindow(size));
    this.limit = BigInt(Math.floor(MAX / size));
  }

  k(total: number): bigint {
    const t = BigInt(total);
    const up = (this.B + t - 1n) / t;
    const kL = this.L / t;
    const k = up > kL ? up : kL;
    return k > 1n ? k : 1n;
  }

  /**
   * Steps past a symbol. A bucket holding every state is never coded and
   * leaves B as it is. A term is several slots, of which only the last
   * total is known here, so after one B is approximate.
   */
  step(s: Sym): void {
    const [total, freq] = s.k === 'u' ? [s.r, 1] : s.k === 'w' ? [s.total, s.freq] : [4, 1];
    if (freq < total) this.B = this.k(total) * BigInt(freq);
    this.last = BigInt(total);
  }

  /**
   * A total within a few states of an edge: where ⌊L/T⌋ steps (L/j), where
   * T times the last total passes L, where size·A passes 2^53 (`limit`/j),
   * where ⌈B/T⌉ takes the window over (B/j), around 2^52, where k = 2 can
   * carry B past 2^53, and at the top of the safe range.
   */
  edgeTotal(): number {
    const { L, limit, B } = this;
    const j = BigInt(pick([1, 2, 3, 7, this.size]));
    const anchors = [L / j, L / this.last, limit / j, 1n << 52n, BigInt(MAX)];
    if (B > 0n) anchors.push(B / j, (B + j - 1n) / j);
    return clampTotal(pick(anchors) + BigInt(randInt(-2, 2)));
  }
}

/**
 * A wide weighted symbol for the message's end, where the encoder's state is
 * still below `freq` and folds through the spread map: totals at power-of-two
 * edges, where the bit-reversed visiting order gains a bit, and up to 2^53.
 */
const spreadSym = (w: Windows): Sym => {
  const total =
    rand() < 0.2
      ? w.edgeTotal()
      : clampTotal((1n << BigInt(randInt(1, 53))) + BigInt(randInt(-1, 1)));
  const freq = Math.max(
    1,
    pick([total - 1, total - 2, Math.ceil(total / 2), randInt(1, total - 1)])
  );
  const cum = rand() < 0.3 ? 0 : rand() < 0.5 ? total - freq : randInt(0, total - freq);
  return { k: 'w', cum, freq, total };
};

/**
 * A one-symbol message whose final state is size^j − 1, size^j or
 * size^j + 1, size^j a safe integer: the output ends on a digit boundary or
 * one digit past it.
 */
const boundarySym = (size: number): Sym => {
  const powers = [1];
  while (powers[powers.length - 1] * size < MAX) powers.push(powers[powers.length - 1] * size);
  const v = Math.min(MAX - 1, Math.max(0, pick(powers) + randInt(-1, 1)));
  return { k: 'u', v, r: rand() < 0.5 ? v + 1 : randInt(v + 1, MAX) };
};

/**
 * A symbol that folds state 0 onto itself: a message ending in these emits
 * nothing for them, and the decoder reads them past its input, against its
 * limit.
 */
const zeroSym = (): Sym => {
  const total = pick(TOTALS);
  return pick<Sym>([
    { k: 'u', v: 0, r: total },
    { k: 't', v: 0 },
    { k: 'w', cum: 0, freq: randInt(1, total - 1), total },
  ]);
};

/** A sequence aimed at one of the coder's edges, and the decode limit to read it under, if any. */
const genSequence = (size: number): { syms: Sym[]; limit?: number } => {
  const w = new Windows(size);
  const syms: Sym[] = [];
  const push = (s: Sym): void => {
    syms.push(s);
    w.step(s);
  };
  const body = (n: number): void => {
    for (let i = 0; i < n; i++) {
      push(rand() < 0.85 ? genUniform() : rand() < 0.5 ? genWeighted() : genTerm());
    }
  };
  // One message in ten reads under a tight limit, whatever it holds.
  let limit = rand() < 0.1 ? pick([0, 1, 2, Infinity]) : undefined;
  const style = rand();
  if (style < 0.3) {
    // Renormalisation: totals at the windows' edges, between random symbols.
    const n = randInt(1, pick([5, 30, 200]));
    for (let i = 0; i < n; i++) {
      if (rand() < 0.6) {
        const t = w.edgeTotal();
        push(rand() < 0.5 ? genUniform(t) : genWeighted(t));
      } else push(genAny());
    }
  } else if (style < 0.45) {
    body(randInt(0, 10));
    for (let i = randInt(1, 8); i > 0; i--) push(spreadSym(w));
  } else if (style < 0.55) {
    push(boundarySym(size));
  } else if (style < 0.6) {
    if (rand() < 0.5) push(genAny());
  } else if (style < 0.75) {
    body(randInt(0, 10));
    const m = pick([1, 2, 3, randInt(4, 100), 1000]);
    for (let i = 0; i < m; i++) push(zeroSym());
    limit = pick([0, Math.max(0, m - 1), m, m + 1, Infinity]);
  } else {
    body(randInt(1, pick([5, 30, 200, 1500])));
  }
  return { syms, limit };
};

/** One sequence written through a side's packer into a message. */
const packEncodeRaw = (sd: Side, syms: Sym[], o: Opts): Uint8Array | string => {
  const enc = new sd.mod.Encoder();
  for (const s of syms) {
    if (s.k === 'u') enc.compose(s.v, s.r);
    else if (s.k === 't') enc.composeTerm(s.v);
    else enc.composeWeighted(s.cum, s.freq, s.total);
  }
  return sd.output(enc, o);
};

const packEncode = (sd: Side, syms: Sym[], o: Opts): Outcome =>
  attempt(() => packEncodeRaw(sd, syms, o));

const packDecode = (
  sd: Side,
  input: Uint8Array | string,
  syms: Sym[],
  o: Opts,
  limit: number | undefined
): Outcome[] => {
  let dec: any;
  const opened = attempt(() => (dec = sd.decoder(input, o, limit)));
  if (opened.startsWith('throw')) return [opened];
  const out: Outcome[] = [];
  for (const s of syms) {
    const r = attempt(() => {
      if (s.k === 'u') return dec.parse(s.r);
      if (s.k === 't') return dec.parseTerm();
      return dec.parseWeighted(s.total, locateOf(s));
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
        if (diverges(cand)) {
          cur = cand;
          changed = true;
        } else i += chunk;
      }
    }
  }
  return cur;
};

/**
 * Output bases, as code ranges from 0: powers of two and not, each side of
 * 256 and of a window step, up to 55296, the widest range below the
 * surrogates and among the bases with the narrowest window, 2^36.
 */
const BASES = [2, 3, 4, 5, 7, 8, 10, 16, 36, 64, 100, 127, 128, 255, 256, 1000, 4096, 55295, 55296];

// ---------- driver ----------

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

/** A non-negative integer argument, or undefined when it is anything else. */
const countArg = (arg: string | undefined, fallback: number): number | undefined => {
  if (arg === undefined) return fallback;
  return /^\d+$/.test(arg) && Number.isSafeInteger(Number(arg)) ? Number(arg) : undefined;
};

const USAGE = `usage: npm run fuzz:diff -- [<ref>] [--seed <n>] [--runs <n>]

Compares the working tree's wire format against another version of polynar.

  <ref>        a git ref (HEAD, a hash, a branch, a tag) to compare against;
               without one, the latest published release
  --seed <n>   seed for the random cases (default: random, printed in the report)
  --runs <n>   iterations per half, schemas and packer (default: 1000)
  --help       print this text`;

const ROOT = resolve(__dirname, '..');

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** The other side reported as skipped when its API predates the working tree's; exit code 0. */
const skipped = (label: string, missing: string[]): number => {
  const skip = `${label} predates the working tree's API, nothing compared`;
  console.log(`polynar diff fuzz: ${skip} (missing ${missing.join(', ')})`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Wire check skipped::${skip}`);
  return 0;
};

/** The working tree against `old` on the side's module, or the skip when its API falls short. */
const run = (old: Side, seed: number, iterations: number): number => {
  const missing = missingApi(old.mod);
  if (missing.length > 0) return skipped(old.label, missing);
  return compare(old, seed, iterations);
};

/** The working tree against a git ref, checked out into a temporary worktree for the run. */
const runRef = async (ref: string, seed: number, iterations: number): Promise<number> => {
  let hash: string;
  try {
    hash = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    console.error(`polynar diff fuzz: unknown git ref ${ref}`);
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), 'polynar-diff-'));
  try {
    git('worktree', 'add', '--detach', '--quiet', dir, hash);
    const mod: Mod = await import(join(dir, 'src', 'index.ts'));
    return run(side(`${ref} (${hash.slice(0, 7)})`, mod), seed, iterations);
  } finally {
    try {
      git('worktree', 'remove', '--force', dir);
    } catch {
      // A failed `worktree add` leaves nothing registered to remove.
    }
    rmSync(dir, { recursive: true, force: true });
  }
};

const main = async (): Promise<number> => {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        seed: { type: 'string' },
        runs: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch {
    console.error(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const seed = countArg(values.seed, Math.floor(Math.random() * 2 ** 31));
  const iterations = countArg(values.runs, 1000);
  if (seed === undefined || iterations === undefined || positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }
  const [ref] = positionals;
  if (ref !== undefined) return runRef(ref, seed, iterations);
  return run(side(`published ${publishedVersion}`, published), seed, iterations);
};

const compare = (old: Side, seed: number, iterations: number): number => {
  const cur = side('working tree', current);

  const divergences: Divergence[] = [];
  let decodes = 0;
  let unsupported = 0;

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
    if (!hasFactories(old.mod, c.src)) {
      unsupported++;
      continue;
    }
    const nodes = [cur, old].map((sd) => {
      try {
        return { node: c.build(sd.mod) };
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
      const results = [cur, old].map((sd, i) => attempt(() => sd.decode(nodes[i].node, input, o)));
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
    const type = base <= 256 && rand() < 0.5 ? 'binary' : 'text';
    const o: Opts = {
      type,
      charset: type === 'binary' && base === 256 && rand() < 0.5 ? undefined : [0, base - 1],
    };
    const { syms, limit } = genSequence(base);
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
      const a = packDecode(cur, input, syms, o, limit);
      const b = packDecode(old, input, syms, o, limit);
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
            `options ${JSON.stringify(o)}${limit === undefined ? '' : `, decode limit ${limit}`}`,
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

  const summary = `working tree vs ${old.label}, seed ${seed}, ${iterations} iterations per half: ${divergences.length} divergence(s)`;
  const report = [`polynar diff fuzz: ${summary}`, `  ${decodes} decodes compared`];
  if (unsupported > 0)
    report.push(`  ${unsupported} schemas skipped, using factories ${old.label} lacks`);
  const kinds = new Map<string, number>();
  for (const d of divergences) kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1);
  for (const [kind, n] of [...kinds].sort((x, y) => y[1] - x[1])) report.push(`    ${n}\t${kind}`);
  // Every divergence, the first of each kind leading.
  const firsts = [...kinds.keys()].map((k) => divergences.find((d) => d.kind === k)!);
  for (const d of new Set([...firsts, ...divergences])) {
    report.push('', `[${d.half}] ${d.kind} — seed ${seed} iteration ${d.iteration}`);
    for (const line of d.detail) report.push(`  ${line}`);
  }
  console.log(report.join('\n'));
  if (divergences.length === 0) return 0;
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::warning title=Wire divergence::${summary}`);
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) {
      // GitHub caps a job summary at 1 MiB.
      const block = report.join('\n').replace(/`{3,}/g, '``').slice(0, 900_000);
      appendFileSync(file, `## Wire divergence\n\n${summary}\n\n\`\`\`\n${block}\n\`\`\`\n`);
    }
  }
  return 1;
};

main().then((code) => process.exit(code));
