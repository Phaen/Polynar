/**
 * `p.string()`: unicode strings, optionally under a charset or a prose model.
 */

import { p, CharSets, CorruptInputError, Encoder, ProseModels, buildProseModel } from '../../index';
import { TEXT_DIRECT_MAX, TEXT_FIRST_RADIX } from '../../nodes/codepoint';
import { compileProse, shiftedTable } from '../../nodes/prose';
import { ProseText } from '../../nodes/string';
import { COST_UNITS } from '../../packer';
import { MIXED, SHAPE_COUNT, SHAPE_WEIGHTS, shapesOf } from '../../nodes/shape';
import { buildWeights } from '../../nodes/weights';
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

const rand = mulberry32(0x57a1);
const below = (n: number): number => Math.floor(rand() * n);

describe('Schema string', () => {
  it('packs ASCII near seven bits per character', () => {
    // 24 slots of log2(131) bits plus the length prefix: 22 bytes, where flat
    // 16-bit code units would spend 49.
    expect(p.string().max(24).encode('twenty four ascii chars!')).toHaveLength(22);
  });

  it.each(['\uD800', '\uDC00', 'a\uD800b', '\uDFFF\uD800', '👋\uD800👋'])(
    'round-trips the lone surrogates of %j bit-exact',
    (value) => {
      expect(trip(p.string(), value)).toBe(value);
      expect(trip(p.string().max(8), value)).toBe(value);
    }
  );

  it('keeps a lead surrogate that a slice cut from its trail', () => {
    // Enough iterations for V8 to optimize the encode loop, where an
    // optimized `codePointAt` reads past the slice into the parent string.
    const node = p.string();
    for (let i = 0; i < 20000; i++) {
      const whole = `abcdefghijklmnopqrstuvwxyz${i}😀 tail`;
      const cut = whole.slice(0, whole.length - 6);
      expect(node.decode(node.encode(cut))).toBe(cut);
    }
  });

  it('narrows the length prefix with min and length', () => {
    const ranged = p.string().min(8).max(12);
    expect(trip(ranged, 'abcdefghij')).toBe('abcdefghij');
    expect(() => ranged.encode('short')).toThrow('String length 5 is below the minimum 8');
    expect(() => ranged.encode('a'.repeat(13))).toThrow('String length 13 is above the maximum 12');
    expect(trip(p.string().min(2), 'abc')).toBe('abc');
    // A fixed length spends nothing on the prefix: eight binary characters
    // fill one byte exactly, where a max of 8 needs a second.
    const bits = p.string().charset('ab');
    expect(bits.length(8).encode('abababab')).toHaveLength(1);
    expect(bits.max(8).encode('abababab')).toHaveLength(2);
    expect(trip(bits.length(8), 'aaaabbbb')).toBe('aaaabbbb');
  });

  it('takes a prior on the length', () => {
    const code = p.string().charset('0123456789').min(4).max(8).weights([1, 1, 50, 1, 1]);
    expect(trip(code, '123456')).toBe('123456');
    const list = (n: typeof code) => p.array(n).length(16).encode(Array(16).fill('123456')).length;
    expect(list(code)).toBeLessThan(list(p.string().charset('0123456789').min(4).max(8)));
    const cdf = p
      .string()
      .max(3)
      .cdf((n) => (n > 0 ? (n - 1) * (n - 1) : 0));
    expect(() => cdf.encode('')).toThrow(
      new RangeError('String length 0 has zero weight under the declared cdf')
    );
    expect(() => p.string().cdf((n) => n)).toThrow(
      new TypeError('p.string cdf requires a max length')
    );
    // A fixed length is one value, so its prior costs nothing either way.
    expect(p.string().length(3).weights([1]).encode('abc')).toEqual(
      p.string().length(3).encode('abc')
    );
    expect(() => p.string().max(2).weights([1, 1])).toThrow('one weight per value');
  });

  it('rejects a value outside its charset', () => {
    expect(() => p.string().charset('0123456789').encode('12a')).toThrow(
      new RangeError('Character "a" at 2 is not in the character set')
    );
    expect(() => p.string().charset([97, 98]).encode('abc')).toThrow(
      new RangeError('Character "c" (code 99) at 2 is outside the range 97–98')
    );
  });

  it('rejects a charset holding half of a surrogate pair', () => {
    expect(() => p.string().charset([0xdc00, 0xdfff])).toThrow(RangeError);
    expect(() => p.string().charset('x\udfff')).toThrow(RangeError);
  });

  it('takes a one-character charset, whose characters cost nothing', () => {
    expect(trip(p.string().charset('x').length(5), 'xxxxx')).toBe('xxxxx');
    expect(p.string().charset([120, 120]).length(5).encode('xxxxx')).toHaveLength(0);
    expect(trip(p.string().charset('a'), 'aaaa')).toBe('aaaa');
  });

  it('round-trips long charset strings', () => {
    const hex = Array.from({ length: 20_000 }, () => '0123456789abcdef'[below(16)]).join('');
    expect(trip(p.string().charset('0123456789abcdef'), hex)).toBe(hex);
    const cyrillic = String.fromCharCode(...Array.from({ length: 3000 }, () => 0x400 + below(256)));
    expect(trip(p.string().charset([0x400, 0x4ff]), cyrillic)).toBe(cyrillic);
  });

  it('reads a surrogate pair split into two code points as the pair', () => {
    // The encoder merges an adjacent lead+trail into one astral code point;
    // the two-slot spelling reads back as the same string.
    const enc = new Encoder();
    enc.composeTerm(2);
    for (const code of [0xd800, 0xdc00]) {
      enc.compose(TEXT_DIRECT_MAX + 2, TEXT_FIRST_RADIX);
      enc.compose(code - 0x800, 0xffff - 0x800 + 1);
    }
    expect(p.string().decode(enc.output())).toBe('\u{10000}');
  });

  it('rejects an astral code point past the length prefix', () => {
    // A one-unit prefix followed by a two-unit code point fits no string.
    const enc = new Encoder();
    enc.composeTerm(1);
    enc.compose(TEXT_DIRECT_MAX + 3, TEXT_FIRST_RADIX);
    enc.compose(0x1f44b - 0x10000, 0x10ffff - 0x10000 + 1);
    expect(() => p.string().decode(enc.output())).toThrow('Code points overrun the length prefix');
  });
});

