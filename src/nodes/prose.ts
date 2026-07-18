/**
 * The order-1 model behind `p.string().prose()`: character frequencies
 * conditioned on the previous character, driven exactly through the weighted
 * packer — no code-length rounding. Each of the 98 contexts (every modeled
 * character, plus one for anything outside the model) carries its own
 * integer frequency table over the 97 modeled characters and an escape
 * symbol that hands any other code point to the laddered codec. A common
 * character after a common predecessor costs ~2–4 bits; nothing is rejected
 * — text far from the model only pays more. The base weights, the bigram
 * boosts and the context rules together ARE the prose wire format.
 */
import { Encoder, Decoder, CorruptInputError } from '../packer';
import { composeCodePoint, parseCodePoint } from './codepoint';

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

export const PROSE_ALPHABET: string = (() => {
  let alphabet = '\t\n';
  for (let code = 32; code <= 126; code++) {
    alphabet += String.fromCharCode(code);
  }
  return alphabet;
})();

/** Symbol index of the escape; one past the last modeled character. */
export const PROSE_ESCAPE = PROSE_ALPHABET.length;

/** Code point → symbol index for every modeled character. */
export const PROSE_INDEX: ReadonlyMap<number, number> = new Map(
  Array.from(PROSE_ALPHABET, (ch, i) => [ch.charCodeAt(0), i])
);

/**
 * Context index for the character preceding the one being coded: its own
 * symbol index when modeled, PROSE_ESCAPE for anything else (escaped code
 * points, and the imaginary space before the first character maps to the
 * space context explicitly in the string node).
 */
export const proseContext = (code: number): number => PROSE_INDEX.get(code) ?? PROSE_ESCAPE;

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

/** Per context: symbol frequencies, their prefix sums, and the grand total. */
const FREQS: Uint32Array[] = [];
const CUMS: Uint32Array[] = [];
export const PROSE_TOTALS: number[] = [];

for (let ctx = 0; ctx <= PROSE_ALPHABET.length; ctx++) {
  const prev = ctx < PROSE_ALPHABET.length ? PROSE_ALPHABET[ctx] : undefined;
  const freqs = new Uint32Array(PROSE_ALPHABET.length + 1);
  for (let sym = 0; sym < PROSE_ALPHABET.length; sym++) {
    const next = PROSE_ALPHABET[sym];
    const weight =
      prev === undefined ? baseWeight(next) : baseWeight(next) * contextMultiplier(prev, next);
    freqs[sym] = Math.max(1, Math.round(weight));
  }
  // Escaped code points cluster: after one non-modeled character, another is
  // far more likely than the base rate says.
  freqs[PROSE_ESCAPE] = prev === undefined ? ESCAPE_WEIGHT * 40 : ESCAPE_WEIGHT;

  const cums = new Uint32Array(freqs.length);
  let total = 0;
  for (let sym = 0; sym < freqs.length; sym++) {
    cums[sym] = total;
    total += freqs[sym];
  }
  FREQS.push(freqs);
  CUMS.push(cums);
  PROSE_TOTALS.push(total);
}

export const proseBucket = (ctx: number, sym: number): readonly [number, number] => [
  CUMS[ctx][sym],
  FREQS[ctx][sym],
];

/**
 * One prose-weighted code point in the given context: the symbol's bucket,
 * or the escape bucket followed by a laddered slot for anything outside the
 * model.
 */
export function composeProsePoint(enc: Encoder, code: number, ctx: number): void {
  const sym = PROSE_INDEX.get(code) ?? PROSE_ESCAPE;
  enc.composeWeighted(CUMS[ctx][sym], FREQS[ctx][sym], PROSE_TOTALS[ctx]);
  if (sym === PROSE_ESCAPE) {
    composeCodePoint(enc, code);
  }
}

export function parseProsePoint(dec: Decoder, ctx: number): number {
  const cums = CUMS[ctx];
  const sym = dec.parseWeighted(PROSE_TOTALS[ctx], (residual) => {
    // Binary search for the bucket holding the residual.
    let lo = 0;
    let hi = cums.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cums[mid] <= residual) lo = mid;
      else hi = mid - 1;
    }
    return [lo, cums[lo], FREQS[ctx][lo]];
  });

  if (sym !== PROSE_ESCAPE) {
    return PROSE_ALPHABET.charCodeAt(sym);
  }
  const code = parseCodePoint(dec);
  // A modeled character has its own bucket, so its escaped form would be a
  // second wire spelling of the same string.
  if (PROSE_INDEX.has(code)) {
    throw new CorruptInputError('Non-canonical escape of a modeled character');
  }
  return code;
}
