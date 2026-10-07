/**
 * Order-1 prose models for `p.string().prose()`: character frequencies
 * conditioned on the previous character, driven exactly through the weighted
 * packer — no code-length rounding. A model is a matrix: one row per
 * previous character plus one for anything outside the alphabet, one column
 * per next character plus an escape that hands any other code point to the
 * laddered codec. Nothing is rejected — text far from the model only pays
 * more. The English model below is built from base weights, bigram boosts
 * and context rules; together they ARE its wire format.
 */
import { Encoder, Decoder, CorruptInputError } from '../packer';
import { composeCodePoint, parseCodePoint } from './codepoint';
import { buildWeights, locateWeighted, type WeightTable } from './weights';

/** Occurrences per ten thousand characters of running English text. */
const BASE_WEIGHTS: Record<string, number> = {
  ' ': 1600,
  e: 999,
  t: 742,
  a: 643,
  o: 611,
  i: 606,
  n: 578,
  s: 521,
  r: 502,
  h: 404,
  l: 326,
  d: 306,
  c: 267,
  u: 218,
  m: 201,
  f: 192,
  p: 171,
  g: 150,
  w: 134,
  y: 133,
  b: 118,
  v: 84,
  k: 43,
  x: 18,
  j: 13,
  q: 10,
  z: 7,
  '.': 65,
  ',': 61,
  '"': 26,
  "'": 24,
  '\n': 20,
  '-': 15,
  '0': 5,
  '1': 5,
  '9': 3,
  '?': 5,
  '!': 3,
  ';': 3,
  ':': 3,
  '(': 2,
  ')': 2,
};

/**
 * Multipliers for strong English bigrams, applied on top of the successor's
 * base weight. Coarse corpus ratios: how much likelier the pair is than the
 * two characters independently.
 */
const BIGRAM_BOOSTS: Record<string, number> = {
  qu: 400,
  th: 12,
  nd: 9,
  ng: 9,
  ck: 8,
  he: 8,
  an: 7,
  er: 7,
  re: 7,
  in: 6,
  at: 6,
  on: 6,
  nt: 6,
  ha: 6,
  es: 6,
  st: 6,
  ed: 6,
  ou: 6,
  ll: 6,
  en: 5,
  to: 5,
  it: 5,
  ea: 5,
  hi: 5,
  is: 5,
  or: 5,
  ti: 5,
  as: 5,
  of: 5,
  ar: 5,
  ve: 5,
  oo: 5,
  ss: 5,
  te: 4,
  et: 4,
  al: 4,
  de: 4,
  se: 4,
  le: 4,
  si: 4,
  ra: 4,
  ld: 4,
  ur: 4,
  ee: 4,
  ff: 4,
  wh: 6,
  sh: 6,
  ch: 6,
  ly: 8,
};

/**
 * Word-initial letter counts per ten thousand, replacing the base rates in
 * the whitespace context: what follows a space is a first letter, and first
 * letters are distributed very differently from running text ('t' leads,
 * 'e' drops tenfold).
 */
const WORD_INITIAL: Record<string, number> = {
  t: 1600,
  a: 1160,
  o: 760,
  i: 730,
  s: 680,
  w: 550,
  c: 520,
  b: 440,
  p: 430,
  h: 420,
  f: 410,
  m: 390,
  d: 320,
  e: 280,
  r: 280,
  l: 240,
  n: 230,
  g: 160,
  y: 160,
  u: 120,
  v: 80,
  k: 60,
  j: 50,
  q: 20,
  z: 3,
  x: 2,
};

const VOWELS = 'aeiou';

/** Uppercase letters ride at a fraction of their lowercase weight. */
const UPPERCASE_DIVISOR = 30;

/** Escape weight per context; anything outside the model rides behind it. */
const ESCAPE_WEIGHT = 30;

/** The characters the English model weights: tab, newline and printable ASCII. */
const ENGLISH_ALPHABET: string = (() => {
  let alphabet = '\t\n';
  for (let code = 32; code <= 126; code++) {
    alphabet += String.fromCharCode(code);
  }
  return alphabet;
})();

