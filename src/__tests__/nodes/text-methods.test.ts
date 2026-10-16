/**
 * The learning methods of `p.string` and `p.binary` one by one: `.learn()`,
 * `.contexts()`, `.words()`, `.codepoints()` and `.repeats()`, alone, in pairs
 * and together as `.adaptive()` has them, `.learning()` for what they go
 * by, and what nodes of one alphabet share.
 */

import { p, CharSets, buildProseModel } from '../../index';
import type { PBinary, PNode, PString } from '../../index';
import { mulberry32, trip } from '../support';

/** The size comparison's lorem ipsum, from examples/size-comparison.ts. */
const LOREM_IPSUM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ' +
  'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure ' +
  'dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ' +
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt ' +
  'mollit anim id est laborum.\n\n' +
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque ' +
  'laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi ' +
  'architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas ' +
  'sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione ' +
  'voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit ' +
  'amet, consectetur, adipisci velit, sed quia non numquam eius modi tempora incidunt ut ' +
  'labore et dolore magnam aliquam quaerat voluptatem.\n\n' +
  'At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium ' +
  'voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint ' +
  'occaecati cupiditate non provident, similique sunt in culpa qui officia deserunt ' +
  'mollitia animi, id est laborum et dolorum fuga. Et harum quidem rerum facilis est et ' +
  'expedita distinctio.';

const random = mulberry32(0x7e47);

/** Hex ids, a third of them seen before. */
const ids = Array.from({ length: 60 }, () =>
  Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('')
).map((id, i, all) => (i % 3 === 2 ? all[i - 2] : id));

/** The same ids in capitals, as `CharSets.hex` spells them. */
const hexIds = ids.map((id) => id.toUpperCase());

/** Japanese, emoji and ASCII, some of it recurring. */
const mixed = [
  'こんにちは世界',
  'hello 👋 world',
  'ありがとう 🙏',
  'こんにちは世界',
  'plain ascii text',
  '日本語のテキストと絵文字 🎌🗾 mixed with English',
  'hello 👋 world',
  '🎉🎉🎉',
  '',
  'ありがとう ございます',
];

type StringMethod = 'learn' | 'contexts' | 'words' | 'codepoints' | 'repeats';
const STRING_METHODS: readonly StringMethod[] = [
  'learn',
  'contexts',
  'words',
  'codepoints',
  'repeats',
];

/** `node` with each of `methods` declared. */
const declare = (node: PString, methods: readonly StringMethod[]): PString =>
  methods.reduce((n, method) => n[method](), node);

/** Every method alone and every pair of them. */
const combos: StringMethod[][] = [
  ...STRING_METHODS.map((m) => [m]),
  ...STRING_METHODS.flatMap((a, i) => STRING_METHODS.slice(i + 1).map((b) => [a, b])),
];

const size = <T>(node: PNode<T>, value: T): number => node.encode(value).length;

