/**
 * The shape of a prose string: how its words are cased and joined. Prose
 * codes each string as lowercase words joined by spaces after one shape
 * symbol that brings the casing and the separators back, so `user_not_found`,
 * `USER_NOT_FOUND` and `userNotFound` all spell the words `user not found`.
 * A string no other shape restores exactly takes `mixed`: it is coded as it
 * is, each capital a shift before its lowercase letter. Only the ASCII
 * letters change case; every other character passes through as it is.
 */

/** The cases a separated shape writes its words in. */
const enum Case {
  Lower,
  /** The string's first letter a capital, the rest lowercase. */
  Capitalised,
  Caps,
}

/**
 * The shapes, in the order a tie between them goes. The first nine are the
 * cases lowercase, Capitalised and CAPS, each with the separators space,
 * `_` and `-`; then Title Case (every word capitalised, joined by spaces),
 * `mixed`, and camelCase and PascalCase, the shapes that change the length.
 */
export const SHAPE_COUNT = 13;
/** The shape of lowercase words joined by spaces: the text as prose codes it. */
export const LOWER = 0;
const TITLE = 9;
/** The shape that codes the string as it is, its capitals shifted. */
export const MIXED = 10;
const CAMEL = 11;
const PASCAL = 12;

const SEPARATORS = [' ', '_', '-'];

const A = 65;
const Z = 90;
const LOWER_A = 97;
const LOWER_Z = 122;
const SPACE = 32;
const UNDERSCORE = 95;
const DASH = 45;

const isUpper = (code: number): boolean => code >= A && code <= Z;
const isLowerLetter = (code: number): boolean => code >= LOWER_A && code <= LOWER_Z;

/** `text` with its ASCII capitals lowercased. */
export function lowercase(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isUpper(code)) {
      out += text.slice(from, i) + String.fromCharCode(code + 32);
      from = i + 1;
    }
  }
  return from === 0 ? text : out + text.slice(from);
}

/** `text` with its ASCII lowercase letters in capitals. */
function uppercase(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += isLowerLetter(code) ? String.fromCharCode(code - 32) : text.charAt(i);
  }
  return out;
}

/** `text` with its first ASCII letter a capital. */
function capitalise(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isLowerLetter(code)) {
      return text.slice(0, i) + String.fromCharCode(code - 32) + text.slice(i + 1);
    }
  }
  return text;
}

/** `text` with the first character of each space-separated word a capital, where it is a letter. */
function title(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const opens = i === 0 || text.charCodeAt(i - 1) === SPACE;
    out += opens && isLowerLetter(code) ? String.fromCharCode(code - 32) : text.charAt(i);
  }
  return out;
}

/** The words of a camel-cased `value`: a space before each capital after the first character, then lowercased. */
function uncamel(value: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (isUpper(code)) {
      out += value.slice(from, i) + (i > 0 ? ' ' : '') + String.fromCharCode(code + 32);
      from = i + 1;
    }
  }
  return out + value.slice(from);
}

/** The camel-cased spelling of `text`: each space dropped and the letter after it a capital. */
function camel(text: string): string {
  let out = '';
  let hump = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === SPACE) {
      hump = true;
      continue;
    }
    out += hump && isLowerLetter(code) ? String.fromCharCode(code - 32) : text.charAt(i);
    hump = false;
  }
  return out;
}

/** The text prose codes `value` as under `shape`, which `restore` may or may not turn back into `value`. */
export function words(shape: number, value: string): string {
  if (shape === MIXED) {
    return value;
  }
  if (shape >= CAMEL) {
    return uncamel(value);
  }
  if (shape === TITLE) {
    return lowercase(value);
  }
  const separator = SEPARATORS[shape % 3];
  return lowercase(separator === ' ' ? value : value.split(separator).join(' '));
}

/** The string `shape` makes of `text`; `mixed` text is the string itself. */
export function restore(shape: number, text: string): string {
  if (shape === MIXED) {
    return text;
  }
  if (shape === CAMEL) {
    return camel(text);
  }
  if (shape === PASCAL) {
    return capitalise(camel(text));
  }
  if (shape === TITLE) {
    return title(text);
  }
  const separator = SEPARATORS[shape % 3];
  const joined = separator === ' ' ? text : text.split(' ').join(separator);
  const casing = Math.floor(shape / 3) as Case;
  return casing === Case.Lower
    ? joined
    : casing === Case.Capitalised
      ? capitalise(joined)
      : uppercase(joined);
}

