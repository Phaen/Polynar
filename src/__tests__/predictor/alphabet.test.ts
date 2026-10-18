import { Ids, casePartnerCp, isLetterOrNumberCp } from '../../predictor/alphabet';
import { CASE_PAIRS, CASE_PAIRS_BY_UPPER, LN_RANGES } from '../../predictor/unicode-tables';
import { BYTE_BASE, CP_BASE, DIGIT, END, STRUCT } from '../../predictor/types';
import type { LoadedPrior } from '../../predictor/types';

const priorWith = (symbols: number[]): LoadedPrior =>
  ({ builtinSymbols: symbols }) as unknown as LoadedPrior;

const cp = (s: string): number => s.codePointAt(0)!;

/** The case partner by the engine's own definition, from String.prototype. */
function referencePartner(c: number): number {
  const ch = String.fromCodePoint(c);
  const single = (s: string): number =>
    s.length === (s.codePointAt(0)! > 0xffff ? 2 : 1) ? cp(s) : -1;
  const up = single(ch.toUpperCase());
  if (up >= 0 && up !== c && single(String.fromCodePoint(up).toLowerCase()) === c) return up;
  const lo = single(ch.toLowerCase());
  if (lo >= 0 && lo !== c && single(String.fromCodePoint(lo).toUpperCase()) === c) return lo;
  return -1;
}

const LN = /[\p{L}\p{N}]/u;

function sample(count: number): number[] {
  let s = 12345;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(s % 0x110000);
  }
  return out;
}

describe('fixed ids', () => {
  const ids = new Ids(null);

  it('keeps the contract ids and the byte block', () => {
    expect(ids.cpOf(END)).toBe(-1);
    expect(ids.cpOf(STRUCT.HINT)).toBe(-1);
    expect(ids.cpOf(DIGIT)).toBe(-1);
    expect(ids.byteId(0)).toBe(BYTE_BASE);
    expect(ids.byteId(255)).toBe(CP_BASE - 1);
    expect(ids.cpOf(ids.byteId(0x41))).toBe(0x41);
    expect(ids.cpOf(-1)).toBe(-1);
    expect(ids.cpOf(1e6)).toBe(-1);
  });

  it('rejects bytes outside 0..255', () => {
    expect(() => ids.byteId(-1)).toThrow(RangeError);
    expect(() => ids.byteId(256)).toThrow(RangeError);
    expect(() => ids.byteId(1.5)).toThrow(RangeError);
  });

  it('rejects code points outside 0..0x10FFFF', () => {
    expect(() => ids.idOf(-1)).toThrow(RangeError);
    expect(() => ids.idOf(0x110000)).toThrow(RangeError);
    expect(() => ids.idOf(0.5)).toThrow(RangeError);
    expect(ids.has(-1)).toBe(false);
  });
});

