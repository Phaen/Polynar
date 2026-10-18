/**
 * `.adaptive(options)`: validation at definition and the resolved sizes (spec §2.1).
 */
import { priorOf } from './prior';
import type { AdaptiveOptions, LoadedPrior, Resolved } from './types';

/** The structural defaults. */
export const DEFAULTS = {
  order: 8,
  candidates: 8,
  offsets: 64,
  history: 64,
  quantisation: 65536,
} as const;

/** The integer options and their ranges. */
const RANGES: readonly (readonly [keyof typeof DEFAULTS, number, number])[] = [
  ['order', 1, 12],
  ['candidates', 0, 64],
  ['offsets', 0, 1024],
  ['history', 1, 4096],
  ['quantisation', 4096, 16777216],
];

function isPowerOfTwo(x: number): boolean {
  let p = 1;
  while (p < x) p *= 2;
  return p === x;
}

/**
 * The options validated (`window: Infinity` means no halving, as when it is left out): TypeError
 * for a non-object, a non-integer, a non-boolean `separate`, a
 * non-power-of-two `quantisation` or an invalid prior; RangeError for a value outside its range.
 */
export function checkAdaptive(options: AdaptiveOptions | undefined, who: string): AdaptiveOptions {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(`${who}: adaptive options must be an object`);
  }
  const { window, separate, prior } = options;
  if (window !== undefined && window !== Infinity) {
    if (!Number.isSafeInteger(window)) {
      throw new TypeError(`${who}: adaptive window must be an integer, got ${window}`);
    }
    if (window < 1) throw new RangeError(`${who}: adaptive window must be at least 1`);
  }
  if (separate !== undefined && typeof separate !== 'boolean') {
    throw new TypeError(`${who}: adaptive separate must be a boolean`);
  }
  for (const [key, lo, hi] of RANGES) {
    const v = options[key];
    if (v === undefined) continue;
    if (!Number.isSafeInteger(v)) {
      throw new TypeError(`${who}: adaptive ${key} must be an integer, got ${v}`);
    }
    if (v < lo || v > hi) {
      throw new RangeError(`${who}: adaptive ${key} must be in ${lo}..${hi}, got ${v}`);
    }
  }
  const q = options.quantisation;
  if (q !== undefined && !isPowerOfTwo(q)) {
    throw new TypeError(`${who}: adaptive quantisation must be a power of two, got ${q}`);
  }
  if (prior !== undefined) priorOf(prior);
  return Object.freeze({ ...options });
}

/**
 * The options with defaults filled in and the prior loaded (`defaultPrior` when none is given);
 * TypeError when the order differs from the prior's.
 */
export function resolve(
  options: AdaptiveOptions | undefined,
  defaultPrior: LoadedPrior,
  who: string
): Resolved {
  const o = checkAdaptive(options, who);
  const prior = o.prior === undefined ? defaultPrior : priorOf(o.prior);
  const order = o.order ?? DEFAULTS.order;
  if (order !== prior.order) {
    throw new TypeError(
      `${who}: adaptive order ${order} differs from the prior's order ${prior.order}`
    );
  }
  return {
    prior,
    window: o.window ?? Infinity,
    separate: o.separate ?? false,
    order,
    candidates: o.candidates ?? DEFAULTS.candidates,
    offsets: o.offsets ?? DEFAULTS.offsets,
    history: o.history ?? DEFAULTS.history,
    quantisation: o.quantisation ?? DEFAULTS.quantisation,
  };
}