/** Whether `value` takes no shape but lowercase: it holds no ASCII capital, `_` or `-`. */
export function plain(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (isUpper(code) || code === UNDERSCORE || code === DASH) {
      return false;
    }
  }
  return true;
}

/** What one pass over a string tells of the shapes it may take. */
interface Features {
  capitals: number;
  lowers: number;
  /** Whether the first ASCII letter is a capital. */
  leads: boolean;
  /** Whether the first character is a capital. */
  opens: boolean;
  space: boolean;
  underscore: boolean;
  dash: boolean;
  /** Whether every space-separated word opening with a letter opens with a capital, and no other letter is one. */
  titled: boolean;
  /** Set when the pass stopped early: only `mixed` takes the string, and the counts are partial. */
  mixed: boolean;
}

function featuresOf(value: string): Features {
  const f: Features = {
    capitals: 0,
    lowers: 0,
    leads: false,
    opens: value.length > 0 && isUpper(value.charCodeAt(0)),
    space: false,
    underscore: false,
    dash: false,
    titled: true,
    mixed: false,
  };
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const opens = i === 0 || value.charCodeAt(i - 1) === SPACE;
    if (isUpper(code)) {
      if (f.capitals + f.lowers === 0) {
        f.leads = true;
      }
      f.capitals++;
      f.titled &&= opens;
    } else if (isLowerLetter(code)) {
      f.lowers++;
      f.titled &&= !opens;
    } else if (code === SPACE) {
      f.space = true;
    } else if (code === UNDERSCORE) {
      f.underscore = true;
    } else if (code === DASH) {
      f.dash = true;
    }
    if (f.space && f.capitals > 1 && f.lowers > 0 && !f.titled) {
      // No shape but `mixed` takes the string, whatever follows.
      f.mixed = true;
      break;
    }
  }
  return f;
}

/** Whether `shape` can spell a string of features `f` differently from every shape before it. */
function possible(shape: number, f: Features): boolean {
  if (shape === MIXED) {
    return f.capitals > 0;
  }
  if (shape === TITLE) {
    return f.capitals > 0 && f.space && f.titled;
  }
  if (shape === CAMEL) {
    return !f.space && f.capitals > 0 && !f.opens;
  }
  if (shape === PASCAL) {
    return !f.space && f.capitals > 1 && f.leads;
  }
  const separator = shape % 3;
  if (separator !== 0 && (f.space || !(separator === 1 ? f.underscore : f.dash))) {
    return false;
  }
  const casing = Math.floor(shape / 3) as Case;
  return casing === Case.Lower
    ? f.capitals === 0
    : casing === Case.Capitalised
      ? f.capitals === 1 && f.leads
      : f.capitals > 0 && f.lowers === 0;
}

/**
 * The shapes that spell `value` exactly, each with the text it codes, in
 * tie order. A shape whose text an earlier one already spells the same way
 * is left out: a single word takes the space separator, a string without
 * letters the lowercase. `mixed` spells every string, so it is left out only
 * for a string without capitals, which lowercase spells as it is.
 */
export function shapesOf(value: string): [number, string][] {
  if (plain(value)) {
    return [[LOWER, value]];
  }
  const f = featuresOf(value);
  if (f.mixed) {
    return [[MIXED, value]];
  }
  const found: [number, string][] = [];
  let lower: string | undefined;
  for (let shape = 0; shape < SHAPE_COUNT; shape++) {
    if (!possible(shape, f)) {
      continue;
    }
    // A separated or Title Case shape that is possible restores the string:
    // its features fix where the capitals and separators go. The lowercase
    // text all the space-separated ones code is worked out once.
    let text: string;
    if (shape === TITLE || (shape < TITLE && shape % 3 === 0)) {
      lower ??= lowercase(value);
      text = lower;
    } else {
      text = words(shape, value);
      if (shape >= CAMEL && restore(shape, text) !== value) {
        continue;
      }
    }
    if (found.every(([, other]) => other !== text)) {
      found.push([shape, text]);
    }
  }
  return found;
}

/**
 * The static odds of the shapes, in shape order, per thousand: lowercase
 * words joined by spaces lead, as in running text and most string values,
 * then a capitalised sentence or name, then the identifier cases.
 */
export const SHAPE_WEIGHTS: readonly number[] = [
  // lowercase: space, `_`, `-`
  400, 60, 60,
  // Capitalised
  150, 4, 4,
  // CAPS
  40, 30, 10,
  // Title Case, mixed, camelCase, PascalCase
  60, 100, 60, 40,
];
