import { Decoder, Encoder } from '../../packer';
import { ONE, exp2Fix, log2Fix, mulShr } from '../../predictor/arith';
import { casePartnerCp } from '../../predictor/alphabet';
import { resolve } from '../../predictor/options';
import { loadedPriors } from '../../predictor/prior';
import { Session } from '../../predictor/session';
import type { Features, SessionOptions, Sink, Source, Table } from '../../predictor/session';
import {
  APM_EDGE,
  SymbolPredictor,
  closedOf,
  defaultFeatures,
  recOf,
} from '../../predictor/symbols';
import type { Closed } from '../../predictor/symbols';
import { BYTE_BASE, CP_BASE, DIGIT, END, STRUCT } from '../../predictor/types';
import type { CompressOptions, AlphabetKind, Ends, Resolved } from '../../predictor/types';

const OPEN: Ends = { min: 0, max: undefined, fixed: false };
const opts = (o: CompressOptions = {}): Resolved => resolve(o, loadedPriors.text, 'test');

/** Records every coded triple and forwards it to the encoder. */
class RecSink implements Sink {
  readonly calls: number[] = [];
  constructor(private readonly enc: Encoder) {}
  composeWeighted(cum: number, freq: number, total: number): void {
    this.calls.push(cum, freq, total);
    this.enc.composeWeighted(cum, freq, total);
  }
  compose(integer: number, radix: number): void {
    this.calls.push(integer, -1, radix);
    this.enc.compose(integer, radix);
  }
  open(): void {
    this.enc.open();
  }
}

/** Records every read triple. */
class RecSource implements Source {
  readonly calls: number[] = [];
  constructor(private readonly dec: Decoder) {}
  parseMember(total: number, table: Table): number {
    const i = this.dec.parseMember(total, table);
    this.calls.push(table.cum(i), table.freq(i), total);
    return i;
  }
  parse(radix: number): number {
    const v = this.dec.parse(radix);
    this.calls.push(v, -1, radix);
    return v;
  }
  get idle(): bigint {
    return this.dec.idle;
  }
}

const cps = (s: string): Int32Array => Int32Array.from(s, (ch) => ch.codePointAt(0)!);

interface Trip {
  options?: SessionOptions;
  o?: Resolved;
  alphabet?: AlphabetKind;
  ends?: Ends;
  step?: boolean;
  setup?: (s: Session) => void;
}

/** Encodes the values at one path, decodes them, checks the values and the coded triples; returns the bytes. */
function trip(values: readonly Int32Array[], t: Trip = {}): Uint8Array {
  const o = t.o ?? opts();
  const alphabet = t.alphabet ?? 'text';
  const ends = t.ends ?? OPEN;
  const coder = (s: Session) =>
    t.step === false ? s.text('p', o, alphabet) : s.string('p', o, alphabet);
  const enc = new Encoder();
  const sink = new RecSink(enc);
  const se = new Session(t.options);
  se.symbols('p', o, alphabet);
  t.setup?.(se);
  for (const v of values) coder(se).write(sink, v, v.length, ends);
  const bytes = enc.output();
  const dec = new Decoder(bytes);
  const source = new RecSource(dec);
  const sd = new Session(t.options);
  sd.symbols('p', o, alphabet);
  t.setup?.(sd);
  for (const v of values) expect(Array.from(coder(sd).read(source, ends))).toEqual(Array.from(v));
  dec.finalize();
  expect(source.calls).toEqual(sink.calls);
  return bytes;
}

const PROSE =
  'The quick brown fox jumps over the lazy dog. A journey of a thousand miles begins with a ' +
  'single step, and the first step is often the hardest one to take. In 1969, 3 astronauts ' +
  'flew to the Moon; 2 of them walked on it.\nThe rest stayed in orbit.\n';

