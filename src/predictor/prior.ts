/**
 * Loading a `Prior` (spec §7): validation, then expansion of the Int8 tables to RB fixed point and
 * of the two confidence maps' logits to PB-bit probabilities. A loaded prior is immutable and
 * shared by every session that uses it.
 */
import { HB, ONE, PB, POW2, RB, SB, TABLES_DIGEST, clampi, div, exp2Fix, shl } from './arith';
import { json } from './shipped/json';
import { text } from './shipped/text';
import { APM_B, DIGIT, HF, NSRC, levels } from './types';
import type { LoadedPrior, Prior, PriorTable } from './types';

/** Probability bounds of the confidence maps in PB bits (the prototype's 1e−4 floor). */
export const P16_MIN = 4;
export const P16_MAX = 65532;

const MAX_ORDER = 12;
const MAX_CP = 0x10ffff;
const isInt = Number.isSafeInteger;

function check(ok: boolean, field: string, what: string): void {
  if (!ok) throw new TypeError(`invalid prior: ${field} ${what}`);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The integer shape of `constants`: 0 is one integer, k > 0 an array of k integers. */
const CONSTANTS: Shape = {
  eta: 0,
  rho0: 0,
  n0: 0,
  rates: {
    vfeat: 5,
    logn: 0,
    lev: 0,
    apm: 0,
    kernel: 0,
    oscale: 0,
    pnov: 0,
    vstep: 0,
    number: 0,
    step: 0,
  },
  decays: { lev: 0, hit: 0 },
  clamps: {
    cell: 0,
    delta: 0,
    vfeat: 0,
    lev: 0,
    logn: 0,
    oscale: 2,
    vstep: 0,
    number: 0,
    hit: 0,
    range: 0,
  },
  ladder: 3,
};
interface Shape {
  readonly [key: string]: number | Shape;
}

function checkShape(v: unknown, shape: number | Shape, field: string): void {
  if (typeof shape === 'number') {
    if (shape === 0) check(isInt(v), field, 'must be an integer');
    else
      check(
        Array.isArray(v) && v.length === shape && v.every(isInt),
        field,
        `must be ${shape} integers`
      );
    return;
  }
  check(isObject(v), field, 'must be an object');
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(shape)) checkShape(o[key], shape[key], `${field}.${key}`);
}

/** A table's values: data · scale + offset, each data entry an Int8. */
function expand(t: unknown, length: number, field: string): Float64Array {
  check(isObject(t), field, 'must be an object');
  const { scale, offset, data } = t as unknown as PriorTable;
  check(isInt(scale) && scale >= 0, `${field}.scale`, 'must be a non-negative integer');
  check(isInt(offset), `${field}.offset`, 'must be an integer');
  check(
    Array.isArray(data) && data.length === length,
    `${field}.data`,
    `must be an array of ${length}`
  );
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const d = data[i];
    check(isInt(d) && d >= -128 && d <= 127, `${field}.data`, 'must hold integers in -128..127');
    out[i] = d * scale + offset;
    check(isInt(out[i]), `${field}.data`, 'expands beyond 2^53');
  }
  return out;
}

/**
 * The PB-bit probability of a logit `x` in RB bits, 1 / (1 + 2^−x): with A = 2^(x + 20), the
 * floor of A · 2^PB / (A + 2^20), exact given A; x is clamped to ±16 bits so A stays in
 * 2^4..2^36 and A · 2^PB below 2^53. The result is clamped to [P16_MIN, P16_MAX].
 */
export function logitToP16(x: number): number {
  const a = exp2Fix(clampi(x, -16 * ONE, 16 * ONE) + 20 * ONE);
  return clampi(div(shl(a, PB), a + POW2[20]), P16_MIN, P16_MAX);
}

function probabilities(logits: Float64Array): Float64Array {
  for (let i = 0; i < logits.length; i++) logits[i] = logitToP16(logits[i]);
  return logits;
}