describe('Schema string prose', () => {
  it.each(['See you at noon?', 'Ünïcödé — 漢字 👋', 'a\uD800b', '\t\n~'])(
    'round-trips %j under a max length',
    (value) => {
      expect(trip(p.string().prose().max(24), value)).toBe(value);
    }
  );

  it('packs English tighter than the flat ladder', () => {
    // ~4.5 bits per character against the ladder's 7.03. A pangram would
    // fail this: rare letters cost 10+ bits under the frequency model.
    const text =
      'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.';
    const prose = p.string().prose().encode(text).length;
    const flat = p.string().encode(text).length;
    expect(prose).toBeLessThan(flat * 0.7);
  });

  it('codes the words of a string apart from their case and separators', () => {
    const prose = p.string().prose();
    const words = prose.encode('user not found').length;
    for (const value of ['USER_NOT_FOUND', 'user-not-found', 'userNotFound', 'UserNotFound']) {
      expect(trip(prose, value)).toBe(value);
      expect(prose.encode(value).length).toBeLessThanOrEqual(words + 1);
    }
    expect(prose.encode('HEADING').length).toBeLessThan(p.string().encode('HEADING').length);
  });

  it.each(['The Big Lebowski', 'McDonald', 'iPhone XR', 'Hi. "Yes!" OK?', 'ÀB_c', 'x'.repeat(30)])(
    'round-trips %j, static and adaptive',
    (value) => {
      expect(trip(p.string().prose(), value)).toBe(value);
      const values = [value, value.toUpperCase(), value.toLowerCase(), value];
      expect(trip(p.array(p.string().prose().adaptive()), values)).toEqual(values);
    }
  );

  it('passes over a shape whose words overrun the length bounds', () => {
    expect(trip(p.string().prose().max(12), 'userNotFound')).toBe('userNotFound');
    expect(trip(p.string().prose().length(6), 'aBcDeF')).toBe('aBcDeF');
    expect(() => p.string().prose().max(11).encode('userNotFound')).toThrow(
      'String length 12 is above the maximum 11'
    );
  });

  it('prices each shape exactly what writing it charges', () => {
    const rnd = mulberry32(11);
    const alphabet = ['a', 'B', 'z', 'Q', ' ', '_', '-', '.', '7', 'é', '漢', '👋', '\ud800'];
    for (const bounds of [{}, { max: 9 }]) {
      const prose = new ProseText(ProseModels.english, bounds);
      for (let n = 0; n < 400; n++) {
        let value = '';
        for (let k = Math.floor(rnd() * 12); k > 0; k--) {
          value += alphabet[Math.floor(rnd() * alphabet.length)];
        }
        for (const [shape, text] of shapesOf(value)) {
          const enc = new Encoder();
          const mark = enc.mark();
          let units = Infinity;
          try {
            prose.spell(enc, shape, text);
            units = enc.bitsSince(mark) * COST_UNITS;
          } catch {
            // Out of bounds: the cost says so.
          }
          expect(prose.cost(shape, text)).toBe(units);
        }
      }
    }
  });

  it('prices the shapes of many distinct strings', () => {
    const values = Array.from({ length: 5000 }, (_, i) => `Item ${i}`);
    expect(trip(p.array(p.string().prose()), values)).toEqual(values);
  });

  it('keeps capitals as shifts, and refuses a shift without its letter', () => {
    const node = p.string().prose();
    for (const value of ['McDonald', 'iPhone 15 Pro', 'ÀB c', 'X', 'a\ud800B']) {
      expect(trip(node, value)).toBe(value);
    }
    const table = compileProse(ProseModels.english);
    const shifted = shiftedTable(ProseModels.english);
    const shapes = buildWeights(SHAPE_WEIGHTS, SHAPE_COUNT, 'test');
    const spell = (symbols: number[]) => {
      const enc = new Encoder();
      enc.composeWeighted(shapes.cums[MIXED], shapes.freqs[MIXED], shapes.total);
      enc.composeTerm(1);
      let row = shifted.start;
      for (const sym of symbols) {
        const weights = buildWeights(shifted.rows[row], shifted.shift + 1, 'test');
        enc.composeWeighted(weights.cums[sym], weights.freqs[sym], weights.total);
        row = sym;
      }
      return enc.output();
    };
    const a = table.index.get(97) as number;
    expect(node.decode(spell([shifted.shift, a]))).toBe('A');
    const dot = table.index.get(46) as number;
    expect(() => node.decode(spell([shifted.shift, dot]))).toThrow(
      new CorruptInputError('A shift is not followed by a lowercase letter')
    );
    expect(() => node.decode(spell([shifted.shift, shifted.shift, shifted.shift]))).toThrow(
      new CorruptInputError('More items than twice the length 1')
    );
  });

  it('cannot combine with a charset', () => {
    expect(() => p.string().prose().charset('abc')).toThrow('cannot combine prose with a charset');
    expect(() => p.string().charset('abc').prose()).toThrow(TypeError);
  });

  it('takes any model, starting outside the alphabet when it has no space', () => {
    const kana = buildProseModel('ありがとうございます。こんにちは。さようなら。');
    for (const value of ['ありがとう', 'こんにちは!', '', 'xyz 🎉']) {
      expect(trip(p.string().prose(kana), value)).toBe(value);
    }
    const text = 'ありがとうございます。こんにちは。';
    expect(p.string().prose(kana).encode(text).length).toBeLessThan(
      p.string().prose().encode(text).length
    );
  });

  it('builds a model as plain data that depends only on its corpus', () => {
    const corpus = 'de kat zit op de mat';
    const copy = JSON.parse(JSON.stringify(buildProseModel(corpus)));
    expect(p.string().prose(buildProseModel(corpus)).encode('de mat')).toEqual(
      p.string().prose(copy).encode('de mat')
    );
    // With an explicit alphabet, everything else rides the escape.
    const ab = buildProseModel('abcba', { alphabet: 'ab' });
    expect(ab.weights).toHaveLength(3);
    expect(trip(p.string().prose(ab), 'abc')).toBe('abc');
  });

  it('builds a model of the lowercase text', () => {
    expect(buildProseModel('The Cat. THE CAT.').alphabet).toBe(' .aceht');
    expect(buildProseModel('abab', { alphabet: 'aAbB' }).alphabet).toBe('ab');
    expect(() => buildProseModel('AB', { alphabet: 'AB' })).toThrow('no characters to model');
  });

  it('leaves rare characters of a built model to the escape', () => {
    const corpus = 'the cat sat on the mat, the end 🎉';
    expect(buildProseModel(corpus).alphabet).toBe(' aehnt');
    expect(Array.from(buildProseModel(corpus, { minCount: 1 }).alphabet)).toContain('🎉');
    expect(trip(p.string().prose(buildProseModel(corpus)), 'the dog 🎉')).toBe('the dog 🎉');
    const lone = buildProseModel('a\udc00a\ud800a', { minCount: 1 });
    expect(lone.alphabet).toBe('a');
    expect(trip(p.string().prose(lone), 'a\ud800\ud800a')).toBe('a\ud800\ud800a');
    expect(() => buildProseModel('abc')).toThrow('no characters to model');
    expect(() => buildProseModel('aa', { alphabet: '' })).toThrow('no characters to model');
    expect(() => buildProseModel('aa', { minCount: 0 })).toThrow(
      new RangeError('buildProseModel minCount must be a positive integer, got 0')
    );
  });

  const row = [1, 1, 1];
  it.each([
    [{ alphabet: '', weights: [[1]] }, 'non-empty'],
    [{ alphabet: 'aa', weights: [row, row, row] }, 'free of duplicates'],
    [
      { alphabet: 'ab', weights: [row, row] },
      'p.string prose weights need a row per alphabet character, plus one: expected 3, got 2',
    ],
    [{ alphabet: 'ab', weights: [row, [1, 1], row] }, 'one weight per value'],
    [{ alphabet: 'ab', weights: [row, [1, 0, 1], row] }, 'positive integers'],
  ])('rejects a model that does not match its alphabet: %j', (model, message) => {
    expect(() => p.string().prose(model)).toThrow(message);
  });

  it('reads a modeled character behind the escape as that character', () => {
    // 'e' has its own bucket; its escaped form reads back as the same string.
    const table = compileProse(ProseModels.english);
    const start = buildWeights(ProseModels.english.weights[table.start], table.escape + 1, 'test');
    const shapes = buildWeights(SHAPE_WEIGHTS, SHAPE_COUNT, 'test');
    const enc = new Encoder();
    enc.composeWeighted(shapes.cums[0], shapes.freqs[0], shapes.total);
    enc.composeTerm(1);
    enc.composeWeighted(start.cums[table.escape], start.freqs[table.escape], start.total);
    enc.compose('e'.charCodeAt(0), TEXT_FIRST_RADIX);
    expect(p.string().prose().decode(enc.output())).toBe('e');
  });
});