describe('assignment order', () => {
  it('assigns digits, newline and space right after the fixed ids without a prior', () => {
    const ids = new Ids(null);
    expect(Array.from(ids.digitIds())).toEqual(Array.from({ length: 10 }, (_, i) => CP_BASE + i));
    expect(ids.newlineId()).toBe(CP_BASE + 10);
    expect(Array.from(ids.boundaryIds())).toEqual([END, CP_BASE + 10, CP_BASE + 11]);
    expect(ids.size()).toBe(CP_BASE + 12);
    expect(ids.idOf(cp('a'))).toBe(CP_BASE + 12);
    expect(ids.idOf(cp('a'))).toBe(CP_BASE + 12);
    expect(ids.idOf(cp('b'))).toBe(CP_BASE + 13);
    expect(ids.size()).toBe(CP_BASE + 14);
    expect(ids.has(cp('a'))).toBe(true);
    expect(ids.has(cp('z'))).toBe(false);
    expect(ids.cpOf(CP_BASE + 13)).toBe(cp('b'));
  });

  it('seeds a prior first: symbols [97, 98] take 292 and 293', () => {
    const ids = new Ids(priorWith([97, 98]));
    expect(ids.idOf(97)).toBe(292);
    expect(ids.idOf(98)).toBe(293);
    expect(ids.digitIds()[0]).toBe(294);
    expect(ids.digitIds()[9]).toBe(303);
    expect(ids.newlineId()).toBe(304);
    expect(ids.boundaryIds()[2]).toBe(305);
    expect(ids.size()).toBe(306);
  });

  it('reuses a prior symbol that is also a digit, newline or space', () => {
    const ids = new Ids(priorWith([32, 0x35, 10]));
    expect(ids.boundaryIds()[2]).toBe(292);
    expect(ids.digitIds()[5]).toBe(293);
    expect(ids.newlineId()).toBe(294);
    expect(ids.size()).toBe(CP_BASE + 12);
  });

  it('is deterministic for the same sequence of calls', () => {
    const run = (): number[] => {
      const ids = new Ids(priorWith([120]));
      const out = [ids.idOf(cp('Q')), ids.partner(ids.idOf(cp('é'))), ids.idOf(cp('z'))];
      out.push(ids.partner(ids.idOf(cp('Z'))), ids.size());
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('case partners', () => {
  it('assigns the partner lazily and symmetrically', () => {
    const ids = new Ids(null);
    const a = ids.idOf(cp('a'));
    const size = ids.size();
    expect(ids.has(cp('A'))).toBe(false);
    const upper = ids.partner(a);
    expect(upper).toBe(size);
    expect(ids.cpOf(upper)).toBe(cp('A'));
    expect(ids.partner(a)).toBe(upper);
    expect(ids.partner(upper)).toBe(a);
    expect(ids.size()).toBe(size + 1);
  });

  it('pairs Greek, Cyrillic and astral letters', () => {
    const ids = new Ids(null);
    for (const [lo, up] of [
      ['α', 'Α'],
      ['я', 'Я'],
      ['ж', 'Ж'],
      ['\u{10428}', '\u{10400}'],
      ['\u{13a0}', '\u{ab70}'],
    ]) {
      const l = ids.idOf(cp(lo));
      expect(ids.cpOf(ids.partner(l))).toBe(cp(up));
    }
  });

  it('has no partner for ß, fixed ids, bytes, uncased letters and out-of-range ids', () => {
    const ids = new Ids(null);
    expect(ids.partner(ids.idOf(0xdf))).toBe(-1);
    expect(ids.partner(ids.idOf(cp('1')))).toBe(-1);
    expect(ids.partner(ids.idOf(cp('中')))).toBe(-1);
    expect(ids.partner(END)).toBe(-1);
    expect(ids.partner(DIGIT)).toBe(-1);
    expect(ids.partner(ids.byteId(0x61))).toBe(-1);
    expect(ids.partner(ids.size())).toBe(-1);
    expect(ids.partner(-1)).toBe(-1);
  });

  it('keeps answers across table growth', () => {
    const ids = new Ids(null);
    const first = ids.idOf(cp('a'));
    const upper = ids.partner(first);
    for (let c = 0x4e00; c < 0x4e00 + 1500; c++) ids.idOf(c);
    const far = ids.idOf(cp('b'));
    expect(far).toBeGreaterThan(2 * CP_BASE);
    expect(ids.cpOf(ids.partner(far))).toBe(cp('B'));
    expect(ids.partner(first)).toBe(upper);
    const farthest = ids.idOf(0x1f600 - 1);
    expect(ids.partner(farthest)).toBe(-1);
  });

  it('treats lone surrogates as plain code points', () => {
    const ids = new Ids(null);
    const lo = ids.idOf(0xd800);
    const hi = ids.idOf(0xdfff);
    expect(ids.cpOf(lo)).toBe(0xd800);
    expect(ids.partner(lo)).toBe(-1);
    expect(ids.partner(hi)).toBe(-1);
    expect(ids.isBoundary(lo)).toBe(true);
    expect(ids.isBoundary(hi)).toBe(true);
  });
});

describe('classes', () => {
  const ids = new Ids(null);
  const boundary = (c: number | string): boolean =>
    ids.isBoundary(ids.idOf(typeof c === 'string' ? cp(c) : c));

  it('treats letters and numbers as non-boundaries', () => {
    for (const c of ['a', 'Z', 'é', 'ж', '中', '5', '٣', 'ⅷ', '\u{1d7d8}'])
      expect(boundary(c)).toBe(false);
  });

  it('treats punctuation, space, controls, symbols and emoji as boundaries', () => {
    for (const c of ['.', ' ', '\n', '-', '€', '\u{1f600}', '\u{0}', '_'])
      expect(boundary(c)).toBe(true);
  });

  it('answers repeated queries identically', () => {
    const a = ids.idOf(cp('q'));
    expect(ids.isBoundary(a)).toBe(false);
    expect(ids.isBoundary(a)).toBe(false);
    const dot = ids.idOf(cp('!'));
    expect(ids.isBoundary(dot)).toBe(true);
    expect(ids.isBoundary(dot)).toBe(true);
  });

  it('makes END, structure ids, bytes and unknown ids boundaries', () => {
    expect(ids.isBoundary(END)).toBe(true);
    expect(ids.isBoundary(STRUCT.KEY)).toBe(true);
    expect(ids.isBoundary(DIGIT)).toBe(true);
    expect(ids.isBoundary(ids.byteId(0x61))).toBe(true);
    expect(ids.isBoundary(ids.size())).toBe(true);
    expect(ids.isBoundary(-1)).toBe(true);
  });

  it('recognises digits by code point only', () => {
    for (let d = 0; d < 10; d++) expect(ids.isDigit(ids.digitIds()[d])).toBe(true);
    expect(ids.isDigit(ids.idOf(cp('a')))).toBe(false);
    expect(ids.isDigit(ids.idOf(cp('٣')))).toBe(false);
    expect(ids.isDigit(ids.byteId(0x35))).toBe(false);
    expect(ids.isDigit(DIGIT)).toBe(false);
    expect(ids.isDigit(END)).toBe(false);
    expect(ids.isDigit(ids.size())).toBe(false);
  });

  it('recognises the boundary class END, newline and space', () => {
    expect(ids.isBoundaryClass(END)).toBe(true);
    expect(ids.isBoundaryClass(ids.idOf(10))).toBe(true);
    expect(ids.isBoundaryClass(ids.idOf(32))).toBe(true);
    expect(ids.isBoundaryClass(ids.idOf(cp('.')))).toBe(false);
    expect(ids.isBoundaryClass(ids.byteId(10))).toBe(false);
  });

  it('folds digits to DIGIT and END to the newline id', () => {
    for (let d = 0; d < 10; d++) expect(ids.foldDigit(ids.digitIds()[d])).toBe(DIGIT);
    expect(ids.foldDigit(END)).toBe(ids.newlineId());
    const a = ids.idOf(cp('a'));
    expect(ids.foldDigit(a)).toBe(a);
    expect(ids.foldDigit(STRUCT.KEY)).toBe(STRUCT.KEY);
    expect(ids.foldDigit(ids.newlineId())).toBe(ids.newlineId());
  });
});

describe('unicode tables', () => {
  it('are sorted and pair up consistently', () => {
    for (const [table, count] of [
      [CASE_PAIRS, CASE_PAIRS.length],
      [CASE_PAIRS_BY_UPPER, CASE_PAIRS_BY_UPPER.length],
    ] as const) {
      for (let i = 2; i < count; i += 2) expect(table[i]).toBeGreaterThan(table[i - 2]);
    }
    expect(CASE_PAIRS_BY_UPPER.length).toBe(CASE_PAIRS.length);
    for (let i = 0; i < CASE_PAIRS.length; i += 2) {
      expect(casePartnerCp(CASE_PAIRS[i])).toBe(CASE_PAIRS[i + 1]);
      expect(casePartnerCp(CASE_PAIRS[i + 1])).toBe(CASE_PAIRS[i]);
    }
    for (let i = 0; i < LN_RANGES.length; i += 2) {
      expect(LN_RANGES[i + 1]).toBeGreaterThanOrEqual(LN_RANGES[i]);
      if (i > 0) expect(LN_RANGES[i]).toBeGreaterThan(LN_RANGES[i - 1] + 1);
    }
  });

  it('answers known case pairs', () => {
    for (const [lo, up] of [
      [0x61, 0x41],
      [0xe9, 0xc9],
      [0x3b1, 0x391],
      [0x44f, 0x42f],
      [0x10428, 0x10400],
      [0x10d0, 0x1c90],
      [0xab70, 0x13a0],
      [0x13f8, 0x13f0],
    ]) {
      expect(casePartnerCp(lo)).toBe(up);
      expect(casePartnerCp(up)).toBe(lo);
    }
    for (const c of [0xdf, 0x131, 0x17f, 0x1c5, 0x30, 0x4e2d, 0xd800, 0x10ffff, 0, -1]) {
      expect(casePartnerCp(c)).toBe(-1);
    }
  });

  it('answers known letter and number classes', () => {
    for (const c of ['a', 'Z', '0', '9', 'é', 'ж', '中', 'ⅷ', '\u{1d7d8}']) {
      expect(isLetterOrNumberCp(cp(c))).toBe(true);
    }
    for (const c of [0, 0x2f, 0x3a, 0x40, 0x7b, 0xd7, 0xd800, 0x1f600, 0x10ffff, -1]) {
      expect(isLetterOrNumberCp(c)).toBe(false);
    }
  });

  it('agree with String.prototype and the regex on the whole of 0..0x3000', () => {
    for (let c = 0; c < 0x3000; c++) {
      expect(casePartnerCp(c)).toBe(referencePartner(c));
      expect(isLetterOrNumberCp(c)).toBe(LN.test(String.fromCodePoint(c)));
    }
  });

  it('agree with String.prototype and the regex on 20,000 random code points', () => {
    for (const c of sample(20000)) {
      expect(casePartnerCp(c)).toBe(referencePartner(c));
      expect(isLetterOrNumberCp(c)).toBe(LN.test(String.fromCodePoint(c)));
    }
  });

  it('agree on every cased code point', () => {
    for (let i = 0; i < CASE_PAIRS.length; i++) {
      const c = CASE_PAIRS[i];
      expect(referencePartner(c)).toBe(casePartnerCp(c));
    }
  });
});
