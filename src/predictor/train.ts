/**
 * `train(node, samples, options)` (spec §2.3): a `Prior` made from sample messages by running the
 * real engine over them. The built-in population is counted from the samples; the learned tables
 * are the mean of the run prior at each message start over the last of `epochs` passes, the run
 * prior continuing from one message to the next; with `holdOut` a grid over (η, ρ0, N0) picks the
 * constants by the held-out messages' bytes first. Everything is integer-exact, so the same inputs
 * give the same prior on every engine.
 */

import { PBinary } from '../nodes/binary';
import type { PNode } from '../nodes/base';
import { PString } from '../nodes/string';
import { Encoder } from '../packer';
import { PB, POW2, div, log2Fix } from './arith';
import { loadedPriors, priorOf } from './prior';
import { session } from './session';
import type { Trace } from './session';
import { END } from './types';
import type { LoadedPrior, Prior, PriorConstants, PriorTable, RunPrior } from './types';
import { newRunPrior, rdiv } from './weights';

export interface TrainOptions {
  /** The fraction of samples held out for the grid over η, ρ0 and N0; 0 keeps `from`'s constants. */
  readonly holdOut?: number;
  /** The prior whose tables and constants the passes start from. */
  readonly from?: Prior;
  /** Passes over the samples. */
  readonly epochs?: number;
  /** The order of the samples in the passes and the held-out split. */
  readonly seed?: number;
  /** The grid's values per axis in the units of `Prior.constants`; each defaults to the spec's list. */
  readonly grid?: Grid;
}

export interface Grid {
  readonly eta?: readonly number[];
  readonly rho0?: readonly number[];
  readonly n0?: readonly number[];
}

/**
 * The grid (spec §2.3) in RB: η 0.03, 0.1 and 0.3 natural-log units as bits (× log2 e, rounded),
 * ρ0 0.25, 0.5, 1 and 2; N0 in values.
 */
const ETAS = [726132, 2420441, 7261322];
const RHOS = [4194304, 8388608, 16777216, 33554432];
const NS = [256, 1024, 4096];

const P_ONE = POW2[PB];

/**
 * The order-1 triples a trained built-in keeps, the most frequent first (spec Q3's size budget; the
 * research measured no gain beyond this scale).
 */
export const MAX_CONTEXTS = 2500;

/** (prev, next) order; the stable count sort keeps it among equal counts. */
const byPair = (a: readonly number[], b: readonly number[]): number => a[0] - b[0] || a[1] - b[1];

/** The run prior's learned tables, by their names in `RunPrior`. */
const LEARNED = [
  'kernel',
  'hybrid',
  'apm',
  'pnov',
  'vfeat',
  'lev',
  'logn',
  'vstep',
  'numberHit',
  'numberRange',
  'numberConf',
] as const;
type Learned = (typeof LEARNED)[number];

/** The tables a run prior holds as PB probabilities; the prior stores their logits. */
const PROBABILITY: ReadonlySet<Learned> = new Set(['apm', 'numberConf']);

/** The Park–Miller generator's modulus; every product below stays under 2^47. */
const PM = 2147483647;

