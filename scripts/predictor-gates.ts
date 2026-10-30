/**
 * The phase-2 measurement gate of the similarity predictor: real bytes through the string and
 * binary nodes under `.adaptive()`, each message decoded back and compared. One line per set:
 * bytes, the gate (the prototype's ideal + 0.5%), PASS or FAIL, and the time it took. The exit
 * code is 1 when a set misses its gate.
 *
 * - strings: every corpus file is one message of its string values in document order, each at
 *   its key path (`.key` per object key, `[]` per array item), every key path its own
 *   `p.string().adaptive()`, as a declared schema would give it.
 * - alice, react, wiki, countries: the raw file as one `p.string().adaptive()`.
 * - 7zr: the raw file as one `p.binary().adaptive()`.
 * - ints: every corpus file's integer sequences per key path (scripts/predictor-sets.ts), each as
 *   one `p.array(p.int().adaptive())` message.
 * - ints-records: every corpus file's integers in document order through the session, every
 *   object a record, one message per file.
 * - dates: the corpus's ISO date fields, each as one `p.array(p.date().adaptive())` message, at
 *   second precision when every date of the field is a whole second.
 * - corpus: every corpus file as one `p.any().adaptive()` message.
 * - schema: every corpus file under the schema inferred from it (the research ledger's
 *   `build()`, dates at second precision where every one is a whole second, as the prototype's
 *   schema stream had them), `.adaptive()` on the root only.
 * - schemaHeldOut: the schema set, each file under a JSON prior trained with `train()` on the other
 *   half of the corpus (the files sorted by name, even and odd), so no file is priced under a prior
 *   that saw it; reported, not gated.
 * - corpusPlain: every corpus file as one plain `p.any()` message; its gate is its bytes exactly.
 *
 *   npx tsx scripts/predictor-gates.ts <rawfiles dir> <corpus dir>
 *     [--sets strings,alice,...] [--options '{"window":4096}'] [--log <file>]
 */

import { appendFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Decoder, Encoder } from '../src/packer';
import { p } from '../src/nodes';
import type { PNode, PObject } from '../src/nodes';
import { Priors } from '../src/predictor/prior';
import { train } from '../src/predictor/train';
import type { AdaptiveOptions } from '../src/predictor/types';
import { numberMessages, readNumbers, writeNumbers } from './predictor-sets';
import type { NumberSetName } from './predictor-sets';

const SETS = [
  'strings',
  'alice',
  'react',
  'wiki',
  'countries',
  '7zr',
  'ints',
  'ints-records',
  'dates',
  'corpus',
  'schema',
  'schemaHeldOut',
  'corpusPlain',
] as const;
type SetName = (typeof SETS)[number];

/** The prototype's ideal bytes + 0.5%. */
const GATES: Record<SetName, number> = {
  strings: 85220,
  alice: 44100,
  react: 21250,
  wiki: 75540,
  countries: 94200,
  '7zr': 294600,
  ints: 2565,
  'ints-records': 2440,
  dates: 2125,
  corpus: 89434,
  // The prototype's 84,610 included companion cells, which the research closed; the formula's
  // remaining gap sits in events, slack and npm-pkg.
  schema: 86000,
  schemaHeldOut: Infinity,
  corpusPlain: 757000,
};

/** The sets that are reported, not gated. */
const REPORTED: ReadonlySet<SetName> = new Set(['schemaHeldOut']);

/** The sets whose gate is their bytes exactly. */
const EXACT: ReadonlySet<SetName> = new Set(['corpusPlain']);

const RAW: Record<
  Exclude<
    SetName,
    'strings' | 'corpus' | 'schema' | 'schemaHeldOut' | 'corpusPlain' | NumberSetName
  >,
  string
> = {
  alice: 'alice.txt',
  react: 'react.js',
  wiki: 'wiki.html',
  countries: 'countries.json',
  '7zr': '7zr.exe',
};

const USAGE =
  'usage: tsx scripts/predictor-gates.ts <rawfiles dir> <corpus dir> ' +
  "[--sets strings,alice,...] [--options '{...}'] [--log <file>]";

/** Every string of a JSON value with its key path, in document order. */
function strings(v: unknown, path: string, out: [string, string][]): [string, string][] {
  if (typeof v === 'string') {
    out.push([path, v]);
  } else if (Array.isArray(v)) {
    for (const x of v) strings(x, `${path}[]`, out);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) strings(x, `${path}.${k}`, out);
  }
  return out;
}