const isUpper = (ch: string): boolean => ch >= 'A' && ch <= 'Z';
const isLower = (ch: string): boolean => ch >= 'a' && ch <= 'z';
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isLetter = (ch: string): boolean => isUpper(ch) || isLower(ch);

const baseWeight = (ch: string): number => {
  const own = BASE_WEIGHTS[ch];
  if (own !== undefined) {
    return own;
  }
  const lower = BASE_WEIGHTS[ch.toLowerCase()];
  return lower === undefined ? 1 : Math.max(1, Math.round(lower / UPPERCASE_DIVISOR));
};

/** How much likelier `next` is after `prev` than its base weight says. */
const contextMultiplier = (prev: string, next: string): number => {
  const pair = prev.toLowerCase() + next.toLowerCase();
  const boost = BIGRAM_BOOSTS[pair];
  let m = boost ?? 1;

  if (prev === ' ' || prev === '\n' || prev === '\t') {
    // Word-initial: first-letter rates replace the running-text rates, and
    // sentence case is common while run-on whitespace is not.
    const initial = WORD_INITIAL[next.toLowerCase()];
    if (initial !== undefined) {
      m = initial / baseWeight(next.toLowerCase());
    }
    if (isUpper(next)) m *= 15;
    if (next === ' ') m /= 8;
  } else if (isLetter(prev) && isUpper(next)) {
    m /= 8;
  }

  // English alternates vowels and consonants; a same-class pair without its
  // own boost is a poor bet.
  if (boost === undefined && isLetter(prev) && isLetter(next)) {
    const prevVowel = VOWELS.includes(prev.toLowerCase());
    const nextVowel = VOWELS.includes(next.toLowerCase());
    if (prevVowel === nextVowel) m /= 3;
    else m *= 1.7;
  }

  if ('.!?,;:'.includes(prev)) {
    if (next === ' ') m *= 12;
    else if (isLetter(next)) m /= 3;
  }

  if (isDigit(prev)) {
    if (isDigit(next) || next === '.' || next === ',') m *= 10;
    else if (isLetter(next)) m /= 3;
  }

  // After q almost nothing but u happens; the qu boost above carries u.
  if (prev.toLowerCase() === 'q' && next.toLowerCase() !== 'u') m /= 20;

  return m;
};

/**
 * An order-1 prose model. `weights[row][col]` is how likely the character in
 * column `col` is after the one in row `row`. Rows run over `alphabet`, then
 * one more for after any character outside it; columns run over `alphabet`,
 * then the escape that hands any other code point to the laddered codec. A
 * string starts in the row of the space, or the extra row if the alphabet has
 * no space. The model is part of the wire format.
 */
export interface ProseModel {
  readonly alphabet: string;
  readonly weights: readonly (readonly number[])[];
}

const englishWeights = (): number[][] => {
  const size = ENGLISH_ALPHABET.length;
  const rows: number[][] = [];
  for (let ctx = 0; ctx <= size; ctx++) {
    const prev = ctx < size ? ENGLISH_ALPHABET[ctx] : undefined;
    const row: number[] = [];
    for (const next of ENGLISH_ALPHABET) {
      const weight =
        prev === undefined ? baseWeight(next) : baseWeight(next) * contextMultiplier(prev, next);
      row.push(Math.max(1, Math.round(weight)));
    }
    // Escaped code points cluster: after one non-modeled character, another
    // is far more likely than the base rate says.
    row.push(prev === undefined ? ESCAPE_WEIGHT * 40 : ESCAPE_WEIGHT);
    rows.push(Object.freeze(row) as number[]);
  }
  return rows;
};

/** Ready-made prose models. */
export const ProseModels: { readonly english: ProseModel } = Object.freeze({
  english: Object.freeze({ alphabet: ENGLISH_ALPHABET, weights: Object.freeze(englishWeights()) }),
});

/** A model compiled for coding: symbol lookup and per-row bucket tables. */
export interface ProseTable {
  /** Code point of each symbol, in alphabet order. */
  readonly codes: readonly number[];
  readonly index: ReadonlyMap<number, number>;
  /** Symbol of the escape, and the row for after a character outside the model. */
  readonly escape: number;
  /** Row of the imaginary character before the first. */
  readonly start: number;
  readonly rows: readonly WeightTable[];
  readonly locates: readonly ((residual: number) => readonly [number, number, number])[];
}

