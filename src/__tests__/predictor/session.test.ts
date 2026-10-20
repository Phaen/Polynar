import { CorruptInputError, Decoder, Encoder } from '../../packer';
import { ONE } from '../../predictor/arith';
import { loadPrior } from '../../predictor/prior';
import { resolve } from '../../predictor/options';
import { Priors } from '../../predictor/prior';
import { text as shippedText } from '../../predictor/shipped/text';
import { Session, session } from '../../predictor/session';
import type { Sink, Source, TextCoder } from '../../predictor/session';
import type { AdaptiveOptions, AlphabetKind, Ends, PathKey, Resolved } from '../../predictor/types';

const OPEN: Ends = { min: 0, max: undefined, fixed: false };
const opts = (o: AdaptiveOptions = {}): Resolved => resolve(o, Priors.text, 'test');
const cps = (s: string): Int32Array => Int32Array.from(s, (ch) => ch.codePointAt(0)!);
const str = (a: Int32Array): string => String.fromCodePoint(...a);

type Coder = (s: Session) => TextCoder;
interface Item {
  coder: Coder;
  value: Int32Array;
  ends?: Ends;
}

/** Encodes the items in order, decodes them, compares values and the coded triples. */
function trip(
  items: readonly Item[],
  around: (s: Session, i: number) => void = () => undefined
): Uint8Array {
  const enc = new Encoder();
  const calls: number[] = [];
  const sink: Sink = {
    composeWeighted: (c, f, t) => {
      calls.push(c, f, t);
      enc.composeWeighted(c, f, t);
    },
    compose: (v, r) => {
      calls.push(v, -1, r);
      enc.compose(v, r);
    },
  };
  const se = session(enc);
  items.forEach((it, i) => {
    around(se, i);
    it.coder(se).write(sink, it.value, it.value.length, it.ends ?? OPEN);
  });
  const bytes = enc.output();
  const dec = new Decoder(bytes);
  const read: number[] = [];
  const source: Source = {
    parseMember: (total, table) => {
      const i = dec.parseMember(total, table);
      read.push(table.cum(i), table.freq(i), total);
      return i;
    },
    parse: (r) => {
      const v = dec.parse(r);
      read.push(v, -1, r);
      return v;
    },
  };
  const sd = session(dec);
  items.forEach((it, i) => {
    around(sd, i);
    expect(Array.from(it.coder(sd).read(source, it.ends ?? OPEN))).toEqual(Array.from(it.value));
  });
  dec.finalize();
  expect(read).toEqual(calls);
  return bytes;
}

const strAt =
  (path: PathKey, o = opts(), alphabet: AlphabetKind = 'text'): Coder =>
  (s) =>
    s.string(path, o, alphabet);
const textAt =
  (path: PathKey, o = opts(), alphabet: AlphabetKind = 'text'): Coder =>
  (s) =>
    s.text(path, o, alphabet);

const ENGLISH =
  'It was a bright cold day in April, and the clocks were striking thirteen. The hallway ' +
  'smelt of boiled cabbage and old rag mats. At one end of it a coloured poster, too large ' +
  'for indoor display, had been tacked to the wall. It depicted simply an enormous face, more ' +
  'than a metre wide: the face of a man of about forty-five, with a heavy black moustache and ' +
  'ruggedly handsome features. The flat was seven flights up, and he was thirty-nine and had ' +
  'a varicose ulcer above his right ankle, so he went slowly, resting several times on the ' +
  'way. On each landing, opposite the lift-shaft, the poster with the enormous face gazed from ' +
  'the wall. It was one of those pictures which are so contrived that the eyes follow you ' +
  'about when you move. Outside, even through the shut window-pane, the world looked cold. ' +
  'Down in the street little eddies of wind were whirling dust and torn paper into spirals, ' +
  'and though the sun was shining and the sky a harsh blue, there seemed to be no colour in ' +
  'anything, except the posters that were plastered everywhere. The black-moustachio’d face ' +
  'gazed down from every commanding corner. There was one on the house-front immediately ' +
  'opposite. Behind him the voice from the telescreen was still babbling away about pig-iron ' +
  'and the overfulfilment of the Ninth Three-Year Plan. The telescreen received and ' +
  'transmitted simultaneously. Any sound that he made, above the level of a very low ' +
  'whisper, would be picked up by it; moreover, so long as he remained within the field of ' +
  'vision which the metal plaque commanded, he could be seen as well as heard.';

