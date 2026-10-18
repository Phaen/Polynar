/**
 * The cross-engine check of the predictor's integer arithmetic (spec §5.9): encodes the four sets
 * of scripts/predictor-sets.ts and prints, per set, the FNV-1a 32 digest of every coded triple in
 * order (a weighted symbol as (cum, freq, total), a plain digit as (value, 0, radix), each word as
 * its 4 little-endian bytes). With --check the digests are compared with scripts/lockstep.digest
 * (exit code 1 on a difference); with --write that file is written.
 *
 *   npx tsx scripts/lockstep.ts <alice.txt> <corpus dir> [--check | --write]
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Encoder } from '../src/packer';
import type { Sink } from '../src/predictor/session';
import { SET_NAMES, messages, writeMessage } from './predictor-sets';

const DIGEST_FILE = join(__dirname, 'lockstep.digest');

/** Hashes every call into one digest and forwards it to the current message's encoder. */
class DigestSink implements Sink {
  h = 0x811c9dc5;
  enc = new Encoder();

  private word(x: number): void {
    for (let byte = 0; byte < 4; byte++) {
      this.h = Math.imul(this.h ^ ((x >>> (8 * byte)) & 0xff), 0x01000193);
    }
  }

  composeWeighted(cum: number, freq: number, total: number): void {
    this.word(cum);
    this.word(freq);
    this.word(total);
    this.enc.composeWeighted(cum, freq, total);
  }

  compose(integer: number, radix: number): void {
    this.word(integer);
    this.word(0);
    this.word(radix);
    this.enc.compose(integer, radix);
  }

  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length !== 2) {
    console.error('usage: tsx scripts/lockstep.ts <alice.txt> <corpus dir> [--check | --write]');
    return 2;
  }
  const lines: string[] = [];
  for (const set of SET_NAMES) {
    const sink = new DigestSink();
    for (const m of messages(set, positional[0], positional[1])) {
      sink.enc = new Encoder();
      writeMessage(sink.enc, sink, m, {});
    }
    lines.push(`${set} ${sink.hex()}`);
  }
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (argv.includes('--write')) {
    writeFileSync(DIGEST_FILE, text);
  } else if (argv.includes('--check') && existsSync(DIGEST_FILE)) {
    if (readFileSync(DIGEST_FILE, 'utf8') !== text) {
      console.error('lockstep: digests differ from scripts/lockstep.digest');
      return 1;
    }
    console.log('lockstep: digests match');
  }
  return 0;
}

process.exitCode = main();

export {};
