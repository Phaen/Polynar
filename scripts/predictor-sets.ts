/**
 * The four measurement sets of the similarity predictor's phase-1 gate, shared by
 * scripts/predictor-sizes.ts and scripts/lockstep.ts, and the coding of one set's messages
 * through the session's string coder.
 *
 * - alice: a text file as one string in one message.
 * - prose: every string value of every JSON file of a corpus directory (files sorted by name,
 *   values in document order) longer than 40 characters and holding a space, as the items of one
 *   list in one message, all at one path.
 * - chat: the 15 sentences of examples/size-comparison.ts, one message each.
 * - names: the 250 profile names of examples/size-comparison.ts, one message each.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Decoder, Encoder } from '../src/packer';
import { resolve } from '../src/predictor/options';
import { Priors } from '../src/predictor/prior';
import { session } from '../src/predictor/session';
import type { SessionOptions, Sink, Source } from '../src/predictor/session';
import type { Ends } from '../src/predictor/types';

export const SET_NAMES = ['alice', 'prose', 'chat', 'names'] as const;
export type SetName = (typeof SET_NAMES)[number];

/** One message: its strings as code points, and whether they are the items of one list. */
export interface Message {
  readonly strings: readonly Int32Array[];
  readonly list: boolean;
}

// From examples/size-comparison.ts.
const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// From examples/size-comparison.ts.
const NAMES = [
  'Ada Lovelace',
  'Alan Turing',
  'Grace Hopper',
  'Claude Shannon',
  'Kurt Gödel',
  'Emmy Noether',
  'Al-Khwarizmi',
  'Blaise Pascal',
  'Sofia Kovalevskaya',
  'John von Neumann',
  'Katherine Johnson',
  'Edsger Dijkstra',
  'Barbara Liskov',
  'Donald Knuth',
  'Margaret Hamilton',
  'Tim',
  'Jo',
  'Maria Gaetana Agnesi',
];

// From examples/size-comparison.ts.
const SENTENCES = [
  'See you at noon?',
  'ok',
  'Running late, start without me.',
  'Did anyone deploy to staging this morning?',
  'The build is green again, thanks for the quick fix!',
  'Where did we land on the pricing question from yesterday?',
  "I'll take a look after lunch.",
  'Can you resend the link?',
  'That worked, wonderful. Shipping it now.',
  'Meeting moved to Thursday at three, same room as always.',
  'No idea what happened here, the logs stop at midnight and nothing after.',
  'Sounds good 👍',
  'Wait, wrong channel — sorry!',
  'The customer says the export still times out on large accounts.',
  'Happy Friday everyone!',
];

/** The profile names of examples/size-comparison.ts, drawn as its generator draws them. */
function profileNames(): string[] {
  const rand = mulberry32(0x7ab1e);
  const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const out: string[] = [];
  for (let i = 0; i < 250; i++) {
    void (rand() < 0.05 ? 0 : rand() < 0.85 ? 1 : 2);
    out.push(NAMES[randInt(0, NAMES.length - 1)]);
    randInt(16, 95);
    rand();
  }
  return out;
}

/** The code points of a string; a lone surrogate is its code unit. */
export function codePoints(s: string): Int32Array {
  const out: number[] = [];
  for (const ch of s) {
    out.push(ch.codePointAt(0)!);
  }
  return Int32Array.from(out);
}

/** Every string value of a JSON value in document order. */
function strings(v: unknown, out: string[]): string[] {
  if (typeof v === 'string') {
    out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) strings(x, out);
  } else if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v)) strings(x, out);
  }
  return out;
}

/** The messages of a set; `alice` is the text file, `corpus` the directory of JSON files. */
export function messages(set: SetName, alice: string, corpus: string): Message[] {
  switch (set) {
    case 'alice':
      return [{ strings: [codePoints(readFileSync(alice, 'utf8'))], list: false }];
    case 'prose': {
      const files = readdirSync(corpus)
        .filter((f) => f.endsWith('.json'))
        .sort();
      const out: Int32Array[] = [];
      for (const f of files) {
        const all = strings(JSON.parse(readFileSync(join(corpus, f), 'utf8')), []);
        for (const s of all) if (s.length > 40 && s.includes(' ')) out.push(codePoints(s));
      }
      return [{ strings: out, list: true }];
    }
    case 'chat':
      return SENTENCES.map((s) => ({ strings: [codePoints(s)], list: false }));
    case 'names':
      return profileNames().map((s) => ({ strings: [codePoints(s)], list: false }));
  }
}

const ENDS: Ends = { min: 0, max: undefined, fixed: false };
/** Every string of a set shares this path. */
const PATH = {};

/** Codes a message's strings at one path through the session of `side`. */
export function writeMessage(enc: Encoder, sink: Sink, m: Message, options: SessionOptions): void {
  const s = session(enc, options);
  const o = resolve({}, Priors.text, 'predictor-sets');
  if (m.list) s.enterList();
  for (const str of m.strings) {
    if (m.list) s.nextItem();
    s.string(PATH, o, 'text').write(sink, str, str.length, ENDS);
  }
  if (m.list) s.leaveList();
}

/** Reads a message back and throws unless every string equals the one written. */
export function readMessage(
  dec: Decoder,
  source: Source,
  m: Message,
  options: SessionOptions
): void {
  const s = session(dec, options);
  const o = resolve({}, Priors.text, 'predictor-sets');
  if (m.list) s.enterList();
  m.strings.forEach((str, i) => {
    if (m.list) s.nextItem();
    const got = s.string(PATH, o, 'text').read(source, ENDS);
    if (got.length !== str.length || got.some((cp, j) => cp !== str[j])) {
      throw new Error(`round trip failed at string ${i}`);
    }
  });
  if (m.list) s.leaveList();
}