/** Writes `values` through `nodes` into one message, reads them back, and returns its bytes. */
function trip<T>(nodes: readonly PNode<T>[], values: readonly T[], same: (a: T, b: T) => boolean) {
  const enc = new Encoder();
  values.forEach((v, i) => nodes[i]._write(enc, v));
  const out = enc.output();
  const dec = new Decoder(out);
  values.forEach((v, i) => {
    if (!same(nodes[i]._read(dec), v)) throw new Error(`round trip failed at value ${i}`);
  });
  dec.finalize();
  return out.length;
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** A node inferred from `values` and the conversion of a JSON value to what the node takes. */
interface Built {
  readonly node: PNode<any>;
  readonly conv: (v: any) => any;
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/;
const same = (v: any): any => v;
const jsonKind = (v: any): string =>
  v === undefined ? 'undefined' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const decimals = (x: number): number => {
  const s = String(x);
  if (s.includes('e')) return 99;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};

/** The research ledger's inferred schema (`.research/ledger/worker.ts` `build()`), every node plain. */
function build(values: any[]): Built {
  const kinds = new Map<string, any[]>();
  for (const v of values) {
    const k = jsonKind(v);
    if (!kinds.has(k)) kinds.set(k, []);
    (kinds.get(k) as any[]).push(v);
  }
  const absent = kinds.has('undefined');
  const nul = kinds.has('null');
  kinds.delete('undefined');
  kinds.delete('null');
  let b: Built;
  if (kinds.size === 0) b = { node: p.null(), conv: same };
  else if (kinds.size === 1) {
    const [k, vs] = [...kinds][0];
    b = buildKind(k, vs);
  } else {
    const members = [...kinds].map(([k, vs]) => [k, buildKind(k, vs)] as const);
    const byKind = new Map(members.map(([k, m]) => [k, m.conv]));
    b = {
      node: p.union(members.map(([, m]) => m.node)),
      conv: (v) => (byKind.get(jsonKind(v)) as (v: any) => any)(v),
    };
  }
  if (nul && kinds.size > 0) {
    const c = b.conv;
    b = { node: p.nullable(b.node), conv: (v) => (v === null ? null : c(v)) };
  }
  if (absent) {
    const c = b.conv;
    b = { node: p.optional(b.node), conv: (v) => (v === undefined ? undefined : c(v)) };
  }
  return b;
}

function buildKind(k: string, vs: any[]): Built {
  switch (k) {
    case 'boolean':
      return { node: p.bool(), conv: same };
    case 'number': {
      const min = Math.min(...vs);
      const max = Math.max(...vs);
      if (vs.every(Number.isSafeInteger)) {
        if (min >= 0 && max < 256) return { node: p.int().min(0).max(255), conv: same };
        return { node: min >= 0 ? p.int().min(0) : p.int(), conv: same };
      }
      const d = Math.max(...vs.map(decimals));
      if (d <= 4) return { node: p.decimal(10 ** -d), conv: same };
      return { node: p.float(), conv: same };
    }
    case 'string': {
      // At second precision where every date is a whole second, as the measured stream had them.
      if (vs.every((s) => ISO.test(s) && !isNaN(Date.parse(s)))) {
        const seconds = vs.every((s) => Date.parse(s) % 1000 === 0);
        return {
          node: seconds ? p.date().precision('second') : p.date(),
          conv: (s: string) => new Date(s),
        };
      }
      const distinct = [...new Set(vs)];
      if (
        distinct.length <= 12 &&
        vs.length >= 6 &&
        vs.length >= 2 * distinct.length &&
        distinct.every((s) => s.length <= 40)
      )
        return { node: p.enum(distinct), conv: same };
      const spaced = vs.filter((s) => / /.test(s)).length;
      const avg = vs.reduce((a, s) => a + s.length, 0) / vs.length;
      if (
        spaced > vs.length / 2 &&
        avg > 20 &&
        vs.reduce((a, s) => a + (s.match(/ /g)?.length ?? 0), 0) >=
          vs.reduce((a, s) => a + s.length, 0) / 12
      )
        return { node: p.string().prose(), conv: same };
      return { node: p.string(), conv: same };
    }
    case 'array': {
      const item = build(vs.flat());
      return { node: p.array(item.node), conv: (arr: any[]) => arr.map(item.conv) };
    }
    default: {
      const keyCount = new Map<string, number>();
      for (const o of vs)
        for (const key of Object.keys(o)) keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
      const keys = [...keyCount.keys()];
      if ((vs.length <= 2 && keys.length > 12) || keys.some((key) => /^\d|^\d+\.\d+/.test(key))) {
        const val = build(vs.flatMap((o) => Object.values(o)));
        return {
          node: p.record(val.node),
          conv: (o: any) =>
            Object.fromEntries(Object.entries(o).map(([kk, v]) => [kk, val.conv(v)])),
        };
      }
      const fields: Record<string, Built> = {};
      for (const key of keys) fields[key] = build(vs.map((o) => o[key]));
      return {
        node: p.object(Object.fromEntries(keys.map((key) => [key, fields[key].node]))),
        conv: (o: any) => {
          const r: any = {};
          for (const key of keys) if (o[key] !== undefined) r[key] = fields[key].conv(o[key]);
          return r;
        },
      };
    }
  }
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The schema set's bytes with each half of the corpus under a prior trained on the other half. */
function schemaHeldOut(corpus: string, o: AdaptiveOptions): number {
  const files = readdirSync(corpus)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const values = files.map((f) => JSON.parse(readFileSync(join(corpus, f), 'utf8')));
  const halves = [0, 1].map((h) => values.filter((_, i) => i % 2 === h));
  let bytes = 0;
  for (const h of [0, 1]) {
    const prior = train(p.any().adaptive(), halves[1 - h], {
      holdOut: 0,
      from: Priors.json.source,
      epochs: 3,
    });
    for (const v of halves[h]) {
      const b = build([v]);
      bytes += trip([(b.node as PObject<any>).adaptive({ ...o, prior })], [b.conv(v)], sameJson);
    }
  }
  return bytes;
}

function measure(set: SetName, raw: string, corpus: string, o: AdaptiveOptions): number {
  if (set === 'schemaHeldOut') return schemaHeldOut(corpus, o);
  if (set === 'corpus' || set === 'schema' || set === 'corpusPlain') {
    let bytes = 0;
    for (const f of readdirSync(corpus)
      .filter((name) => name.endsWith('.json'))
      .sort()) {
      const v = JSON.parse(readFileSync(join(corpus, f), 'utf8'));
      if (set === 'schema') {
        const b = build([v]);
        const n = trip([(b.node as PObject<any>).adaptive(o)], [b.conv(v)], sameJson);
        if (process.env.PER_FILE !== undefined) console.log(`  ${f} ${n}`);
        bytes += n;
      } else {
        bytes += trip([set === 'corpus' ? p.any().adaptive(o) : p.any()], [v], sameJson);
      }
    }
    return bytes;
  }
  if (set === 'ints-records') {
    let bytes = 0;
    for (const m of numberMessages(set, corpus)) {
      const enc = new Encoder();
      writeNumbers(enc, m);
      const out = enc.output();
      const dec = new Decoder(out);
      readNumbers(dec, m);
      dec.finalize();
      bytes += out.length;
    }
    return bytes;
  }
  if (set === 'ints' || set === 'dates') {
    let bytes = 0;
    for (const m of numberMessages(set, corpus)) {
      const values = m.ops.map((op) => (op as { value: number }).value);
      if (set === 'ints') {
        bytes += trip([p.array(p.int().adaptive(o))], [values], sameList);
      } else {
        const seconds = m.seconds === true;
        const node = seconds ? p.date().precision('second') : p.date();
        const dates = values.map((v) => new Date(seconds ? v * 1000 : v));
        bytes += trip([p.array(node.adaptive(o))], [dates], (a, b) =>
          sameList(
            a.map((d) => d.getTime()),
            b.map((d) => d.getTime())
          )
        );
      }
    }
    return bytes;
  }
  if (set === 'strings') {
    let bytes = 0;
    for (const f of readdirSync(corpus)
      .filter((name) => name.endsWith('.json'))
      .sort()) {
      const all = strings(JSON.parse(readFileSync(join(corpus, f), 'utf8')), '', []);
      const byPath = new Map<string, PNode<string>>();
      const nodes = all.map(([path]) => {
        let node = byPath.get(path);
        if (node === undefined) {
          node = p.string().adaptive(o);
          byPath.set(path, node);
        }
        return node;
      });
      bytes += trip(
        nodes,
        all.map(([, v]) => v),
        (a, b) => a === b
      );
    }
    return bytes;
  }
  const buf = readFileSync(join(raw, RAW[set]));
  if (set === '7zr') {
    return trip([p.binary().adaptive(o)], [new Uint8Array(buf)], (a, b) =>
      Buffer.from(a).equals(Buffer.from(b))
    );
  }
  return trip([p.string().adaptive(o)], [buf.toString('utf8')], (a, b) => a === b);
}

function main(): number {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let sets: SetName[] = [...SETS];
  let options: AdaptiveOptions = {};
  let log: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sets') {
      sets = (argv[++i] ?? '').split(',').filter(Boolean) as SetName[];
      for (const s of sets) if (!SETS.includes(s)) throw new Error(`unknown set ${s}`);
    } else if (a === '--options') {
      options = JSON.parse(argv[++i] ?? '{}') as AdaptiveOptions;
    } else if (a === '--log') {
      log = argv[++i];
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) throw new Error(USAGE);
  const say = (line: string): void => {
    console.log(line);
    if (log !== undefined) appendFileSync(log, `${new Date().toISOString()} ${line}\n`);
  };
  say(`options: ${JSON.stringify(options)}`);
  let failed = false;
  for (const set of sets) {
    const t0 = performance.now();
    const bytes = measure(set, positional[0], positional[1], options);
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    if (REPORTED.has(set)) {
      say(`${set} bytes=${bytes} ${s}s`);
      continue;
    }
    const pass = EXACT.has(set) ? bytes === GATES[set] : bytes <= GATES[set];
    failed ||= !pass;
    say(`${set} bytes=${bytes} gate=${GATES[set]} ${pass ? 'PASS' : 'FAIL'} ${s}s`);
  }
  return failed ? 1 : 0;
}

process.exitCode = main();

export {};