function rnd(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** A text of `n` symbols made of PROSE with deterministic variations. */
function variedText(n: number, seed = 1): Int32Array {
  const r = rnd(seed);
  let s = '';
  while (s.length < n) {
    const words = PROSE.split(' ');
    for (const w of words) {
      s += (r() < 0.1 ? w.toUpperCase() : r() < 0.1 ? `${w}${Math.floor(r() * 100)}` : w) + ' ';
    }
  }
  return cps(s.slice(0, n));
}

describe('APM_EDGE', () => {
  it('holds the PB shares of the logistic at equal steps of [-8, 8]', () => {
    for (let i = 0; i < 24; i++) {
      const x = -8 + (16 * i) / 23;
      expect(APM_EDGE[i]).toBe(Math.round(65536 / (1 + Math.exp(-x))));
    }
  });
});

describe('recOf', () => {
  it('takes four bits of age per bucket up to 4', () => {
    const cases: [number, number][] = [
      [1, 0],
      [15, 0],
      [16, 1],
      [255, 1],
      [256, 2],
      [4095, 2],
      [4096, 3],
      [65535, 3],
      [65536, 4],
      [2 ** 40, 4],
    ];
    for (const [age, bucket] of cases) {
      expect(recOf(age)).toBe(bucket);
      expect(recOf(age)).toBe(Math.min(4, (31 - Math.clz32(Math.min(age, 2 ** 31))) >> 2));
    }
  });
});

describe('defaultFeatures', () => {
  it('turns every part on but the value sequence cells', () => {
    const f = defaultFeatures();
    for (const [k, v] of Object.entries(f)) expect(v).toBe(k !== 'valueSequence');
  });
});

describe('SymbolPredictor round trips', () => {
  it('codes short strings and the empty string', () => {
    trip(['', 'a', 'ab', 'Hello, World!', 'hello, world!', ''].map(cps));
  });

  it('codes a 5 kB text with digits, newlines and case variants', () => {
    const bytes = trip([variedText(5000)]);
    expect(bytes.length).toBeLessThan(5000 * 0.5);
  });

  it('codes random code points with surrogates, emoji and every band', () => {
    const r = rnd(7);
    const v: number[] = [];
    for (let i = 0; i < 400; i++) {
      const band = r();
      v.push(
        band < 0.3
          ? Math.floor(r() * 128)
          : band < 0.5
            ? 128 + Math.floor(r() * 1920)
            : band < 0.6
              ? 0xd800 + Math.floor(r() * 2048)
              : band < 0.8
                ? 0x1f600 + Math.floor(r() * 80)
                : 0x800 + Math.floor(r() * 0x10f000)
      );
    }
    trip([Int32Array.from(v), Int32Array.from(v.slice(0, 50))]);
  });

  it('codes the byte alphabet with every value, then rejects a symbol outside it', () => {
    const r = rnd(3);
    const all = Int32Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    trip([Int32Array.of(2, 1, 2, 1), Int32Array.of(1, 2), all, all.slice(0, 40), Int32Array.of()], {
      alphabet: 'bytes',
    });
    const s = new Session();
    const o = opts();
    const pred = s.symbols('b', o, 'bytes');
    const enc = new Encoder();
    for (let b = 0; b < 256; b++) pred.code(enc, s.ids.byteId(b));
    pred.code(enc, END);
    pred.distribution();
    expect(pred.dist.hasEscape).toBe(false);
    expect(() => pred.write(enc, CP_BASE)).toThrow(RangeError);
  });

  it('codes structure ids as a closed alphabet, with and without END', () => {
    const o = opts();
    const values = [
      Int32Array.of(STRUCT.OBJ_START, STRUCT.KEY, STRUCT.STR, STRUCT.OBJ_END),
      Int32Array.from({ length: 35 }, (_, i) => 35 - i),
      Int32Array.of(STRUCT.HINT, STRUCT.TRUE),
    ];
    trip(values, { alphabet: 'structure', o, ends: { min: 2, max: undefined, fixed: false } });
    trip(values.slice(0, 1), { alphabet: 'structure', o, ends: { min: 4, max: 4, fixed: true } });
  });

  it('keeps the decoder in step through text and structure predictors sharing the message', () => {
    const o = opts();
    const enc = new Encoder();
    const sink = new RecSink(enc);
    const se = new Session();
    const st = se.symbols('s', o, 'structure');
    const words = ['alpha', 'beta', 'alpha', 'gamma'];
    for (const w of words) {
      st.code(sink, STRUCT.STR);
      se.text('t', o, 'text').write(sink, cps(w), w.length, OPEN);
    }
    st.code(sink, END);
    const dec = new Decoder(enc.output());
    const source = new RecSource(dec);
    const sd = new Session();
    const sr = sd.symbols('s', o, 'structure');
    for (const w of words) {
      expect(sr.decode(source)).toBe(STRUCT.STR);
      expect(Array.from(sd.text('t', o, 'text').read(source, OPEN))).toEqual(Array.from(cps(w)));
    }
    expect(sr.decode(source)).toBe(END);
    expect(source.calls).toEqual(sink.calls);
  });

  it('holds under every feature switched off one at a time, and all at once', () => {
    const text = [variedText(700, 5), variedText(300, 5), variedText(700, 5)];
    const names = Object.keys(defaultFeatures()) as (keyof Features)[];
    for (const name of names) {
      trip(text, { options: { features: { [name]: name === 'valueSequence' } } });
    }
    const off: Partial<Features> = {};
    for (const name of names) off[name] = false;
    trip(text, { options: { features: off } });
  });

  it('starts the value population at the second value under valueFromSecond', () => {
    const a = trip([variedText(400, 2), variedText(400, 3)], {
      options: { valueFromSecond: true },
    });
    const b = trip([variedText(400, 2), variedText(400, 3)]);
    expect(a).not.toEqual(b);
  });

  it('keeps a separate path out of the message population', () => {
    const o = opts({ separate: true });
    trip([variedText(600, 4), variedText(600, 4)], { o });
  });

  it('halves counts under a window and keeps the decoder in step', () => {
    const v = cps('abcabcabdabcabcabd'.repeat(30).slice(0, 500));
    trip([v], { o: opts({ window: 64 }) });
    trip([cps('the cat sat on the mat, '.repeat(40))], { o: opts({ window: 16, candidates: 64 }) });
  });

  it('counts long runs past the small-count table', () => {
    trip([cps('a'.repeat(4500) + 'b')], { o: opts({ candidates: 0, offsets: 0 }) });
  });

  it('drops the smallest candidates into the escape under a small quantisation', () => {
    const letters: number[] = [];
    for (let cp = 0x100; letters.length < 1100; cp++) {
      const p = casePartnerCp(cp);
      if (p >= 0 && String.fromCodePoint(cp).toLowerCase() === String.fromCodePoint(cp)) {
        letters.push(cp);
      }
    }
    const o = opts({ quantisation: 4096 });
    trip([Int32Array.from(letters), Int32Array.from(letters.slice(0, 300).reverse())], {
      o,
      options: { features: { tree: false } },
    });
  });

  it('codes when every mass floors to zero and the escape alone is large', () => {
    trip([cps('aab ba'), cps('ab')], {
      setup: (s) => {
        s.space(loadedPriors.text).run.hybrid.fill(-40 * ONE);
      },
    });
  });

  it('takes an implied symbol into the populations without learning', () => {
    const o = opts();
    const s = new Session();
    const pred = s.symbols('p', o, 'text');
    const space = s.space(o.prior);
    const run = space.run;
    const snap = (): unknown => [
      run.escape,
      ...[run.kernel, run.hybrid, run.apm, run.pnov, run.vfeat, run.lev, run.logn].map((x) =>
        Array.from(x)
      ),
    ];
    const before = snap();
    const t0 = pred.context().t;
    const a = s.ids.idOf(0x61);
    pred.beginValue();
    pred.implied(a);
    pred.implied(a);
    pred.endValue();
    expect(space.n).toBe(2);
    expect(space.seen[a]).toBe(1);
    expect(space.distinct).toBe(1);
    expect(pred.context().t).toBe(t0 + 2);
    expect(snap()).toEqual(before);
  });
});

describe('SymbolPredictor tables', () => {
  function stepped(text: string, alphabet: AlphabetKind = 'text'): [Session, SymbolPredictor] {
    const s = new Session();
    const pred = s.symbols('p', opts(), alphabet);
    const enc = new Encoder();
    pred.beginValue();
    for (const ch of text) {
      pred.distribution();
      const a = s.ids.idOf(ch.codePointAt(0)!);
      pred.write(enc, a);
      pred.learn(a);
    }
    return [s, pred];
  }

  it('lists the entries by id with the escape last and sums to the quantisation', () => {
    const [s, pred] = stepped('Hello there, 42 times.\n');
    const d = pred.distribution();
    expect(d.hasEscape).toBe(true);
    expect(d.idAt(d.n - 1)).toBe(-1);
    for (let i = 1; i < d.n - 1; i++) expect(d.idAt(i)).toBeGreaterThan(d.idAt(i - 1));
    let sum = 0;
    for (let i = 0; i < d.n; i++) sum += d.freq(i);
    expect(sum).toBe(65536);
    // The kernel candidates: case partners, the boundary trio and the ten digits.
    expect(d.indexOf(s.ids.idOf(0x68))).toBeGreaterThanOrEqual(0);
    expect(d.indexOf(s.ids.idOf(0x48))).toBeGreaterThanOrEqual(0);
    for (const id of s.ids.digitIds()) expect(d.indexOf(id)).toBeGreaterThanOrEqual(0);
    for (const id of s.ids.boundaryIds()) expect(d.indexOf(id)).toBeGreaterThanOrEqual(0);
    pred.learn(END);
  });

  it('smears a voted id from its kept classes and an unvoted one from the ids', () => {
    const [s, pred] = stepped('Hello there, 42 times.\n');
    pred.distribution();
    const p = pred as unknown as {
      smear(id: number): number;
      vStamp: Int32Array;
      V: Float64Array;
      stepNo: number;
      lc: number;
      lb: number;
      ld: number;
      Bsum: number;
      Dsum: number;
    };
    const ids = s.ids;
    const vOf = (id: number): number => (p.vStamp[id] === p.stepNo ? p.V[id] : 0);
    const plain = (id: number): number => {
      let P = vOf(id);
      const q = ids.partner(id);
      if (q >= 0) P += mulShr(vOf(q), p.lc, 24);
      if (ids.isBoundaryClass(id)) P += mulShr(p.Bsum - vOf(id), p.lb, 24);
      if (ids.isDigit(id)) P += mulShr(p.Dsum - vOf(id), p.ld, 24);
      return P;
    };
    const probe = [...ids.digitIds(), ...ids.boundaryIds(), ids.idOf(0x48), ids.idOf(0x65)];
    for (const id of probe) {
      expect(p.vStamp[id]).toBe(p.stepNo);
      expect(p.smear(id)).toBe(plain(id));
      p.vStamp[id] = -1;
      expect(p.smear(id)).toBe(plain(id));
      p.vStamp[id] = p.stepNo;
    }
    pred.learn(END);
  });

  it('leaves END out below the minimum', () => {
    const [, pred] = stepped('abc');
    const d = pred.distribution(false);
    expect(d.indexOf(END)).toBe(-1);
    pred.learn(END);
  });

  it("shares one memo and step counter between a message's predictors", () => {
    const s = new Session();
    const o = opts();
    const a = s.symbols('a', o, 'text');
    const space = s.space(o.prior);
    const memo = space.memo;
    expect(memo.length).toBeGreaterThan(0);
    const b = s.symbols('b', o, 'bytes');
    expect(space.memo).toBe(memo);
    a.distribution();
    expect(space.stepNo).toBe(1);
    b.distribution();
    expect(space.stepNo).toBe(2);
    b.learn(END);
    a.learn(END);
  });

  it('gives exact-level counts that sum to the order-0 count per population', () => {
    const [s, pred] = stepped('abracadabra abracadabra');
    pred.distribution();
    const log = pred.log;
    const a = s.ids.idOf(0x61);
    const per = new Map<number, number>();
    for (let g = 0; g < log.segs; g++) {
      const src = log.src[g];
      for (let i = log.start[g]; i < log.end[g]; i++) {
        expect(log.count[i]).toBeGreaterThanOrEqual(0);
        if (log.sym[i] === a) per.set(src, (per.get(src) ?? 0) + log.count[i]);
      }
    }
    // msg, node and value saw 10 'a's; the folded twins as well.
    expect(per.get(1)).toBe(10);
    expect(per.get(0)).toBe(10);
    expect(per.get(5)).toBe(10);
    pred.learn(a);
  });

  it('splits the folded digit and END votes by the message counts', () => {
    const [s, pred] = stepped('a1a1a1a2a\na');
    pred.distribution();
    const log = pred.log;
    let folded = 0;
    for (let g = 0; g < log.segs; g++) {
      for (let i = log.start[g]; i < log.end[g]; i++) {
        if ((log.src[g] === 5 || log.src[g] === 6) && log.sym[i] === DIGIT) folded++;
      }
    }
    expect(folded).toBeGreaterThan(0);
    const one = s.ids.idOf(0x31);
    pred.learn(one);
    pred.distribution();
    pred.learn(s.ids.newlineId());
    pred.distribution();
    pred.learn(END);
  });

  it('prices a novel symbol through the escape', () => {
    const [s, pred] = stepped('aaaa');
    pred.distribution();
    const z = s.ids.idOf(0x4e00);
    expect(pred.dist.indexOf(z)).toBe(-1);
    pred.learn(z);
    expect(pred.log.novel).toBe(true);
    expect(s.space(loadedPriors.text).seen[z]).toBe(1);
  });

  it('matches exp2Fix and log2Fix in the log masses of a single vote', () => {
    const [, pred] = stepped('x');
    pred.distribution();
    const log = pred.log;
    for (let i = 0; i < log.n; i++) {
      if (log.count[i] > 0 && log.massLearn[i] > 0) {
        expect(log.massLearn[i]).toBeLessThanOrEqual(exp2Fix(36 * ONE));
        expect(log2Fix(log.count[i])).toBeGreaterThanOrEqual(0);
      }
    }
    pred.learn(END);
  });

  it('breaks top ties toward the lowest id', () => {
    // Either order leaves the two bytes tied before the confidence map, which rescales the top
    // alone: the same top, the lower id, gives the same difference.
    const diffs: number[] = [];
    for (const order of [
      [2, 1],
      [1, 2],
    ]) {
      const s = new Session();
      const pred = s.symbols('b', opts(), 'bytes');
      const enc = new Encoder();
      for (const b of order) pred.code(enc, BYTE_BASE + b);
      pred.distribution();
      const d = pred.dist;
      diffs.push(d.freq(d.indexOf(BYTE_BASE + 1)) - d.freq(d.indexOf(BYTE_BASE + 2)));
      pred.learn(BYTE_BASE + 1);
    }
    expect(diffs[0]).not.toBe(0);
    expect(diffs[1]).toBe(diffs[0]);
  });
});

describe('closedOf', () => {
  it('marks every id of the alphabet and no other', () => {
    const c = closedOf(Int32Array.of(5, 2, 9));
    expect(Array.from(c.ids)).toEqual([5, 2, 9]);
    expect(Array.from(c.mask)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 0, 1]);
    expect(Array.from(closedOf(new Int32Array(0)).mask)).toEqual([0]);
  });
});

