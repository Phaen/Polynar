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
 * prose, charsets, block sizes, plus corrupted inputs: truncated, padded,
 * flipped, out-of-charset) and raw packer symbol sequences aimed at
 * block-boundary ties. Encode output, decode results and thrown errors (class,
 * name and message) must match. Any divergence prints with its seed, iteration
 * and a readable schema, and the exit code is 1.
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
  decoder(input: Uint8Array | string, o: Opts): any;
}

const side = (label: string, mod: Mod): Side => {
  const opts = (o: Opts) => ({ type: o.type, charset: o.charset, blockBits: o.blockBits });
  return {
    label,
    mod,
    encode: (node, value, o) => node.encode(value, opts(o)),
    decode: (node, input, o) => node.decode(input, opts(o)),
    output: (enc, o) => enc.output(opts(o)),
    decoder: (input, o) => new mod.Decoder(input, opts(o)),
  };
};

/** Working-tree API the release lacks: runtime exports, and the options-taking `Encoder#output`. */
const missingApi = (mod: Mod): string[] => {
  const missing = Object.keys(current).filter((k) => !(k in mod));
  if (typeof mod.Encoder?.prototype?.output !== 'function') missing.push('Encoder#output');
  return missing;
};

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

  const summary = `working tree vs ${old.label}, seed ${seed}, ${iterations} iterations per half: ${divergences.length} divergence(s)`;
  const report = [`polynar diff fuzz: ${summary}`, `  ${decodes} decodes compared`];
  const kinds = new Map<string, number>();
  for (const d of divergences) kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1);
  for (const [kind, n] of [...kinds].sort((x, y) => y[1] - x[1])) report.push(`    ${n}\t${kind}`);
  // The first of each kind, then the earliest of the rest, up to ten.
  const firsts = [...kinds.keys()].map((k) => divergences.find((d) => d.kind === k)!);
  const shown = [...new Set([...firsts, ...divergences])].slice(0, 10);
  for (const d of shown) {
    report.push('', `[${d.half}] ${d.kind} — seed ${seed} iteration ${d.iteration}`);
    for (const line of d.detail) report.push(`  ${line}`);
  }
  if (divergences.length > shown.length)
    report.push('', `… ${divergences.length - shown.length} more`);
  console.log(report.join('\n'));
  if (divergences.length === 0) return 0;
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::warning title=Wire divergence::${summary}`);
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) {
      const block = report.join('\n').replace(/`{3,}/g, '``');
      appendFileSync(file, `## Wire divergence\n\n${summary}\n\n\`\`\`\n${block}\n\`\`\`\n`);
    }
  }
  return 1;
};

main().then((code) => process.exit(code));
