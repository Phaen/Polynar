import { CorruptInputError, Decoder, Encoder } from '../../packer';
import { loadPrior } from '../../predictor/prior';
import { resolve } from '../../predictor/options';
import { loadedPriors } from '../../predictor/prior';
import { text as shippedText } from '../../predictor/shipped/text';
import { Session, session } from '../../predictor/session';
import { SymbolPredictor } from '../../predictor/symbols';
import { Population } from '../../predictor/tables';
import { p } from '../../nodes';
import type {
  Bound,
  MarkerPrior,
  PlainNumber,
  Sink,
  Source,
  TextCoder,
} from '../../predictor/session';
import { END, STRUCT } from '../../predictor/types';
import type { CompressOptions, AlphabetKind, Ends, PathKey, Resolved } from '../../predictor/types';

const OPEN: Ends = { min: 0, max: undefined, fixed: false };
const opts = (o: CompressOptions = {}): Resolved => resolve(o, loadedPriors.text, 'test');
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
    open: () => enc.open(),
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
    get idle() {
      return dec.idle;
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

  it('has no id table before its first predictor', () => {
    const s = new Session();
    expect(() => s.ids).toThrow(TypeError);
    s.symbols('p', opts(), 'text');
    expect(s.ids.idOf(0x61)).toBeGreaterThan(0);
  });

  it('keeps a space of its own for each prior', () => {
    const s = new Session();
    const a = s.symbols('p', opts(), 'text');
    const other = loadPrior(JSON.parse(JSON.stringify(shippedText)));
    const o = resolve({}, other, 'test');
    const b = s.symbols('p', o, 'text');
    expect(b).not.toBe(a);
    expect(s.space(other)).not.toBe(s.space(loadedPriors.text));
    expect(s.ids).toBe(s.space(loadedPriors.text).ids);
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

interface Codec {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
  _write(enc: Encoder, value: unknown): void;
  _read(dec: Decoder): unknown;
}

describe('lone path', () => {
  const TEXT = 'the lone path takes the message populations as its own; the lone path codes';

  /** Codes TEXT at path 'p' through a session of `enc`; counts resolve and update per population. */
  function codeAt(enc: Encoder): {
    s: Session;
    calls: Map<Population, { resolve: number; update: number }>;
  } {
    const calls = new Map<Population, { resolve: number; update: number }>();
    const at = (pop: Population) => {
      let c = calls.get(pop);
      if (c === undefined) {
        c = { resolve: 0, update: 0 };
        calls.set(pop, c);
      }
      return c;
    };
    const origResolve = Population.prototype.resolve;
    const origUpdate = Population.prototype.update;
    Population.prototype.resolve = function (this: Population) {
      at(this).resolve++;
      origResolve.call(this);
    };
    Population.prototype.update = function (this: Population, a: number, off?: number) {
      at(this).update++;
      origUpdate.call(this, a, off);
    };
    try {
      const s = session(enc);
      s.string('p', opts(), 'text').write(enc, cps(TEXT), TEXT.length, OPEN);
      return { s, calls };
    } finally {
      Population.prototype.resolve = origResolve;
      Population.prototype.update = origUpdate;
    }
  }

  it('takes the message populations as its own, each resolved and updated once per step', () => {
    const plain = codeAt(new Encoder());
    const enc = new Encoder();
    enc.root = { _lone: () => 'text' };
    const lone = codeAt(enc);
    const o = opts();
    const ps = lone.s.space(o.prior).pathState('p', o);
    const msg = lone.s.symbols('p', o, 'text').context();
    expect(ps.pop).toBe(msg);
    const plainPs = plain.s.space(o.prior).pathState('p', o);
    expect(plainPs.pop).not.toBe(plain.s.symbols('p', o, 'text').context());
    // Each population of the plain session steps as often as the shared one of the lone session.
    expect(lone.calls.get(ps.pop)).toEqual(plain.calls.get(plainPs.pop));
    expect(lone.calls.get(ps.popF)).toEqual(plain.calls.get(plainPs.popF));
    expect(ps.pop.t).toBe(plainPs.pop.t);
    expect(lone.calls.size).toBe(plain.calls.size - 2);
  });

  it('keeps the session options it is given', () => {
    const enc = new Encoder();
    enc.root = { _lone: () => 'bytes' };
    expect(session(enc, { valueFromSecond: true }).valueFromSecond).toBe(true);
    const dec = new Decoder(new Uint8Array(0));
    dec.root = { _lone: () => undefined };
    const s = session(dec);
    const o = opts();
    expect(s.space(o.prior).pathState('p', o).pop).not.toBe(s.symbols('p', o, 'text').context());
  });

  it('is named by a compressed string or binary root only', () => {
    expect(p.string().compress()._lone()).toBe('text');
    expect(p.binary().compress()._lone()).toBe('bytes');
    expect(p.string()._lone()).toBeUndefined();
    expect(p.binary()._lone()).toBeUndefined();
    expect(p.string().compress({ separate: true })._lone()).toBeUndefined();
    expect(p.int()._lone()).toBeUndefined();
    expect(p.object({ a: p.string().compress() })._lone()).toBeUndefined();
  });

  it('codes the bytes of separate path and message populations', () => {
    const cases: [Codec, unknown][] = [
      [p.string().compress() as unknown as Codec, TEXT],
      [p.binary().compress() as unknown as Codec, new TextEncoder().encode(TEXT)],
    ];
    for (const [node, value] of cases) {
      const enc = new Encoder();
      node._write(enc, value);
      const bytes = enc.output();
      expect(node.encode(value)).toEqual(bytes);
      expect(node.decode(bytes)).toEqual(value);
      expect(node._read(new Decoder(bytes))).toEqual(value);
    }
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

  it('replays a known value without learning, in step on both sides', () => {
    const o = opts();
    const implied = jest.spyOn(SymbolPredictor.prototype, 'implied');
    const snaps: unknown[][] = [];
    const snap = (s: Session): unknown[] => {
      const run = s.space(o.prior).run;
      return [run.escape, ...[run.kernel, run.hybrid, run.apm, run.pnov].map((x) => Array.from(x))];
    };
    trip(
      ['abc', 'abc', 'abd', 'abc'].map((w) => ({ coder: strAt('r', o), value: cps(w) })),
      (s, i) => {
        if (i === 1) snaps.push(snap(s));
        if (i === 2) expect(snap(s)).toEqual(snaps[snaps.length - 1]);
      }
    );
    expect(implied).toHaveBeenCalled();
    implied.mockRestore();
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

describe('string coders without deltas', () => {
  it('round-trip repeated values through the value step', () => {
    const o = opts();
    const values = ['alpha', 'beta', 'alpha', 'alpha', 'beta'];
    const options = { features: { deltas: false } };
    const enc = new Encoder();
    const se = session(enc, options);
    for (const v of values) se.string('p', o, 'text').write(enc, cps(v), v.length, OPEN);
    const dec = new Decoder(enc.output());
    const sd = session(dec, options);
    expect(values.map(() => str(sd.string('p', o, 'text').read(dec, OPEN)))).toEqual(values);
    dec.finalize();
  });
});

describe('Session.step', () => {
  it('round-trips declared members with weights and learns their frequencies', () => {
    const o = opts();
    const node = {};
    const values = [0, 2, 2, 2, 1, 2, 2, 0, 2, 2, 2, 2];
    const enc = new Encoder();
    const se = session(enc);
    for (const v of values) se.step(node, o, 3, [1, 1, 4]).write(enc, v);
    const bytes = enc.output();
    const dec = new Decoder(bytes);
    const sd = session(dec);
    expect(values.map(() => sd.step(node, o, 3, [1, 1, 4]).read(dec))).toEqual(values);
    dec.finalize();
  });

  it('counts positions in the path’s own population under separate, inside a list', () => {
    const o = opts({ separate: true });
    const values = [3, 1, 3, 3, 0];
    const enc = new Encoder();
    const se = session(enc, { features: { deltas: false } });
    se.enterList();
    for (const v of values) {
      se.nextItem();
      se.step([{}, 1], o, 4).write(enc, v);
    }
    se.leaveList();
    expect(enc.output().length).toBeGreaterThan(0);
  });

  it('refuses a member of weight 0', () => {
    const enc = new Encoder();
    expect(() => session(enc).step({}, opts(), 3, [1, 0, 1]).write(enc, 1)).toThrow(RangeError);
  });

  it('refuses to code inside a spelling the encoder tries', () => {
    const s = new Session({}, { active: true });
    const enc = new Encoder();
    expect(() => s.step({}, opts(), 2).write(enc, 0)).toThrow(/cannot code inside/);
    expect(() =>
      s.number({}, opts(), {}, { write: () => {}, read: () => 0 }).write(enc, 0)
    ).toThrow(/cannot code inside/);
  });
});

describe('Session.value', () => {
  const WORDS = ['ant', 'bee', 'cat', 'dog', 'eel', 'fox', 'gnu', 'hen'];

  /** Writes `keys` at one path, each new one spelled as its index in WORDS, and reads them back. */
  function valueTrip(keys: readonly string[], o: Resolved, options = {}): number {
    const node = {};
    const enc = new Encoder();
    const se = session(enc, options);
    for (const k of keys) {
      se.value(node, o).write(enc, k, () => enc.compose(WORDS.indexOf(k), WORDS.length));
    }
    const bytes = enc.output();
    const dec = new Decoder(bytes);
    const sd = session(dec, options);
    expect(
      keys.map(() => sd.value(node, o).read(dec, () => WORDS[dec.parse(WORDS.length)]))
    ).toEqual(keys);
    dec.finalize();
    return bytes.length;
  }

  it('names a value the path had before and spells the first and every new one', () => {
    const keys = ['cat', 'dog', 'cat', 'cat', 'eel', 'cat', 'dog', 'cat', 'cat', 'cat'];
    for (const options of [{}, { features: { deltas: false } }]) {
      expect(valueTrip(keys, opts(), options)).toBeGreaterThan(0);
      expect(valueTrip(keys, opts({ separate: true }), options)).toBeGreaterThan(0);
    }
    const repeats = Array.from({ length: 64 }, () => 'cat');
    expect(valueTrip(repeats, opts())).toBeLessThan(valueTrip(['cat'], opts()) + 4);
  });

  it('spells every value without the value step', () => {
    const keys = ['cat', 'cat', 'cat', 'cat', 'cat', 'cat', 'cat', 'cat'];
    const off = { features: { valueStep: false } };
    // Each value is one digit of 8, so eight of them take three bytes.
    expect(valueTrip(keys, opts(), off)).toBe(3);
  });

  it('spells a past value left out of a full table as new', () => {
    const many = Array.from({ length: 2100 }, (_, i) => `k${i}`);
    const keys = [...many, ...many];
    const node = {};
    const o = opts({ quantisation: 4096 });
    const enc = new Encoder();
    const se = session(enc);
    let spelled = 0;
    for (const k of keys) {
      se.value(node, o).write(enc, k, () => {
        spelled++;
        enc.compose(Number(k.slice(1)), 4096);
      });
    }
    expect(spelled).toBeGreaterThan(many.length);
    const dec = new Decoder(enc.output());
    const sd = session(dec);
    expect(keys.map(() => sd.value(node, o).read(dec, () => `k${dec.parse(4096)}`))).toEqual(keys);
    dec.finalize();
  });

  it('refuses to code inside a spelling the encoder tries', () => {
    const s = new Session({}, { active: true });
    expect(() => s.value({}, opts()).write(new Encoder(), 'a', () => undefined)).toThrow(
      /cannot code inside/
    );
  });
});

describe('Session records', () => {
  const PLAIN: PlainNumber = {
    write: (enc, x) => enc.composeTerm(x),
    read: (dec) => dec.parseTerm(),
  };

  it('round-trips numbers outside any record and in a record nested in another', () => {
    const o = opts();
    const [a, b] = [{}, {}];
    const xs = Array.from({ length: 20 }, (_, i) => 100 * i);
    const enc = new Encoder();
    const se = session(enc);
    se.number(a, o, {}, PLAIN).write(enc, 7);
    for (const x of xs) {
      se.enterRecord();
      se.enterRecord();
      se.number(a, o, {}, PLAIN).write(enc, x);
      se.leaveRecord();
      se.number(b, o, {}, PLAIN).write(enc, x + 1);
      se.leaveRecord();
    }
    const dec = new Decoder(enc.output());
    const sd = session(dec);
    expect(sd.number(a, o, {}, PLAIN).read(dec)).toBe(7);
    for (const x of xs) {
      sd.enterRecord();
      sd.enterRecord();
      expect(sd.number(a, o, {}, PLAIN).read(dec)).toBe(x);
      sd.leaveRecord();
      expect(sd.number(b, o, {}, PLAIN).read(dec)).toBe(x + 1);
      sd.leaveRecord();
    }
    dec.finalize();
  });
});

describe('Session markers', () => {
  const o = opts();

  /** One structure symbol: where it is coded, for which node, under which bound and prior. */
  interface Mark {
    sym: number;
    self?: PathKey;
    target?: object;
    bound?: Bound;
    prior?: MarkerPrior;
  }

  /** Codes the marks through `marker`, decodes them, compares symbols and triples; returns the bytes. */
  function tripMarks(marks: readonly Mark[], around: (s: Session) => void = () => undefined) {
    const enc = new Encoder();
    const se = session(enc);
    around(se);
    for (const m of marks)
      se.marker(m.self ?? 'self', o).write(enc, m.sym, m.target, m.bound, m.prior);
    const bytes = enc.output();
    const dec = new Decoder(bytes);
    const sd = session(dec);
    around(sd);
    expect(
      marks.map((m) => sd.marker(m.self ?? 'self', o).read(dec, m.target, m.bound, m.prior))
    ).toEqual(marks.map((m) => m.sym));
    dec.finalize();
    return bytes;
  }

  /**
   * Codes `syms` through `write` after a run of HINTs straight at `path`, then reads them all back
   * straight off the structure predictor at `path`, whose own history sets it apart from any other
   * path's.
   */
  function readsAt(
    path: PathKey,
    syms: readonly number[],
    write: (s: Session, enc: Encoder, sym: number) => void
  ) {
    const enc = new Encoder();
    const se = session(enc);
    const ahead = se.symbols(path, o, 'structure');
    for (let i = 0; i < 8; i++) ahead.code(enc, STRUCT.HINT, false);
    for (const sym of syms) write(se, enc, sym);
    const dec = new Decoder(enc.output());
    const pred = session(dec).symbols(path, o, 'structure');
    for (let i = 0; i < 8; i++) pred.decode(dec, false);
    expect(syms.map(() => pred.decode(dec, false))).toEqual(syms);
    dec.finalize();
  }

  const SYMS = [STRUCT.OBJ_START, STRUCT.KEY, STRUCT.STR, STRUCT.KEY, STRUCT.INT, STRUCT.OBJ_END];

  it('codes at its own path outside every container', () => {
    readsAt('self', SYMS, (s, enc, sym) => s.marker('self', o).write(enc, sym));
  });

  it('codes at the innermost container on the predictor', () => {
    readsAt('inner', SYMS, (s, enc, sym) => {
      s.enterScope('outer', o);
      s.enterScope('inner', o);
      s.marker('self', o).write(enc, sym);
      s.leaveScope();
      s.leaveScope();
    });
  });

  it('codes at its own path under a container off the predictor', () => {
    readsAt('self', SYMS, (s, enc, sym) => {
      s.enterScope('outer', o);
      s.enterPlain();
      s.marker('self', o).write(enc, sym);
      s.leaveScope();
      s.leaveScope();
    });
  });

  it('holds a symbol for its target alone, until the target takes it once', () => {
    const [node, other] = [{}, {}];
    const enc = new Encoder();
    const s = session(enc);
    expect(s.take(node)).toBe(-1);
    s.marker('self', o).write(enc, STRUCT.STR, node);
    expect(s.take(other)).toBe(-1);
    expect(s.take(node)).toBe(STRUCT.STR);
    expect(s.take(node)).toBe(-1);
    s.give(STRUCT.TRUE, other);
    expect(s.take(node)).toBe(-1);
    expect(s.take(other)).toBe(STRUCT.TRUE);
    expect(s.take(other)).toBe(-1);
  });

  it('drops a held symbol on a symbol written for no target', () => {
    const node = {};
    const enc = new Encoder();
    const s = session(enc);
    s.marker('self', o).write(enc, STRUCT.STR, node);
    s.marker('self', o).write(enc, STRUCT.KEY);
    expect(s.take(node)).toBe(-1);
  });

  it('drops a held symbol on a container end written under its bound', () => {
    const [node, item] = [{}, {}];
    const enc = new Encoder();
    const s = session(enc);
    const bound: Bound = { end: STRUCT.ARR_END, allow: true };
    s.marker('self', o).write(enc, STRUCT.STR, node);
    s.marker('self', o).write(enc, STRUCT.ARR_END, item, bound);
    expect(s.take(item)).toBe(-1);
    expect(s.take(node)).toBe(-1);
    s.marker('self', o).write(enc, STRUCT.INT, item, bound);
    expect(s.take(item)).toBe(STRUCT.INT);
  });

  it('refuses a container end its bound excludes, and END under a bound', () => {
    const enc = new Encoder();
    const s = session(enc);
    const marker = s.marker('self', o);
    expect(() =>
      marker.write(enc, STRUCT.ARR_END, {}, { end: STRUCT.ARR_END, allow: false })
    ).toThrow(RangeError);
    expect(() => marker.write(enc, END, {}, { end: STRUCT.ARR_END, allow: true })).toThrow(
      RangeError
    );
    expect(() => marker.write(enc, END)).toThrow(RangeError);
  });

  it('round-trips bounded symbols, held for their targets alike on both sides', () => {
    const list = {};
    const items = [{}, {}, {}];
    const below: Bound = { end: STRUCT.ARR_END, allow: false };
    const after: Bound = { end: STRUCT.ARR_END, allow: true };
    const marks: Mark[] = [
      { sym: STRUCT.ARR_START, target: list },
      { sym: STRUCT.INT, target: items[0], bound: below },
      { sym: STRUCT.STR, target: items[1], bound: below },
      { sym: STRUCT.HINT, target: items[2], bound: after },
      { sym: STRUCT.ARR_END, target: list, bound: after },
    ];
    for (let i = 0; i < 6; i++) tripMarks(marks.concat(marks), (s) => s.enterScope('list', o));
    const enc = new Encoder();
    const se = session(enc);
    const dec = new Decoder(tripMarks(marks));
    const sd = session(dec);
    for (const m of marks) {
      se.marker('self', o).write(enc, m.sym, m.target, m.bound);
      expect(sd.marker('self', o).read(dec, m.target, m.bound)).toBe(m.sym);
      expect(sd.take(m.target!)).toBe(se.take(m.target!));
    }
  });

  it('makes the symbols its prior favours cheaper', () => {
    const prior: MarkerPrior = { key: {}, counts: [[STRUCT.HINT, 5000]] };
    const marks: Mark[] = Array.from({ length: 4 }, () => ({ sym: STRUCT.HINT }));
    const plain = tripMarks(marks).length;
    const primed = tripMarks(marks.map((m) => ({ ...m, prior }))).length;
    expect(primed).toBeLessThan(plain);
  });

  it('loads a prior once per key and population', () => {
    const prior: MarkerPrior = { key: {}, counts: [[STRUCT.HINT, 3]] };
    const twin: MarkerPrior = { key: {}, counts: prior.counts };
    const marks: Mark[] = [STRUCT.HINT, STRUCT.STR, STRUCT.KEY, STRUCT.HINT, STRUCT.INT].map(
      (sym) => ({ sym })
    );
    const bytes = (list: readonly Mark[]) => Array.from(tripMarks(list));
    const once = bytes([{ ...marks[0], prior }, ...marks.slice(1)]);
    expect(bytes(marks.map((m) => ({ ...m, prior })))).toEqual(once);
    expect(
      bytes([{ ...marks[0], prior }, { ...marks[1], prior: twin }, ...marks.slice(2)])
    ).not.toEqual(once);
  });

  it('loads a prior again in a population of its own', () => {
    const separate = opts({ separate: true });
    const prior: MarkerPrior = { key: {}, counts: [[STRUCT.HINT, 5000]] };
    const code = (load: boolean) => {
      const enc = new Encoder();
      const s = session(enc);
      s.marker('a', separate).write(enc, STRUCT.HINT, undefined, undefined, prior);
      s.marker('b', separate).write(
        enc,
        STRUCT.HINT,
        undefined,
        undefined,
        load ? prior : undefined
      );
      return enc.output().length;
    };
    expect(code(true)).toBeLessThan(code(false));
  });
});