describe('SymbolPredictor container ends', () => {
  /**
   * A structure step: the symbol, whether its container may end here, that container's end, and
   * the step's closed alphabet.
   */
  type Step = [sym: number, allow: boolean, end: number, only?: Closed];

  /** Codes the steps through one structure predictor, decodes them, compares symbols and triples. */
  function steps(list: readonly Step[]): number {
    const o = opts();
    const enc = new Encoder();
    const sink = new RecSink(enc);
    const pe = new Session().symbols('s', o, 'structure');
    for (const [sym, allow, end, only] of list) pe.code(sink, sym, allow, end, only ?? null);
    const bytes = enc.output();
    const dec = new Decoder(bytes);
    const source = new RecSource(dec);
    const pd = new Session().symbols('s', o, 'structure');
    expect(list.map(([, allow, end, only]) => pd.decode(source, allow, end, only ?? null))).toEqual(
      list.map(([sym]) => sym)
    );
    dec.finalize();
    expect(source.calls).toEqual(sink.calls);
    return bytes.length;
  }

  const IDS = Array.from({ length: STRUCT.HINT }, (_, i) => i + 1);

  it('leaves out an end that may not come yet, and END whenever another end is bound', () => {
    const pred = new Session().symbols('s', opts(), 'structure');
    const enc = new Encoder();
    for (const allow of [false, true]) {
      const d = pred.distribution(allow, STRUCT.ARR_END);
      expect(d.indexOf(END)).toBe(-1);
      expect(() => pred.write(enc, END)).toThrow(RangeError);
    }
    pred.distribution(false, STRUCT.ARR_END);
    expect(pred.dist.indexOf(STRUCT.ARR_END)).toBe(-1);
    expect(() => pred.write(enc, STRUCT.ARR_END)).toThrow(RangeError);
  });

  it.each([
    ['excluded', false],
    ['allowed', true],
  ])('escapes each structure id by its rank with the end %s', (_name, allow) => {
    for (const end of [STRUCT.OBJ_START, STRUCT.ARR_END, STRUCT.HINT]) {
      for (const sym of IDS) {
        if (allow || sym !== end) steps([[sym, allow, end]]);
      }
    }
  });

  it('codes a run of containers whose items may end once there are two', () => {
    const list: Step[] = [];
    for (let n = 0; n < 12; n++) {
      list.push([STRUCT.ARR_START, true, END]);
      for (let k = 0; k < 2 + (n % 3); k++) {
        list.push([k % 2 ? STRUCT.STR : STRUCT.INT + (n % 5), k >= 2, STRUCT.ARR_END]);
      }
      list.push([STRUCT.ARR_END, true, STRUCT.ARR_END]);
    }
    steps(list);
  });

  it("chooses among a step's closed alphabet, with its end only where the end may come", () => {
    const pair = closedOf(Int32Array.of(STRUCT.TRUE, STRUCT.FALSE));
    const withEnd = closedOf(Int32Array.of(STRUCT.TRUE, STRUCT.FALSE, STRUCT.ARR_END));
    const pred = new Session().symbols('s', opts(), 'structure');
    const enc = new Encoder();
    let d = pred.distribution(false, STRUCT.ARR_END, pair);
    expect(d.n).toBeLessThanOrEqual(3);
    expect(d.indexOf(STRUCT.STR)).toBe(-1);
    expect(() => pred.write(enc, STRUCT.STR)).toThrow(RangeError);
    expect(() => pred.write(enc, STRUCT.ARR_END)).toThrow(RangeError);
    d = pred.distribution(true, STRUCT.ARR_END, withEnd);
    expect(d.indexOf(STRUCT.STR)).toBe(-1);
    pred.write(enc, STRUCT.ARR_END);
    d = pred.distribution(false, END, pair);
    expect(d.indexOf(END)).toBe(-1);
  });

  it('codes each member of a closed step, voted or escaped, cheaper than the open alphabet', () => {
    const pair = closedOf(Int32Array.of(STRUCT.TRUE, STRUCT.FALSE));
    const withEnd = closedOf(Int32Array.of(STRUCT.TRUE, STRUCT.FALSE, STRUCT.ARR_END));
    for (const sym of [STRUCT.TRUE, STRUCT.FALSE]) {
      steps([[sym, false, STRUCT.ARR_END, pair]]);
      steps([[sym, false, END, pair]]);
      steps([[sym, true, STRUCT.ARR_END, withEnd]]);
    }
    steps([[STRUCT.ARR_END, true, STRUCT.ARR_END, withEnd]]);
    const list: Step[] = [];
    for (let n = 0; n < 40; n++) {
      list.push([
        n % 5 ? STRUCT.TRUE : STRUCT.FALSE,
        n > 0,
        STRUCT.ARR_END,
        n > 0 ? withEnd : pair,
      ]);
    }
    list.push([STRUCT.ARR_END, true, STRUCT.ARR_END, withEnd]);
    const open = list.map(([sym, allow, end]): Step => [sym, allow, end]);
    expect(steps(list)).toBeLessThan(steps(open));
  });
});