const SPACE = 32;

const compiled = new WeakMap<ProseModel, ProseTable>();

/** Validate and compile a model once; nodes sharing a model share the table. */
export function compileProse(model: ProseModel): ProseTable {
  let table = compiled.get(model);
  if (table === undefined) {
    const codes = Array.from(model.alphabet, (ch) => ch.codePointAt(0)!);
    const index = new Map(codes.map((code, i) => [code, i]));
    if (codes.length === 0 || index.size !== codes.length) {
      throw new TypeError('p.string prose alphabet must be non-empty and free of duplicates');
    }
    const escape = codes.length;
    if (model.weights.length !== escape + 1) {
      throw new TypeError('p.string prose weights need a row per alphabet character, plus one');
    }
    const rows = model.weights.map((row) => buildWeights(row, escape + 1, 'p.string prose'));
    table = {
      codes,
      index,
      escape,
      start: index.get(SPACE) ?? escape,
      rows,
      locates: rows.map(locateWeighted),
    };
    compiled.set(model, table);
  }
  return table;
}

/** The row for the character after `code`. */
export const proseContext = (table: ProseTable, code: number): number =>
  table.index.get(code) ?? table.escape;

const isSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdfff;

export interface ProseModelOptions {
  /** The modeled characters; overrides `minCount`. */
  readonly alphabet?: string;
  /** Characters seen fewer times are left to the escape. Defaults to 2. */
  readonly minCount?: number;
}

/**
 * Count a model from sample text: each adjacent pair of characters adds one
 * to its cell, on top of a floor of one so every character stays encodable.
 * The alphabet defaults to every character the corpus uses at least
 * `minCount` times, in code point order; rarer ones are cheaper behind the
 * escape than as a row and column of their own.
 */
export function buildProseModel(corpus: string, options: ProseModelOptions = {}): ProseModel {
  const { minCount = 2 } = options;
  if (!Number.isInteger(minCount) || minCount < 1) {
    throw new RangeError('buildProseModel minCount must be a positive integer');
  }
  let chars = options.alphabet;
  if (chars === undefined) {
    const counts = new Map<string, number>();
    for (const ch of corpus) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    // Lone surrogates stay with the escape: joined into one alphabet string,
    // a lead next to a trail would read back as a single astral character.
    chars = [...counts]
      .filter(([ch, count]) => count >= minCount && !isSurrogate(ch.codePointAt(0)!))
      .map(([ch]) => ch)
      .sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!)
      .join('');
  }
  if (chars === '') {
    throw new RangeError('buildProseModel found no characters to model');
  }
  const codes = Array.from(chars, (ch) => ch.codePointAt(0)!);
  const index = new Map(codes.map((code, i) => [code, i]));
  const escape = codes.length;
  const weights = Array.from({ length: escape + 1 }, () => Array<number>(escape + 1).fill(1));
  let ctx = index.get(SPACE) ?? escape;
  for (const ch of corpus) {
    const sym = index.get(ch.codePointAt(0)!) ?? escape;
    weights[ctx][sym]++;
    ctx = sym;
  }
  return { alphabet: chars, weights };
}

/**
 * One prose-weighted code point in the given row: the symbol's bucket, or
 * the escape bucket followed by a laddered slot for anything outside the
 * model.
 */
export function composeProsePoint(
  enc: Encoder,
  table: ProseTable,
  code: number,
  ctx: number
): void {
  const sym = table.index.get(code) ?? table.escape;
  const row = table.rows[ctx];
  enc.composeWeighted(row.cums[sym], row.freqs[sym], row.total);
  if (sym === table.escape) {
    composeCodePoint(enc, code);
  }
}

export function parseProsePoint(dec: Decoder, table: ProseTable, ctx: number): number {
  const sym = dec.parseWeighted(table.rows[ctx].total, table.locates[ctx]);
  if (sym !== table.escape) {
    return table.codes[sym];
  }
  const code = parseCodePoint(dec);
  // A modeled character has its own bucket, so its escaped form would be a
  // second wire spelling of the same string.
  if (table.index.has(code)) {
    throw new CorruptInputError('Non-canonical escape of a modeled character');
  }
  return code;
}