function checkBuiltin(b: unknown): Prior['builtin'] {
  check(isObject(b), 'builtin', 'must be an object');
  const { symbols, counts0, contexts1 } = b as unknown as Prior['builtin'];
  check(Array.isArray(symbols), 'builtin.symbols', 'must be an array');
  const known = new Set<number>([-1]);
  for (const s of symbols) {
    check(
      isInt(s) && s >= -1 - (DIGIT - 1) && s <= MAX_CP && s !== -1,
      'builtin.symbols',
      'must hold code points, or structure ids s as -1 - s'
    );
    check(!known.has(s), 'builtin.symbols', `lists ${s} twice`);
    known.add(s);
  }
  check(
    Array.isArray(counts0) && counts0.length === symbols.length + 1,
    'builtin.counts0',
    'must hold one count for END and one per symbol'
  );
  for (const c of counts0) check(isInt(c) && c >= 1, 'builtin.counts0', 'must hold integers >= 1');
  check(Array.isArray(contexts1), 'builtin.contexts1', 'must be an array');
  let prev = -Infinity;
  let next = -Infinity;
  for (const e of contexts1) {
    check(Array.isArray(e) && e.length === 3, 'builtin.contexts1', 'must hold triples');
    const [p, n, c] = e;
    check(known.has(p) && known.has(n), 'builtin.contexts1', 'must refer to listed symbols or -1');
    check(isInt(c) && c >= 1, 'builtin.contexts1', 'must hold counts >= 1');
    check(p > prev || (p === prev && n > next), 'builtin.contexts1', 'must be sorted and unique');
    prev = p;
    next = n;
  }
  return b as Prior['builtin'];
}

/** Validates `p` (TypeError naming the field) and expands its tables. */
export function loadPrior(p: Prior): LoadedPrior {
  check(isObject(p), 'prior', 'must be an object');
  check(p.format === 1, 'format', 'must be 1');
  const order = p.order;
  check(isInt(order) && order >= 1 && order <= MAX_ORDER, 'order', `must be in 1..${MAX_ORDER}`);
  const a = p.arith;
  check(isObject(a), 'arith', 'must be an object');
  check(
    a.RB === RB && a.SB === SB && a.HB === HB && a.PB === PB,
    'arith',
    `must be RB ${RB}, SB ${SB}, HB ${HB}, PB ${PB}`
  );
  check(a.tables === TABLES_DIGEST, 'arith.tables', `must be ${TABLES_DIGEST}`);
  checkShape(p.constants, CONSTANTS, 'constants');
  check(p.constants.n0 >= 1, 'constants.n0', 'must be >= 1');
  check(
    p.constants.ladder.every((w) => w >= 1),
    'constants.ladder',
    'must hold integers >= 1'
  );
  const t = p.tables;
  check(isObject(t), 'tables', 'must be an object');
  const ns = t.numberShared;
  check(isObject(ns), 'tables.numberShared', 'must be an object');
  check(
    p.trainedOn === undefined || typeof p.trainedOn === 'string',
    'trainedOn',
    'must be a string'
  );
  const builtin = checkBuiltin(p.builtin);
  return {
    source: p,
    order,
    constants: p.constants,
    escape: expand(t.escape, 1, 'tables.escape')[0],
    kernel: expand(t.kernel, 3, 'tables.kernel'),
    hybrid: expand(t.hybrid, NSRC * levels(order) * HF, 'tables.hybrid'),
    apm: probabilities(expand(t.apm, 3 * (order + 1) * APM_B, 'tables.apm')),
    pnov: expand(t.pnov, 32, 'tables.pnov'),
    vfeat: expand(t.vfeat, 5, 'tables.vfeat'),
    oscale: expand(t.oscale, 6, 'tables.oscale'),
    lev: expand(t.lev, 5, 'tables.lev'),
    logn: expand(t.logn, NSRC * (order + 1) + 1, 'tables.logn'),
    vstep: expand(t.vstep, 76, 'tables.vstep'),
    numberHit: expand(ns.hit, 12, 'tables.numberShared.hit'),
    numberRange: expand(ns.range, 2, 'tables.numberShared.range'),
    numberConf: probabilities(expand(ns.conf, 5 * APM_B, 'tables.numberShared.conf')),
    numberStart: expand(t.numberStart, 139, 'tables.numberStart'),
    builtinSymbols: builtin.symbols,
    builtinCounts0: builtin.counts0,
    builtinContexts1: builtin.contexts1,
  };
}

const cache = new WeakMap<Prior, LoadedPrior>();

/** `loadPrior` once per `Prior` object. */
export function priorOf(p: Prior): LoadedPrior {
  let loaded = cache.get(p);
  if (!loaded) {
    loaded = loadPrior(p);
    cache.set(p, loaded);
  }
  return loaded;
}

/** The shipped priors, as `.compress({ prior })` and `train`'s `from` take them. */
export const Priors: { readonly text: Prior; readonly json: Prior } = { text, json };

/** The shipped priors, each loaded on first use. */
export const loadedPriors = {
  get text(): LoadedPrior {
    return priorOf(text);
  },
  get json(): LoadedPrior {
    return priorOf(json);
  },
};