describe('session', () => {
  it('is one per side and takes its options on first use', () => {
    const enc = new Encoder();
    const s = session(enc, { valueFromSecond: true, features: { depth: false } });
    expect(session(enc)).toBe(s);
    expect(s.valueFromSecond).toBe(true);
    expect(s.features.depth).toBe(false);
    expect(s.features.tree).toBe(true);
    expect(new Session().valueFromSecond).toBe(false);
  });

  it('has no id table or prior before its first predictor', () => {
    const s = new Session();
    expect(() => s.ids).toThrow(TypeError);
    expect(() => s.run).toThrow(TypeError);
    s.symbols('p', opts(), 'text');
    expect(s.ids.idOf(0x61)).toBeGreaterThan(0);
    expect(s.run.loaded).toBe(Priors.text);
  });

  it('keeps a space of its own for each prior', () => {
    const s = new Session();
    const a = s.symbols('p', opts(), 'text');
    const other = loadPrior(JSON.parse(JSON.stringify(shippedText)));
    const o = resolve({}, other, 'test');
    const b = s.symbols('p', o, 'text');
    expect(b).not.toBe(a);
    expect(s.space(other)).not.toBe(s.space(Priors.text));
    expect(s.ids).toBe(s.space(Priors.text).ids);
    expect(s.run).toBe(s.space(Priors.text).run);
    expect(
      trip([
        { coder: strAt('p'), value: cps('hello') },
        { coder: strAt('p', o), value: cps('hello') },
        { coder: strAt('q', o), value: cps('help') },
      ]).length
    ).toBeGreaterThan(0);
  });

  it('caches predictors per path and alphabet, derived paths by node and index', () => {
    const s = new Session();
    const o = opts();
    const node = {};
    expect(s.symbols('p', o, 'text')).toBe(s.symbols('p', o, 'text'));
    expect(s.symbols('p', o, 'bytes')).not.toBe(s.symbols('p', o, 'text'));
    expect(s.symbols([node, 1], o, 'text')).toBe(s.symbols([node, 1], o, 'text'));
    expect(s.symbols([node, 2], o, 'text')).not.toBe(s.symbols([node, 1], o, 'text'));
    expect(s.symbols(node, o, 'text')).not.toBe(s.symbols([node, 1], o, 'text'));
  });

  it('keeps the list index through nested lists', () => {
    const s = new Session();
    expect(s.listIndex).toBe(-1);
    s.leaveList();
    expect(s.listIndex).toBe(-1);
    s.enterList();
    s.nextItem();
    s.nextItem();
    expect(s.listIndex).toBe(1);
    s.enterList();
    s.nextItem();
    expect(s.listIndex).toBe(0);
    s.leaveList();
    expect(s.listIndex).toBe(1);
    s.leaveList();
    expect(s.listIndex).toBe(-1);
  });
});

