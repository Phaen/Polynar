/**
 * `.compress(options)`: validation at definition and the resolved sizes (spec §2.1).
 */
import { priorOf } from './prior';
import type { CompressOptions, LoadedPrior, Prior, Resolved } from './types';

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
export function checkCompress(options: CompressOptions | undefined, who: string): CompressOptions {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(`${who}: compress options must be an object`);
  }
  const { window, separate, prior } = options;
  if (window !== undefined && window !== Infinity) {
    if (!Number.isSafeInteger(window)) {
      throw new TypeError(`${who}: compress window must be an integer, got ${window}`);
    }
    if (window < 1) throw new RangeError(`${who}: compress window must be at least 1`);
  }
  if (separate !== undefined && typeof separate !== 'boolean') {
    throw new TypeError(`${who}: compress separate must be a boolean`);
  }
  for (const [key, lo, hi] of RANGES) {
    const v = options[key];
    if (v === undefined) continue;
    if (!Number.isSafeInteger(v)) {
      throw new TypeError(`${who}: compress ${key} must be an integer, got ${v}`);
    }
    if (v < lo || v > hi) {
      throw new RangeError(`${who}: compress ${key} must be in ${lo}..${hi}, got ${v}`);
    }
  }
  const q = options.quantisation;
  if (q !== undefined && !isPowerOfTwo(q)) {
    throw new TypeError(`${who}: compress quantisation must be a power of two, got ${q}`);
  }
  if (prior !== undefined) priorOf(prior);
  return Object.freeze({ ...options });
}

/**
 * The options with defaults filled in and the prior loaded (`defaultPrior` when none is given);
 * TypeError when the order differs from the prior's.
 */
export function resolve(
  options: CompressOptions | undefined,
  defaultPrior: LoadedPrior,
  who: string
): Resolved {
  const o = checkCompress(options, who);
  const prior = o.prior === undefined ? defaultPrior : priorOf(o.prior);
  const order = o.order ?? DEFAULTS.order;
  if (order !== prior.order) {
    throw new TypeError(
      `${who}: compress order ${order} differs from the prior's order ${prior.order}`
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

/** A node the container sugar reaches (spec Q4): `PNode` as this module sees it. */
export interface Adaptable {
  _adapted?(options: CompressOptions, memo: Map<Adaptable, Adaptable>): Adaptable;
}

/**
 * `node` with `.compress(options)` on every node below it that has neither its own nor
 * `.learn()`, and on itself (spec Q4), all under one prior: `options.prior`, else `prior`, the
 * root's default. A node reused in the tree maps to one adapted node.
 */
export function applyCompress<T extends Adaptable>(
  node: T,
  options: CompressOptions,
  prior: Prior
): T {
  const filled = Object.freeze({ ...options, prior: options.prior ?? prior });
  return (node._adapted?.(filled, new Map()) ?? node) as T;
}