describe('p.string learning methods', () => {
  describe('on lorem ipsum', () => {
    it('declared one by one, encode exactly as adaptive', () => {
      const adaptive = p.string().prose().adaptive().encode(LOREM_IPSUM);
      const declared = p.string().prose().learn().contexts().words().repeats();
      expect(declared.encode(LOREM_IPSUM)).toEqual(adaptive);
      expect(trip(declared, LOREM_IPSUM)).toBe(LOREM_IPSUM);
    });

    it('without learn, come within a byte of adaptive, the length unlearned', () => {
      const node = p.string().prose().contexts().words().repeats();
      expect(trip(node, LOREM_IPSUM)).toBe(LOREM_IPSUM);
      const adaptive = size(p.string().prose().adaptive(), LOREM_IPSUM);
      expect(Math.abs(size(node, LOREM_IPSUM) - adaptive)).toBeLessThanOrEqual(1);
    });

    it('price by contexts below the learned odds alone', () => {
      expect(size(p.string().contexts(), LOREM_IPSUM)).toBeLessThan(
        size(p.string().learn(), LOREM_IPSUM)
      );
      expect(size(p.string().prose().contexts(), LOREM_IPSUM)).toBeLessThan(
        size(p.string().prose().learn(), LOREM_IPSUM)
      );
    });
  });

  describe.each([
    ['bare', () => p.string()],
    ['prose', () => p.string().prose()],
    ['hex', () => p.string().charset(CharSets.hex)],
    ['letters', () => p.string().charset('abcdefghijklmnopqrstuvwxyz ,.\n')],
  ] as const)('on a %s string', (name, base) => {
    const inputs: Record<string, string[]> = {
      bare: [LOREM_IPSUM, ...ids, ...mixed],
      prose: [LOREM_IPSUM, ...ids, ...mixed],
      hex: hexIds,
      letters: [LOREM_IPSUM.toLowerCase(), ...ids.map((id) => id.replace(/[0-9]/g, 'x'))],
    };
    const values = inputs[name];

    it.each(combos.map((methods) => [methods.join(' + '), methods] as const))(
      'round-trips under %s',
      (__, methods) => {
        const node = declare(base(), methods);
        expect(trip(p.array(node), values)).toEqual(values);
        for (const value of values.slice(0, 3)) {
          expect(trip(node, value)).toBe(value);
        }
      }
    );
  });

  describe('words', () => {
    /** English that keeps coming back to the same words. */
    const repeated = Array.from(
      { length: 12 },
      () => 'the quick brown fox jumps over the lazy dog'
    ).join(' and ');

    it('alone, spell a known word as its token, below the plain spelling', () => {
      for (const base of [() => p.string(), () => p.string().prose()]) {
        expect(trip(base().words(), repeated)).toBe(repeated);
        expect(size(base().words(), repeated)).toBeLessThan(size(base(), repeated));
      }
      const letters = p.string().charset('abcdefghijklmnopqrstuvwxyz ');
      expect(size(letters.words(), repeated)).toBeLessThan(size(letters, repeated));
    });

    it('never form in a charset without letters', () => {
      const digits = Array.from(
        { length: 30 },
        (_, i) => `${1000 + (i % 4)} ${2000 + (i % 3)}`
      ).join(' ');
      const node = p.string().charset(`${CharSets.digit} `);
      expect(trip(node.words(), digits)).toBe(digits);
      expect(node.words().encode(digits)).toHaveLength(node.encode(digits).length);
    });

    it('take letters past ASCII in a charset and in static prose', () => {
      const text = Array.from({ length: 10 }, () => 'café naïve über façade').join(' ');
      const charset = p.string().charset('abcdefghijklmnopqrstuvwxyzéïüç ');
      expect(trip(charset.words(), text)).toBe(text);
      expect(size(charset.words(), text)).toBeLessThan(size(charset, text));
      expect(trip(p.string().prose().words(), text)).toBe(text);
      const model = buildProseModel(text, { minCount: 1 });
      for (const node of [
        p.string().prose(model).words(),
        p.string().prose(model).learn().words(),
      ]) {
        expect(trip(node, text)).toBe(text);
        expect(trip(node, `Ünder ${text} ÇA`)).toBe(`Ünder ${text} ÇA`);
      }
    });

    it('spell their end where the string spells its own, without contexts', () => {
      const values = [repeated, `${repeated} the end`, 'the quick dog', ''];
      for (const node of [
        p.string().words().terminated(),
        p.string().learn().words().terminated(),
        p.string().words().repeats().terminated(),
        p.string().prose().words().repeats().terminated(),
        p.string().charset('abcdefghijklmnopqrstuvwxyz ').max(600).words().repeats().terminated(),
      ]) {
        expect(trip(p.array(node), values)).toEqual(values);
      }
    });
  });

  describe('codepoints', () => {
    it('beat a bare learn on repeated non-ASCII text', () => {
      const text = Array.from({ length: 20 }, () => 'Привет мир こんにちは').join(' ');
      expect(size(p.string().codepoints(), text)).toBeLessThan(size(p.string().learn(), text));
    });

    it('leave a bare learn on the code-point ladder, apart from prose', () => {
      const text = 'Привет, мир! こんにちは 🌍 ' + LOREM_IPSUM.slice(0, 200);
      expect(trip(p.string().learn(), text)).toBe(text);
      expect(trip(p.string().prose().learn(), text)).toBe(text);
      expect(size(p.string().learn(), text)).not.toBe(size(p.string().prose().learn(), text));
    });

    it('alone, spell a code point the message met by its learned odds', () => {
      const text = Array.from({ length: 20 }, () => 'こんにちは').join(' ');
      expect(trip(p.string().codepoints(), text)).toBe(text);
      expect(size(p.string().codepoints(), text)).toBeLessThan(size(p.string().learn(), text));
    });

    it('add nothing to the learned odds on a charset', () => {
      const node = p.string().charset(CharSets.hex);
      expect(trip(p.array(node.codepoints()), hexIds)).toEqual(hexIds);
      expect(p.array(node.codepoints().learn()).encode(hexIds)).toEqual(
        p.array(node.learn()).encode(hexIds)
      );
    });
  });

  describe('learning', () => {
    it('is set once', () => {
      expect(() => p.string().learning({}).learning({})).toThrow(
        new TypeError('p.string learning is already set')
      );
      expect(() => p.string().learning({ window: 8 }).adaptive({ window: 8 })).toThrow(
        new TypeError('p.string learning is already set')
      );
    });

    it('as adaptive takes it, the same as set first', () => {
      expect(p.array(p.string().adaptive({ window: 8 })).encode(ids)).toEqual(
        p.array(p.string().learning({ window: 8 }).adaptive()).encode(ids)
      );
    });

    it('refuses a method declared twice', () => {
      for (const method of STRING_METHODS) {
        expect(() => p.string()[method]()[method]()).toThrow(
          new TypeError(`p.string ${method} is already set`)
        );
      }
    });
  });

  describe('sharing', () => {
    const half = LOREM_IPSUM.slice(0, LOREM_IPSUM.length / 2);

    it('lets two contexts fields of one alphabet learn together, unless separate', () => {
      const object = (field: () => PString) => p.object({ a: field(), b: field() });
      const value = { a: half, b: half.split(' ').reverse().join(' ') };
      const together = object(() => p.string().contexts());
      const separate = object(() => p.string().contexts().learning({ separate: true }));
      expect(trip(together, value)).toEqual(value);
      expect(trip(separate, value)).toEqual(value);
      const alone = size(p.string().contexts(), value.b);
      const first = size(p.string().contexts(), value.a);
      expect(size(together, value) - first).toBeLessThan(alone);
      expect(size(together, value)).toBeLessThan(size(separate, value));
    });

    it('lets a contexts field and an adaptive one of one alphabet round-trip together', () => {
      const node = p.object({ a: p.string().contexts(), b: p.string().adaptive() });
      const value = { a: half, b: half };
      expect(trip(node, value)).toEqual(value);
      const ids2 = p.object({
        a: p.array(p.string().charset(CharSets.hex).contexts()),
        b: p.array(p.string().charset(CharSets.hex).adaptive()),
      });
      expect(trip(ids2, { a: hexIds, b: hexIds })).toEqual({ a: hexIds, b: hexIds });
    });

    it('lets a growing field and a contexts one round-trip together past ASCII', () => {
      const node = p.object({
        a: p.array(p.string().codepoints()),
        b: p.array(p.string().contexts()),
      });
      const value = { a: mixed, b: [...mixed].reverse() };
      expect(trip(node, value)).toEqual(value);
    });
  });

  describe('terminated', () => {
    it('round-trips across bounds when declared with learn, or alone', () => {
      const values = ['', 'a', 'abc', LOREM_IPSUM.slice(0, 120), ...ids.slice(0, 5)];
      for (const base of [
        () => p.string(),
        () => p.string().min(1).max(130),
        () => p.string().charset(CharSets.alphanumeric + ' ,.'),
        () => p.string().prose().max(200),
      ]) {
        for (const node of [base().terminated(), base().terminated().learn()]) {
          const fit = values.filter((value) => {
            try {
              node.encode(value);
              return true;
            } catch {
              return false;
            }
          });
          expect(fit.length).toBeGreaterThan(0);
          expect(trip(p.array(node), fit)).toEqual(fit);
        }
      }
    });
  });
});

