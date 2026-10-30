/**
 * Trains the two shipped priors with `train()` and writes them as src/predictor/shipped/text.ts
 * and json.ts, laid out the way prettier (printWidth 100) prints them.
 *
 * - json: the research corpus files, each one `p.any().adaptive()` message.
 * - text: `p.string().adaptive()` messages of the man-bash text the prototype tuned on (its
 *   paragraphs grouped 1, 1, 1, 1, 2, 4, 8, 16, 32 at a time, cycled, each group followed by its
 *   share of the trimmed lines of 8 to 60 characters, each line a message of its own), every
 *   corpus file's string values joined by newlines and cut to their first 12,000 characters, and
 *   the names of /usr/share/dict/propernames that share no word with the test sets' names, one
 *   message each. alice.txt is a gate set and stays out.
 *
 *   npx tsx scripts/train-priors.ts <research dir> [--only text|json] [--log <file>]
 */

import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { p } from '../src/nodes';
import { loadedPriors } from '../src/predictor/prior';
import { trainLogged } from '../src/predictor/train';
import type { Prior } from '../src/predictor/types';
import { NAMES } from './predictor-sets';

const USAGE = 'usage: tsx scripts/train-priors.ts <research dir> [--only text|json] [--log <file>]';
const SHIPPED = join(__dirname, '../src/predictor/shipped');
/** Each corpus file's string message is cut to this, so English text stays most of the sample. */
const CORPUS_CHARS = 12000;

function corpusValues(research: string): unknown[] {
  const dir = join(research, 'corpus');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

/** Every string value of a JSON value in document order. */
function strings(v: unknown, out: string[]): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** The man-bash messages as the prototype's tune.ts groups them (`messages(true)`), over every paragraph. */
function manBash(research: string): string[] {
  const paras = readFileSync(join(research, 'proto/similarity/train.txt'), 'utf8')
    .split(/\n[ \t]*\n/)
    .filter((s) => s.trim().length > 0);
  const lines = paras.flatMap((para) =>
    para
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 8 && l.length <= 60)
  );
  const sizes = [1, 1, 1, 1, 2, 4, 8, 16, 32];
  const groups: string[][] = [];
  for (let i = 0, g = 0; i < paras.length; g++) {
    const n = sizes[g % sizes.length];
    groups.push(paras.slice(i, i + n));
    i += n;
  }
  const per = Math.ceil(lines.length / groups.length);
  const out: string[] = [];
  groups.forEach((g, i) => {
    out.push(g.join('\n\n'));
    out.push(...lines.slice(i * per, (i + 1) * per));
  });
  return out;
}

/** tune.ts `fairNames()`: no name that shares a word with the test sets' names. */
function fairNames(): string[] {
  const test = new Set(NAMES.flatMap((n) => n.split(/[\s-]+/)));
  return readFileSync('/usr/share/dict/propernames', 'utf8')
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x && !test.has(x));
}

// Printing in prettier's layout (corpus-scripts/convert-prior.ts): objects expanded one key per
// line, number arrays flat when they fit and otherwise filled greedily to the print width, arrays
// of arrays one element per line.
const WIDTH = 100;
const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const flat = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(flat).join(', ')}]` : typeof v === 'string' ? quote(v) : String(v);

function emit(lines: string[], v: unknown, indent: string, head: string, tail: string): void {
  if (Array.isArray(v)) {
    const one = `${indent}${head}${flat(v)}${tail}`;
    const nested = v.length > 1 && v.every((x) => Array.isArray(x) && x.length > 1);
    if (!nested && one.length <= WIDTH) {
      lines.push(one);
      return;
    }
    lines.push(`${indent}${head}[`);
    const inner = `${indent}  `;
    if (nested) {
      for (const x of v) emit(lines, x, inner, '', ',');
    } else {
      let line = '';
      for (const x of v) {
        const item = `${flat(x)},`;
        if (line && inner.length + line.length + 1 + item.length <= WIDTH) line += ` ${item}`;
        else {
          if (line) lines.push(inner + line);
          line = item;
        }
      }
      lines.push(inner + line);
    }
    lines.push(`${indent}]${tail}`);
  } else if (v !== null && typeof v === 'object') {
    lines.push(`${indent}${head}{`);
    for (const [k, x] of Object.entries(v)) emit(lines, x, `${indent}  `, `${k}: `, ',');
    lines.push(`${indent}}${tail}`);
  } else {
    const one = `${indent}${head}${flat(v)}${tail}`;
    // A value too long for its key's line moves to the next one, indented.
    if (one.length > WIDTH && head !== '') {
      lines.push(`${indent}${head.trimEnd()}`, `${indent}  ${flat(v)}${tail}`);
    } else lines.push(one);
  }
}

function write(name: 'text' | 'json', prior: Prior, header: string[]): void {
  const lines = [
    '/**',
    ...header.map((l) => ` * ${l}`),
    ' */',
    "import type { Prior } from '../types';",
    '',
  ];
  emit(lines, prior, '', `export const ${name}: Prior = `, ';');
  writeFileSync(join(SHIPPED, `${name}.ts`), `${lines.join('\n')}\n`);
}

function main(): number {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let only: string | undefined;
  let logFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') only = argv[++i];
    else if (argv[i] === '--log') logFile = argv[++i];
    else positional.push(argv[i]);
  }
  if (positional.length !== 1 || (only !== undefined && only !== 'text' && only !== 'json')) {
    console.error(USAGE);
    return 2;
  }
  const research = positional[0];
  const log =
    (name: string) =>
    (line: string): void => {
      const stamped = `${new Date().toISOString()} ${name}: ${line}`;
      console.log(stamped);
      if (logFile !== undefined) appendFileSync(logFile, `${stamped}\n`);
    };
  const corpus = corpusValues(research);
  const from = loadedPriors.json.source.constants;
  if (only !== 'text') {
    const t0 = performance.now();
    const prior = trainLogged(
      p.any().adaptive(),
      corpus,
      // A whole-message grid triple takes minutes per pass, so ρ0 and N0 stay at the converted prior's.
      { grid: { rho0: [from.rho0], n0: [from.n0] } },
      log('json')
    );
    const trainedOn = `The ${corpus.length} files of the research corpus, each one p.any().adaptive() message.`;
    write('json', { ...prior, trainedOn }, [
      'The shipped JSON prior, trained by scripts/train-priors.ts with train() on the research',
      'corpus. Generated; not edited by hand.',
    ]);
    log('json')(`done in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (only !== 'json') {
    const t0 = performance.now();
    const bash = manBash(research);
    const json = corpus.map((v) => strings(v, []).join('\n').slice(0, CORPUS_CHARS));
    const names = fairNames();
    const texts = [...bash, ...json, ...names];
    const prior = trainLogged(p.string().adaptive(), texts, {}, log('text'));
    const trainedOn =
      `${bash.length} messages of man bash, the first ${CORPUS_CHARS} characters of the string ` +
      `values of each of the ${json.length} research corpus files, and ${names.length} names, ` +
      'one message each. No book chapter is in it: alice.txt stays a held-out gate set.';
    write('text', { ...prior, trainedOn }, [
      'The shipped text prior, trained by scripts/train-priors.ts with train() on man bash, the',
      "research corpus's string values and a names list. Generated; not edited by hand.",
    ]);
    log('text')(`done in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }
  return 0;
}

process.exitCode = main();

export {};
