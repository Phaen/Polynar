/**
 * The cross-engine check of the predictor's integer arithmetic (spec §5.9): encodes the string and
 * number sets of scripts/predictor-sets.ts and prints, per set, the FNV-1a 32 digest of every
 * coded call in order (a weighted symbol as (cum, freq, total), a plain digit as (value, 0, radix),
 * a mixture as its weights before its spellings, each word as its 4 little-endian bytes), and the
 * same for the fixtures below, which need no research files and are what CI checks. With --check
 * the digests are compared with scripts/lockstep.digest (exit code 1 on a difference); with
 * --write that file is written. --fixtures computes, checks or writes the fixture lines alone.
 *
 *   npx tsx scripts/lockstep.ts <alice.txt> <corpus dir> [--check | --write]
 *   npx tsx scripts/lockstep.ts --fixtures [--check | --write]
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { p } from '../src/nodes';
import { Encoder } from '../src/packer';
import type { Sink } from '../src/predictor/session';
import {
  NUMBER_SETS,
  codePoints,
  SET_NAMES,
  messages,
  numberMessages,
  writeMessage,
  writeNumbers,
} from './predictor-sets';
import type { NumberSetName, SetName } from './predictor-sets';

const DIGEST_FILE = join(__dirname, 'lockstep.digest');

/**
 * An encoder that hashes every call into one digest before coding it: weighted symbols, digits,
 * and a mixture's weights (its spellings then hash as they are written).
 */
class DigestEncoder extends Encoder implements Sink {
  h = 0x811c9dc5;

  private word(x: number): void {
    for (let byte = 0; byte < 4; byte++) {
      this.h = Math.imul(this.h ^ ((x >>> (8 * byte)) & 0xff), 0x01000193);
    }
  }

  composeWeighted(cum: number, freq: number, total: number): void {
    this.word(cum);
    this.word(freq);
    this.word(total);
    super.composeWeighted(cum, freq, total);
  }

  compose(integer: number, radix: number): void {
    this.word(integer);
    this.word(0);
    this.word(radix);
    super.compose(integer, radix);
  }

  composeMixture(weights: readonly number[], write: (choice: number) => void): void {
    for (const w of weights) {
      this.word(w % 0x100000000);
      this.word(Math.floor(w / 0x100000000));
    }
    super.composeMixture(weights, write);
  }
}

/** The digest of a set: the calls of every message in order, each message its own encoder. */
function digest(set: SetName | NumberSetName, alice: string, corpus: string): string {
  let h = 0x811c9dc5;
  const run = (write: (enc: DigestEncoder) => void): void => {
    const enc = new DigestEncoder();
    enc.h = h;
    write(enc);
    h = enc.h;
  };
  if ((NUMBER_SETS as readonly string[]).includes(set)) {
    for (const m of numberMessages(set as NumberSetName, corpus))
      run((enc) => writeNumbers(enc, m));
  } else {
    for (const m of messages(set as SetName, alice, corpus))
      run((enc) => writeMessage(enc, enc, m, {}));
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Three short strings, each one message under the text prior. */
const FIXTURE_STRINGS = [
  'The quick brown fox jumps over the lazy dog.',
  'https://example.com/users/1024?tab=profile',
  'Ünïcödé, emoji 👍 and digits 0123456789',
];

/** A small JSON value as one `p.any().compress()` message under the JSON prior. */
const FIXTURE_JSON = {
  id: 1024,
  name: 'Ada Lovelace',
  tags: ['math', 'engine', 'math'],
  active: true,
  score: 98.5,
  manager: null,
  visits: [
    { at: '2024-05-01T10:00:00Z', n: 3 },
    { at: '2024-05-02T10:00:00Z', n: 4 },
  ],
};

/** The fixture lines: their sets need nothing outside the repository. */
function fixtures(): string[] {
  let h = 0x811c9dc5;
  for (const s of FIXTURE_STRINGS) {
    const enc = new DigestEncoder();
    enc.h = h;
    writeMessage(enc, enc, { strings: [codePoints(s)], list: false }, {});
    h = enc.h;
  }
  const strings = (h >>> 0).toString(16).padStart(8, '0');
  const enc = new DigestEncoder();
  p.any().compress()._write(enc, FIXTURE_JSON);
  const json = (enc.h >>> 0).toString(16).padStart(8, '0');
  return [`fixture-strings ${strings}`, `fixture-json ${json}`];
}

function main(): number {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const only = argv.includes('--fixtures');
  if (positional.length !== (only ? 0 : 2)) {
    console.error(
      'usage: tsx scripts/lockstep.ts <alice.txt> <corpus dir> [--check | --write]\n' +
        '       tsx scripts/lockstep.ts --fixtures [--check | --write]'
    );
    return 2;
  }
  const lines: string[] = [];
  if (!only) {
    for (const set of [...SET_NAMES, ...NUMBER_SETS]) {
      lines.push(`${set} ${digest(set, positional[0], positional[1])}`);
    }
  }
  lines.push(...fixtures());
  process.stdout.write(`${lines.join('\n')}\n`);
  const committed = existsSync(DIGEST_FILE) ? readFileSync(DIGEST_FILE, 'utf8').split('\n') : [];
  const name = (line: string): string => line.split(' ')[0];
  // The fixture lines alone replace or match their own lines of the file; the other lines stay.
  const merged = only
    ? [...committed.filter((l) => l !== '' && !lines.some((x) => name(x) === name(l))), ...lines]
    : lines;
  const text = `${merged.join('\n')}\n`;
  if (argv.includes('--write')) {
    writeFileSync(DIGEST_FILE, text);
  } else if (argv.includes('--check')) {
    if (committed.join('\n') !== text) {
      console.error('lockstep: digests differ from scripts/lockstep.digest');
      return 1;
    }
    console.log('lockstep: digests match');
  }
  return 0;
}

process.exitCode = main();

export {};
