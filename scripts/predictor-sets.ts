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
import type { PlainNumber, SessionOptions, Sink, Source } from '../src/predictor/session';
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

/** The number sets of the phase-3 gate, coded through `Session.number`. */
export const NUMBER_SETS = ['ints', 'ints-records', 'dates'] as const;
export type NumberSetName = (typeof NUMBER_SETS)[number];

/** One step of a number message: a number at a key path, or a record opening or closing. */
export type NumberOp = { readonly path: string; readonly value: number } | 'enter' | 'leave';

/** One message of numbers; `list` when they are the items of one list (a single path). */
export interface NumberMessage {
  readonly name: string;
  readonly ops: readonly NumberOp[];
  readonly list: boolean;
  /** Dates only: the values count seconds, not milliseconds. */
  readonly seconds?: boolean;
}

/** The ISO date fields of the corpus a declared schema makes `p.date()` (prototype round 29). */
export const DATE_FIELDS: readonly (readonly [file: string, path: string])[] = [
  ['events.json', '/*/timestamp'],
  ['events.json', '/*/sentAt'],
  ['events.json', '/*/traits/createdAt'],
  ['gh-commit.json', '/commit/author/date'],
  ['gh-commit.json', '/commit/committer/date'],
  ['gh-commit.json', '/commit/verification/verified_at'],
  ['gh-issues.json', '/*/created_at'],
  ['gh-issues.json', '/*/updated_at'],
  ['gh-repos.json', '/*/created_at'],
  ['gh-repos.json', '/*/updated_at'],
  ['gh-repos.json', '/*/pushed_at'],
  ['sc-mix.json', '/chats/*/sentAt'],
];

/**
 * A JSON value's leaves with their key paths (`/key` per object key, `/*` per array item) in
 * document order, with a record opening and closing around every object.
 */
function walkJson(
  v: unknown,
  path: string,
  leaf: (path: string, v: unknown) => void,
  record: (open: boolean) => void
): void {
  if (Array.isArray(v)) {
    for (const x of v) walkJson(x, `${path}/*`, leaf, record);
  } else if (v !== null && typeof v === 'object') {
    record(true);
    for (const [k, x] of Object.entries(v)) walkJson(x, `${path}/${k}`, leaf, record);
    record(false);
  } else {
    leaf(path, v);
  }
}

function corpusFiles(corpus: string): string[] {
  return readdirSync(corpus)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

/**
 * The messages of a number set.
 * - ints: per corpus file and key path of JSON integers (paths in order of first appearance), the
 *   sequence as one message.
 * - ints-records: per corpus file, its integers in document order with every object a record.
 * - dates: per field of `DATE_FIELDS`, the dates in ms, or in seconds when every one is whole.
 */
export function numberMessages(set: NumberSetName, corpus: string): NumberMessage[] {
  const out: NumberMessage[] = [];
  for (const f of corpusFiles(corpus)) {
    const json: unknown = JSON.parse(readFileSync(join(corpus, f), 'utf8'));
    if (set === 'ints-records') {
      const ops: NumberOp[] = [];
      walkJson(
        json,
        '',
        (path, v) => {
          if (typeof v === 'number' && Number.isInteger(v)) ops.push({ path, value: v });
        },
        (open) => ops.push(open ? 'enter' : 'leave')
      );
      out.push({ name: f, ops, list: false });
    } else if (set === 'ints') {
      const seqs = new Map<string, NumberOp[]>();
      walkJson(
        json,
        '',
        (path, v) => {
          if (typeof v !== 'number' || !Number.isInteger(v)) return;
          let seq = seqs.get(path);
          if (seq === undefined) seqs.set(path, (seq = []));
          seq.push({ path, value: v });
        },
        () => undefined
      );
      for (const [path, ops] of seqs) out.push({ name: `${f} ${path}`, ops, list: true });
    } else {
      for (const [file, field] of DATE_FIELDS) {
        if (file !== f) continue;
        const ms: number[] = [];
        walkJson(
          json,
          '',
          (path, v) => {
            if (path === field && typeof v === 'string') ms.push(new Date(v).getTime());
          },
          () => undefined
        );
        const seconds = ms.every((t) => t % 1000 === 0);
        const ops = ms.map((t) => ({ path: field, value: seconds ? t / 1000 : t }));
        out.push({ name: `${f} ${field}`, ops, list: true, seconds });
      }
    }
  }
  return out;
}

const NUMBER_PATHS = new Map<string, object>();

/** The session path of a key path: one object per key path, shared by every message. */
function numberPath(path: string): object {
  let key = NUMBER_PATHS.get(path);
  if (key === undefined) NUMBER_PATHS.set(path, (key = {}));
  return key;
}

const PLAIN: PlainNumber = {
  write: (enc, x) => {
    enc.compose(x < 0 ? 1 : 0, 2);
    enc.composeTerm(Math.abs(x));
  },
  read: (dec) => {
    const neg = dec.parse(2) === 1;
    const m = dec.parseTerm();
    return neg ? 0 - m : m;
  },
};

/** Codes a number message through the session of `enc`, with the text prior's tables. */
export function writeNumbers(enc: Encoder, m: NumberMessage, options: SessionOptions = {}): void {
  const s = session(enc, options);
  const o = resolve({}, Priors.text, 'predictor-sets');
  if (m.list) s.enterList();
  for (const op of m.ops) {
    if (op === 'enter') s.enterRecord();
    else if (op === 'leave') s.leaveRecord();
    else {
      if (m.list) s.nextItem();
      s.number(numberPath(op.path), o, {}, PLAIN).write(enc, op.value);
    }
  }
  if (m.list) s.leaveList();
}

/** Reads a number message back and throws unless every number equals the one written. */
export function readNumbers(dec: Decoder, m: NumberMessage, options: SessionOptions = {}): void {
  const s = session(dec, options);
  const o = resolve({}, Priors.text, 'predictor-sets');
  if (m.list) s.enterList();
  m.ops.forEach((op, i) => {
    if (op === 'enter') s.enterRecord();
    else if (op === 'leave') s.leaveRecord();
    else {
      if (m.list) s.nextItem();
      const got = s.number(numberPath(op.path), o, {}, PLAIN).read(dec);
      if (got !== op.value) throw new Error(`round trip failed at ${m.name} op ${i}`);
    }
  });
  if (m.list) s.leaveList();
}
