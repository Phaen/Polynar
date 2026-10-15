/**
 * The shapes prose codes strings under: the words each codes, the string it
 * restores, and which shapes a string takes.
 */

import {
  LOWER,
  MIXED,
  SHAPE_COUNT,
  SHAPE_WEIGHTS,
  lowercase,
  plain,
  restore,
  shapesOf,
  words,
} from '../../nodes/shape';
import { mulberry32 } from '../support';

/** The shapes by name, in shape order. */
const NAMES = [
  'lower space',
  'lower _',
  'lower -',
  'Capitalised space',
  'Capitalised _',
  'Capitalised -',
  'CAPS space',
  'CAPS _',
  'CAPS -',
  'Title',
  'mixed',
  'camel',
  'Pascal',
];
const shape = (name: string): number => NAMES.indexOf(name);

describe('lowercase', () => {
  it.each([
    ['', ''],
    ['abc', 'abc'],
    ['Hello World', 'hello world'],
    ['ÉCOLE 1A', 'École 1a'],
    ['A\ud800Z', 'a\ud800z'],
  ])('lowercases the ASCII capitals of %j', (text, lower) => {
    expect(lowercase(text)).toBe(lower);
  });

  it('returns a string without capitals as it is', () => {
    const text = 'no capitals here';
    expect(lowercase(text)).toBe(text);
  });
});

describe('plain', () => {
  it.each([
    ['', true],
    ['words and digits 12', true],
    ['école', true],
    ['Word', false],
    ['snake_case', false],
    ['kebab-case', false],
  ])('tells whether %j takes only lowercase', (value, expected) => {
    expect(plain(value)).toBe(expected);
  });
});

describe('words and restore', () => {
  it.each([
    ['lower space', 'user not found', 'user not found'],
    ['lower _', 'user_not_found', 'user not found'],
    ['lower -', 'user-not-found', 'user not found'],
    ['Capitalised space', 'User not found', 'user not found'],
    ['Capitalised _', 'User_not_found', 'user not found'],
    ['Capitalised -', '"User-not-found"', '"user not found"'],
    ['CAPS space', 'USER NOT FOUND', 'user not found'],
    ['CAPS _', 'USER_NOT_FOUND', 'user not found'],
    ['CAPS -', 'USER-NOT-FOUND', 'user not found'],
    ['Title', 'The Big Lebowski', 'the big lebowski'],
    ['camel', 'userNotFound', 'user not found'],
    ['camel', 'userID', 'user i d'],
    ['camel', '_Init', '_ init'],
    ['Pascal', 'UserNotFound', 'user not found'],
    ['mixed', 'McDonald', 'McDonald'],
  ])('spells %s %j as %j and back', (name, value, text) => {
    expect(words(shape(name), value)).toBe(text);
    expect(restore(shape(name), text)).toBe(value);
  });

  it('leaves the case of non-ASCII letters alone', () => {
    expect(restore(shape('CAPS space'), 'école ü')).toBe('éCOLE ü');
    expect(restore(shape('Capitalised space'), 'élan vital')).toBe('éLan vital');
    expect(restore(shape('Title'), 'élan vital')).toBe('élan Vital');
    expect(restore(shape('camel'), 'a éb c')).toBe('aébC');
  });

  it('capitalises nothing in text without letters', () => {
    expect(restore(shape('Capitalised space'), '12 34')).toBe('12 34');
    expect(restore(shape('Title'), '12 (34)')).toBe('12 (34)');
    expect(restore(shape('Pascal'), '12 34')).toBe('1234');
  });
});

/** The shapes that restore `value`, each with its text, an earlier one's text left out: what `shapesOf` gives, the long way. */
function everyShape(value: string): [number, string][] {
  const found: [number, string][] = [];
  for (let s = 0; s < SHAPE_COUNT; s++) {
    const text = words(s, value);
    if (restore(s, text) === value && found.every(([, other]) => other !== text)) {
      found.push([s, text]);
    }
  }
  return found;
}

describe('shapesOf', () => {
  const names = (value: string) => shapesOf(value).map(([s]) => NAMES[s]);

  it.each([
    ['user not found', ['lower space']],
    ['user_not_found', ['lower space', 'lower _']],
    // Pascal reads each capital as a word of its own.
    ['USER_NOT_FOUND', ['CAPS space', 'CAPS _', 'mixed', 'Pascal']],
    ['userNotFound', ['mixed', 'camel']],
    ['UserNotFound', ['mixed', 'Pascal']],
    ['Hello there', ['Capitalised space', 'mixed']],
    ['The Big Lebowski', ['Title', 'mixed']],
    // Every word capital: CAPS, then Title, spell it the same.
    ['A B', ['CAPS space', 'mixed']],
    // A single word takes the space separator; camel and Pascal add nothing.
    ['heading', ['lower space']],
    ['HEADING', ['CAPS space', 'mixed', 'Pascal']],
    ['Heading', ['Capitalised space', 'mixed']],
    ['A', ['Capitalised space', 'mixed']],
    // No letters: lowercase.
    ['2024-01-02', ['lower space', 'lower -']],
    ['', ['lower space']],
    ['McDonald', ['mixed', 'Pascal']],
    ['_Init', ['Capitalised space', 'Capitalised _', 'mixed', 'camel']],
  ])('gives %j the shapes %j', (value, expected) => {
    expect(names(value)).toEqual(expected);
  });

  it('agrees with trying every shape on random strings', () => {
    const rnd = mulberry32(7);
    const alphabet = 'aAbBzZ _-.1é';
    for (let n = 0; n < 4000; n++) {
      let value = '';
      for (let k = Math.floor(rnd() * 14); k > 0; k--) {
        value += alphabet[Math.floor(rnd() * alphabet.length)];
      }
      expect(shapesOf(value)).toEqual(everyShape(value));
    }
  });

  it('keeps the length but for camel and Pascal', () => {
    const value = 'Some_Value-of mixedCase';
    for (let s = 0; s < SHAPE_COUNT; s++) {
      expect(words(s, value).length === value.length).toBe(s <= MIXED);
    }
  });
});

describe('static odds', () => {
  it('weighs every shape, lowercase most', () => {
    expect(SHAPE_WEIGHTS).toHaveLength(SHAPE_COUNT);
    expect(SHAPE_WEIGHTS[LOWER]).toBe(Math.max(...SHAPE_WEIGHTS));
  });
});
