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
 *
 *   npx tsx scripts/predictor-gates.ts <rawfiles dir> <corpus dir>
 *     [--sets strings,alice,...] [--options '{"window":4096}'] [--log <file>]
 */

import { appendFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Decoder, Encoder } from '../src/packer';
import { p } from '../src/nodes';
import type { PNode } from '../src/nodes';
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
};

const RAW: Record<Exclude<SetName, 'strings' | NumberSetName>, string> = {
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

function measure(set: SetName, raw: string, corpus: string, o: AdaptiveOptions): number {
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
    const pass = bytes <= GATES[set];
    failed ||= !pass;
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    say(`${set} bytes=${bytes} gate=${GATES[set]} ${pass ? 'PASS' : 'FAIL'} ${s}s`);
  }
  return failed ? 1 : 0;
}

process.exitCode = main();

export {};