describe('p.binary learning methods', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  const blobs = [bytes(LOREM_IPSUM), ...ids.map(bytes), ...mixed.map(bytes)];

  type BinaryMethod = 'learn' | 'contexts' | 'repeats';
  const BINARY_METHODS: readonly BinaryMethod[] = ['learn', 'contexts', 'repeats'];
  const binaryCombos: BinaryMethod[][] = [
    ...BINARY_METHODS.map((m) => [m]),
    ...BINARY_METHODS.flatMap((a, i) => BINARY_METHODS.slice(i + 1).map((b) => [a, b])),
  ];

  it.each(binaryCombos.map((methods) => [methods.join(' + '), methods] as const))(
    'round-trips under %s',
    (_, methods) => {
      const node = methods.reduce((n: PBinary<Uint8Array>, method) => n[method](), p.binary());
      expect(trip(p.array(node), blobs)).toEqual(blobs);
    }
  );

  it('prices by contexts below the learned odds alone', () => {
    expect(size(p.binary().contexts(), blobs[0])).toBeLessThan(size(p.binary().learn(), blobs[0]));
    expect(size(p.binary().learn(), blobs[0])).toBeLessThan(size(p.binary(), blobs[0]));
  });

  it('sets its learning once', () => {
    expect(() => p.binary().learning({}).learning({})).toThrow(
      new TypeError('p.binary learning is already set')
    );
    expect(() => p.binary().contexts().contexts()).toThrow(
      new TypeError('p.binary contexts is already set')
    );
    expect(p.array(p.binary().adaptive({ window: 8 })).encode(blobs)).toEqual(
      p.array(p.binary().learning({ window: 8 }).adaptive()).encode(blobs)
    );
  });
});