describe('p.string().adaptive()', () => {
  const english = LOREM_IPSUM.repeat(2);

  it.each([
    '',
    'The quick brown fox jumps over the lazy dog.',
    english,
    'héllo wörld',
    '漢字かな交じり文',
    'a😀b',
    '\uD800',
    'a\uDC00b',
    '\uDBFF',
  ])('round-trips %j', (value) => {
    expect(trip(p.string().adaptive(), value)).toBe(value);
  });

  it('round-trips several values in one message', () => {
    const values = ['', 'one', 'two', 'a😀b', '\uD800', 'one', 'héllo'];
    expect(trip(p.array(p.string().adaptive()), values)).toEqual(values);
  });

  it('charges less for a value the node already wrote', () => {
    const node = p.array(p.string().adaptive());
    const repeated = node.encode(['some string value', 'some string value']);
    const other = node.encode(['some string value', 'other string valu']);
    expect(repeated.length).toBeLessThan(other.length);
  });

  it('shares the message population between distinct adaptive nodes', () => {
    const value = 'a fairly long string that only needs spelling once';
    const shared = p.object({ a: p.string().adaptive(), b: p.string().adaptive() });
    const apart = p.object({
      a: p.string().adaptive(),
      b: p.string().adaptive({ separate: true }),
    });
    const given = { a: value, b: value };
    expect(trip(shared, given)).toEqual(given);
    expect(trip(apart, given)).toEqual(given);
    expect(shared.encode(given).length).toBeLessThan(apart.encode(given).length);
  });

  it('round-trips one node reused in two fields', () => {
    const node = p.string().adaptive();
    const value = { a: 'same text', b: 'same text' };
    expect(trip(p.object({ a: node, b: node }), value)).toEqual(value);
  });

  it('refuses options that conflict or are out of range', () => {
    expect(() => p.string().adaptive({ order: 4 })).toThrow(
      new TypeError("p.string: adaptive order 4 differs from the prior's order 8")
    );
    expect(() => p.string().adaptive({ candidates: 65 })).toThrow(
      new RangeError('p.string: adaptive candidates must be in 0..64, got 65')
    );
    expect(() => p.string().adaptive({ history: 0 })).toThrow(
      new RangeError('p.string: adaptive history must be in 1..4096, got 0')
    );
    expect(() => p.string().adaptive({ quantisation: 5000 })).toThrow(
      new TypeError('p.string: adaptive quantisation must be a power of two, got 5000')
    );
    expect(() => p.string().adaptive({ window: 0 })).toThrow(
      new RangeError('p.string: adaptive window must be at least 1')
    );
    expect(() => p.string().adaptive().adaptive()).toThrow(
      new TypeError('p.string adaptive is already set')
    );
  });

  describe('beside prose and length priors', () => {
    const model = buildProseModel('some text here', { minCount: 1 });
    const own =
      'p.string adaptive cannot take a prose model: its text model is the prior it learns from';
    const weighed =
      'p.string adaptive cannot weigh the length: an adaptive string ends with a symbol';

    it('takes the default English model', () => {
      const values = ['See you at noon', 'USER_NOT_FOUND', 'userNotFound'];
      expect(trip(p.array(p.string().prose().adaptive()), values)).toEqual(values);
    });

    it('refuses a prose model of its own, declared before or after', () => {
      expect(() => p.string().prose(model).adaptive()).toThrow(new TypeError(own));
      expect(() => p.string().adaptive().prose(model)).toThrow(new TypeError(own));
    });

    it('refuses a prior on the length, declared before or after', () => {
      expect(() => p.string().max(3).weights([1, 1, 1, 1]).adaptive()).toThrow(
        new TypeError(weighed)
      );
      expect(() =>
        p
          .string()
          .adaptive()
          .max(3)
          .cdf((n) => n)
      ).toThrow(new TypeError(weighed));
    });
  });

  describe('bounds', () => {
    it('keeps a range of lengths', () => {
      const node = p.string().min(2).max(4).adaptive();
      for (const value of ['ab', 'abc', 'abcd']) {
        expect(trip(node, value)).toBe(value);
      }
      expect(() => node.encode('a')).toThrow(
        new RangeError('String length 1 is below the minimum 2')
      );
      expect(() => node.encode('abcde')).toThrow(
        new RangeError('String length 5 is above the maximum 4')
      );
    });

    it('keeps a fixed length', () => {
      const node = p.string().length(3).adaptive();
      expect(trip(node, 'abc')).toBe('abc');
      expect(() => node.encode('ab')).toThrow(
        new RangeError('String length 2 is below the minimum 3')
      );
    });

    it('counts code units, so a pair fills a max of two', () => {
      const node = p.string().max(2).adaptive();
      expect(trip(node, '😀')).toBe('😀');
      expect(() => node.encode('😀a')).toThrow(
        new RangeError('String length 3 is above the maximum 2')
      );
    });

    it('takes the empty string under a max of zero', () => {
      expect(trip(p.string().max(0).adaptive(), '')).toBe('');
    });
  });

  describe('charset', () => {
    const hex = p.string().charset(CharSets.hex).adaptive();

    it('round-trips every member in order and a repetitive string', () => {
      expect(trip(hex, CharSets.hex)).toBe(CharSets.hex);
      expect(trip(hex, 'ABABABABABABABABABABABAB')).toBe('ABABABABABABABABABABABAB');
    });

    it('refuses a character outside it as the plain node does', () => {
      const message = new RangeError('Character "x" at 0 is not in the character set');
      expect(() => hex.encode('x1')).toThrow(message);
      expect(() => p.string().charset(CharSets.hex).encode('x1')).toThrow(message);
    });

    it('round-trips a range', () => {
      const node = p.string().charset([0x4e00, 0x4e10]).adaptive();
      const value = '一丐丅丅丅';
      expect(trip(node, value)).toBe(value);
    });
  });

  describe('runs', () => {
    const values = ['pear', 'apple', 'fig', 'apple pie', 'banana'];
    const ascending = [...values].sort();

    it('round-trips under sorted', () => {
      expect(trip(p.array(p.string().adaptive()).sorted(), ascending)).toEqual(ascending);
    });

    it('keeps the given order under unique', () => {
      expect(trip(p.array(p.string().adaptive()).unique(), values)).toEqual(values);
    });

    it('round-trips an unordered collection', () => {
      const node = p.array(p.string().adaptive()).unordered();
      expect(trip(node, values)).toEqual(ascending);
      expect([...trip(p.set(p.string().adaptive()).unordered(), new Set(values))]).toEqual(
        ascending
      );
    });

    it('refuses a descent under sorted, located', () => {
      expect(() => p.array(p.string().adaptive()).sorted().encode(['b', 'a'])).toThrow(
        new RangeError('[1]: Value "a" is below the one before it')
      );
    });
  });

  it('refuses writing inside a spelling the encoder tries', () => {
    const enc = new Encoder();
    enc.mark();
    expect(() => p.string().adaptive()._write(enc, 'a')).toThrow(/inside a spelling/);
  });

  it('ends on corrupt input, with a string or an error', () => {
    const node = p.string().max(3).adaptive();
    const inputs = [
      new Uint8Array([]),
      new Uint8Array([0xff]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      new Uint8Array([0x00, 0x13, 0x37, 0xab, 0xcd, 0xef]),
      node.encode('abc').slice(0, 1),
    ];
    for (const input of inputs) {
      try {
        expect(typeof node.decode(input)).toBe('string');
      } catch (error) {
        expect(error instanceof CorruptInputError || error instanceof RangeError).toBe(true);
      }
    }
  });
});