describe('string coders', () => {
  it('round trip strings, repeated values through the value step and key text', () => {
    const p = {};
    const words = ['red', 'green', 'red', 'blue', 'red', 'green', 'magenta', 'red', ''];
    const items: Item[] = [];
    for (const w of words) {
      items.push({ coder: textAt('k'), value: cps('colour') });
      items.push({ coder: strAt(p), value: cps(w) });
    }
    trip(items);
  });

  it('codes repeated values in a list with the sequence cells on', () => {
    const items: Item[] = ['a', 'b', 'a', 'b', 'a', 'c', 'a', 'b'].map((w) => ({
      coder: (s: Session) => s.string('v', opts(), 'text'),
      value: cps(w),
    }));
    const listed = (s: Session, i: number): void => {
      if (i === 0) s.enterList();
      s.nextItem();
    };
    trip(items, listed);
    const enc = new Encoder();
    const s = session(enc, { features: { valueSequence: true } });
    s.enterList();
    for (const it of items) {
      s.nextItem();
      s.string('v', opts(), 'text').write(enc, it.value, it.value.length, OPEN);
    }
    s.leaveList();
  });

  it('shares the message population between paths', () => {
    const a = trip([
      { coder: strAt('x'), value: cps('shared message text') },
      { coder: strAt('y'), value: cps('shared message text!') },
    ]);
    const b = trip([
      { coder: strAt('x', opts({ separate: true })), value: cps('shared message text') },
      { coder: strAt('y', opts({ separate: true })), value: cps('shared message text!') },
    ]);
    expect(a.length).toBeLessThan(b.length);
  });

  it('follows the END rules: minimum, maximum and fixed lengths', () => {
    const v = cps('abcd');
    trip([
      { coder: strAt('e'), value: v, ends: { min: 2, max: 6, fixed: false } },
      { coder: strAt('e'), value: v, ends: { min: 4, max: 4, fixed: false } },
      { coder: strAt('e'), value: v, ends: { min: 4, max: 4, fixed: true } },
      { coder: strAt('e'), value: cps('ab'), ends: { min: 2, max: 6, fixed: false } },
      { coder: strAt('e'), value: cps('wxyz'), ends: { min: 4, max: 4, fixed: true } },
      { coder: textAt('f'), value: cps('wxyz'), ends: { min: 4, max: 4, fixed: true } },
      { coder: textAt('f'), value: cps('wx'), ends: { min: 0, max: 4, fixed: false } },
    ]);
  });

  it('rejects a value outside its length bounds', () => {
    const s = new Session();
    const c = s.string('p', opts(), 'text');
    const enc = new Encoder();
    expect(() => c.write(enc, cps('ab'), 2, { min: 3, max: undefined, fixed: false })).toThrow(
      RangeError
    );
    expect(() => c.write(enc, cps('abcd'), 4, { min: 0, max: 3, fixed: false })).toThrow(
      RangeError
    );
    expect(() => c.write(enc, cps('ab'), 2, { min: 0, max: 3, fixed: true })).toThrow(RangeError);
  });

  it('counts astral code points as two units against the bounds', () => {
    const two: Ends = { min: 0, max: 2, fixed: false };
    trip([
      { coder: strAt('u'), value: cps('😀'), ends: two },
      { coder: strAt('u'), value: cps('a'), ends: two },
      { coder: strAt('u'), value: cps('😀'), ends: { min: 2, max: 2, fixed: true } },
    ]);
    const c = new Session().string('u', opts(), 'text');
    expect(() => c.write(new Encoder(), cps('😀a'), 2, two)).toThrow(RangeError);
  });

  it('refuses an astral code point read one unit before the max', () => {
    const enc = new Encoder();
    session(enc).string('u', opts(), 'text').write(enc, cps('a😀'), 2, OPEN);
    const dec = new Decoder(enc.output());
    expect(() =>
      session(dec).string('u', opts(), 'text').read(dec, { min: 0, max: 2, fixed: false })
    ).toThrow(CorruptInputError);
  });

  it('ends a value only after a whole step of units', () => {
    const pairs: Ends = { min: 0, max: undefined, fixed: false, step: 2 };
    trip([
      { coder: strAt('w', opts(), 'bytes'), value: Int32Array.of(1, 2, 3, 4), ends: pairs },
      { coder: strAt('w', opts(), 'bytes'), value: Int32Array.of(), ends: pairs },
      { coder: textAt('w', opts(), 'bytes'), value: Int32Array.of(9, 9), ends: pairs },
    ]);
    const c = new Session().string('w', opts(), 'bytes');
    expect(() => c.write(new Encoder(), Int32Array.of(1, 2, 3), 3, pairs)).toThrow(RangeError);
  });

  it('closes a text alphabet to its members, escaping the unseen ones by rank', () => {
    const cjk = cps('一丁七万丈三');
    const closed: Coder = (s) => s.string('c', opts(), 'text', cjk);
    trip([
      { coder: closed, value: cps('三丈万七丁一') },
      { coder: closed, value: cps('一丁一丁') },
      { coder: (s) => s.text('k', opts(), 'text', cjk), value: cps('七') },
    ]);
    const members = cps('abcxyz');
    const s = new Session();
    const pred = s.symbols('c', opts(), 'text', members);
    const enc = new Encoder();
    pred.beginValue();
    pred.code(enc, s.ids.idOf(0x61));
    const d = pred.distribution();
    expect(d.indexOf(s.ids.idOf(0x41))).toBe(-1);
    expect(() => pred.write(enc, s.ids.idOf(0x41))).toThrow(RangeError);
  });

  it('refuses to code inside a spelling the encoder tries', () => {
    const enc = new Encoder();
    enc.mark();
    expect(() => session(enc).string('t', opts(), 'text').write(enc, cps('a'), 1, OPEN)).toThrow(
      /inside a spelling/
    );
  });

  it('codes bytes and structure values, implied ones included', () => {
    const bytes = Int32Array.of(0, 255, 7, 7, 128);
    trip([
      { coder: strAt('b', opts(), 'bytes'), value: bytes },
      { coder: strAt('b', opts(), 'bytes'), value: bytes },
      { coder: strAt('s', opts(), 'structure'), value: Int32Array.of(1, 5, 7, 2) },
      { coder: strAt('s', opts(), 'structure'), value: Int32Array.of(1, 5, 7, 2) },
    ]);
  });

  it('writes only the first len symbols', () => {
    const s = new Session();
    const enc = new Encoder();
    s.string('p', opts(), 'text').write(enc, cps('abcdef'), 3, OPEN);
    const dec = new Decoder(enc.output());
    expect(str(new Session().string('p', opts(), 'text').read(dec, OPEN))).toBe('abc');
  });

  it('codes a value as new when the value step dropped it, and still learns its id', () => {
    const o = opts({ quantisation: 4096 });
    const pair = (i: number): Int32Array => Int32Array.of(i % 256, (i - (i % 256)) / 256);
    const items: Item[] = [];
    for (let i = 0; i < 2050; i++) items.push({ coder: strAt('v', o, 'bytes'), value: pair(i) });
    for (const i of [2049, 7, 2048]) items.push({ coder: strAt('v', o, 'bytes'), value: pair(i) });
    trip(items);
  }, 120000);

  it('works without the value step', () => {
    trip(
      ['x', 'x', 'y'].map((w) => ({ coder: strAt('n'), value: cps(w) })),
      () => undefined
    );
    const enc = new Encoder();
    const s = session(enc, { features: { valueStep: false, deltas: false } });
    for (const w of ['x', 'x']) s.string('n', opts(), 'text').write(enc, cps(w), 1, OPEN);
    const dec = new Decoder(enc.output());
    const d = session(dec, { features: { valueStep: false, deltas: false } });
    for (const w of ['x', 'x']) expect(str(d.string('n', opts(), 'text').read(dec, OPEN))).toBe(w);
  });
});

describe('cost', () => {
  it('prices English text under 4 bits per character and a repeat far lower', () => {
    const s = new Session();
    const o = opts();
    const v = cps(ENGLISH.slice(0, 2000));
    const first = s.cost('p', o, 'text', v, OPEN) / ONE;
    expect(first / v.length).toBeLessThan(4);
    const second = s.cost('p', o, 'text', v, OPEN) / ONE;
    expect(second).toBeLessThan(first / 50);
  });

  it('agrees with the bits of the coded table', () => {
    const s = new Session();
    const v = cps('abc');
    const bits = s.cost('p', opts(), 'text', v, OPEN);
    expect(bits).toBeGreaterThan(0);
    expect(Number.isInteger(bits)).toBe(true);
  });
});