/** The sample order of a seed: a Fisher–Yates shuffle driven by Park–Miller. */
function permutation(n: number, seed: number): number[] {
  let state = (((seed % (PM - 1)) + PM - 1) % (PM - 1)) + 1;
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    state = (state * 48271) % PM;
    const j = state % (i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

/** A PB probability as a logit in RB bits. */
const logit = (p: number): number => log2Fix(p) - log2Fix(P_ONE - p);

/**
 * Int8 quantisation of integer RB values (the converter's rule): the scale is the smallest integer
 * that spans the range in 255 steps from the minimum, value = data · scale + offset.
 */
export function quantise(values: readonly number[]): PriorTable {
  let min = values[0];
  let max = values[0];
  for (const x of values) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const scale = Math.max(1, div(max - min + 254, 255));
  // (x − min) / scale rounds to at most 255, so every entry is in −128..127.
  const data = values.map((x) => rdiv(x - min, scale) - 128);
  return { scale, offset: min + 128 * scale, data };
}

/** The sum of a run prior's learned tables over message starts, in the log domain. */
class Snapshots {
  n = 0;
  escape = 0;
  readonly sums: Record<Learned, Float64Array>;

  constructor(run: RunPrior) {
    this.sums = {} as Record<Learned, Float64Array>;
    for (const k of LEARNED) this.sums[k] = new Float64Array(run[k].length);
  }

  add(run: RunPrior): void {
    this.n++;
    this.escape += run.escape;
    for (const k of LEARNED) {
      const sum = this.sums[k];
      const t = run[k];
      if (PROBABILITY.has(k)) for (let i = 0; i < t.length; i++) sum[i] += logit(t[i]);
      else for (let i = 0; i < t.length; i++) sum[i] += t[i];
    }
  }

  /** The mean of table `k`, rounded to the nearest integer. */
  mean(k: Learned | 'escape'): PriorTable {
    const sum = k === 'escape' ? [this.escape] : this.sums[k];
    return quantise(Array.from(sum, (x) => rdiv(x, this.n)));
  }
}

/**
 * `from` with the grid's (η, ρ0, N0) and the rates the converter derives from η, except the number
 * predictor's, which stays `from`'s: string samples never reach it, so their grid cannot price it.
 */
function constantsOf(from: PriorConstants, eta: number, rho0: number, n0: number): PriorConstants {
  return {
    ...from,
    eta,
    rho0,
    n0,
    rates: {
      ...from.rates,
      vfeat: [eta, div(eta, 9), div(eta, 16), eta, div(eta, 9)],
      logn: div(eta, 256),
      lev: eta,
      kernel: eta,
      pnov: eta,
      vstep: eta,
    },
  };
}

/** Encodes one message under `run` (which learns from it) and returns its bytes. */
function encode<T>(node: PNode<T>, value: T, run: RunPrior, trace?: Trace): number {
  const enc = new Encoder();
  session(enc, { carry: run, trace });
  node._write(enc, value);
  return enc.output().length;
}

/**
 * The built-in population of the samples (spec §7): every symbol of the text and structure
 * alphabets in coding order, END closing every value and every message, structure id s as −1 − s;
 * symbols in order of first occurrence, order-0 counts with END's first, the `MAX_CONTEXTS`
 * most frequent order-1 counts sorted by (prev, next).
 */
function population<T>(node: PNode<T>, samples: readonly T[], from: LoadedPrior): Prior['builtin'] {
  const symbols: number[] = [];
  const counts = new Map<number, number>([[-1, 0]]);
  const pairs = new Map<string, [number, number, number]>();
  let prev = -1;
  const push = (s: number): void => {
    const c = counts.get(s);
    if (c === undefined) symbols.push(s);
    counts.set(s, (c ?? 0) + 1);
    const key = `${prev},${s}`;
    const e = pairs.get(key);
    if (e !== undefined) e[2]++;
    else pairs.set(key, [prev, s, 1]);
    prev = s;
  };
  for (const v of samples) {
    const enc = new Encoder();
    const s = session(enc, {
      carry: newRunPrior(from),
      trace: (id, alphabet) => {
        if (alphabet === 'bytes') return;
        push(id === END ? -1 : alphabet === 'structure' ? -1 - id : s.ids.cpOf(id));
      },
    });
    node._write(enc, v);
    if (prev !== -1) push(-1);
  }
  return {
    symbols,
    counts0: [
      Math.max(1, counts.get(-1) as number),
      ...symbols.map((x) => counts.get(x) as number),
    ],
    contexts1: [...pairs.values()]
      .sort(byPair)
      .sort((a, b) => b[2] - a[2])
      .slice(0, MAX_CONTEXTS)
      .sort(byPair),
  };
}

/** The starting prior of the passes: `from`'s tables under `constants`, with `builtin`. */
function start(from: Prior, constants: PriorConstants, builtin: Prior['builtin']): Prior {
  return {
    format: from.format,
    order: from.order,
    arith: from.arith,
    constants,
    tables: from.tables,
    builtin,
  };
}

/**
 * `epochs` passes over `samples` from `base`, the run prior carried from message to message; the
 * prior of the mean at the last pass's message starts. `numberStart` stays `base`'s.
 */
function passes<T>(
  node: PNode<T>,
  samples: readonly T[],
  base: Prior,
  epochs: number,
  log: (line: string) => void
): Prior {
  const run = newRunPrior(priorOf(base));
  const snaps = new Snapshots(run);
  for (let ep = 0; ep < epochs; ep++) {
    const t0 = performance.now();
    const last = ep === epochs - 1;
    for (const v of samples) {
      if (last) snaps.add(run);
      encode(node, v, run);
    }
    log(`pass ${ep + 1}/${epochs}: ${samples.length} messages, ${ms(t0)}`);
  }
  return {
    ...base,
    tables: {
      escape: snaps.mean('escape'),
      kernel: snaps.mean('kernel'),
      hybrid: snaps.mean('hybrid'),
      apm: snaps.mean('apm'),
      pnov: snaps.mean('pnov'),
      vfeat: snaps.mean('vfeat'),
      lev: snaps.mean('lev'),
      logn: snaps.mean('logn'),
      vstep: snaps.mean('vstep'),
      numberShared: {
        hit: snaps.mean('numberHit'),
        range: snaps.mean('numberRange'),
        conf: snaps.mean('numberConf'),
      },
      numberStart: base.tables.numberStart,
    },
  };
}

const ms = (t0: number): string => `${(performance.now() - t0).toFixed(0)}ms`;

/** The bytes of `samples`, each its own message under `prior`. */
function price<T>(node: PNode<T>, samples: readonly T[], prior: Prior): number {
  const loaded = priorOf(prior);
  let bytes = 0;
  for (const v of samples) bytes += encode(node, v, newRunPrior(loaded));
  return bytes;
}

/** A grid axis: the given values, each a positive integer, or the spec's list. */
function axis(
  values: readonly number[] | undefined,
  name: string,
  spec: number[]
): readonly number[] {
  if (values === undefined) return spec;
  if (values.length === 0) throw new RangeError(`train: grid.${name} must hold a value`);
  for (const v of values) {
    if (!Number.isSafeInteger(v)) {
      throw new TypeError(`train: grid.${name} must hold integers, got ${v}`);
    }
    if (v < 1) throw new RangeError(`train: grid.${name} must hold values of at least 1, got ${v}`);
  }
  return values;
}

function checkOptions(n: number, options: TrainOptions): Required<Omit<TrainOptions, 'from'>> {
  const { holdOut = 0.5, epochs = 3, seed = 1, grid = {} } = options;
  if (typeof holdOut !== 'number' || Number.isNaN(holdOut)) {
    throw new TypeError(`train: holdOut must be a number, got ${holdOut}`);
  }
  if (holdOut < 0 || holdOut >= 1) {
    throw new RangeError(`train: holdOut must be at least 0 and below 1, got ${holdOut}`);
  }
  if (!Number.isSafeInteger(epochs)) {
    throw new TypeError(`train: epochs must be an integer, got ${epochs}`);
  }
  if (epochs < 1) throw new RangeError(`train: epochs must be at least 1, got ${epochs}`);
  if (!Number.isSafeInteger(seed))
    throw new TypeError(`train: seed must be an integer, got ${seed}`);
  if (n === 0) throw new RangeError('train: samples must hold at least one message');
  if (holdOut > 0 && n < 2) {
    throw new RangeError('train: a held-out grid needs at least two samples');
  }
  return {
    holdOut,
    epochs,
    seed,
    grid: {
      eta: axis(grid.eta, 'eta', ETAS),
      rho0: axis(grid.rho0, 'rho0', RHOS),
      n0: axis(grid.n0, 'n0', NS),
    },
  };
}

/** The shipped prior a node starts from: the text prior for strings and binaries, else JSON. */
function shippedFor(node: PNode<any>): Prior {
  return node instanceof PString || node instanceof PBinary
    ? loadedPriors.text.source
    : loadedPriors.json.source;
}

/**
 * `train` with a progress line per pass and per grid triple (scripts/train-priors.ts reads
 * them).
 */
export function trainLogged<T>(
  node: PNode<T>,
  samples: readonly T[],
  options: TrainOptions,
  log: (line: string) => void
): Prior {
  if (!node._holdsCompress) {
    throw new TypeError('train: the node has no .compress() anywhere in its tree');
  }
  const { holdOut, epochs, seed, grid } = checkOptions(samples.length, options);
  const from = options.from ?? shippedFor(node);
  const loaded = priorOf(from);
  const order = permutation(samples.length, seed).map((i) => samples[i]);
  let constants = from.constants;
  if (holdOut > 0) {
    // n · holdOut is one correctly rounded product, the same on every engine; k rounds it.
    const k = Math.min(samples.length - 1, Math.max(1, div(2 * samples.length * holdOut + 1, 2)));
    const held = order.slice(0, k);
    const rest = order.slice(k);
    // The held-out messages stay out of the grid's built-in too.
    const half = population(node, rest, loaded);
    let best = Infinity;
    for (const eta of grid.eta as readonly number[]) {
      for (const rho of grid.rho0 as readonly number[]) {
        for (const n0 of grid.n0 as readonly number[]) {
          const t0 = performance.now();
          const c = constantsOf(from.constants, eta, rho, n0);
          const bytes = price(node, held, passes(node, rest, start(from, c, half), epochs, log));
          log(`grid eta=${eta} rho0=${rho} n0=${n0}: ${bytes} bytes held out, ${ms(t0)}`);
          if (bytes < best) {
            best = bytes;
            constants = c;
          }
        }
      }
    }
  }
  const builtin = population(node, samples, loaded);
  log(`constants: eta=${constants.eta} rho0=${constants.rho0} n0=${constants.n0}`);
  return passes(node, order, start(from, constants, builtin), epochs, log);
}

/**
 * A prior trained on `samples`, each one message of `node` (spec §2.3). An offline tool: it codes
 * every sample `epochs` times, and 36 times that with `holdOut`.
 */
export function train<T>(node: PNode<T>, samples: readonly T[], options: TrainOptions = {}): Prior {
  return trainLogged(node, samples, options, () => undefined);
}
