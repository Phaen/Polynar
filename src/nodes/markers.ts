/**
 * Structure symbols of declared schemas on the predictor (spec §6.5, brief D15 as amended): the
 * first structure symbol of a value's spelling, which the value's parent codes before it (or only
 * implies, where the schema leaves the value one symbol), and the declared weights of a choice
 * node as prior counts of its symbols (D19).
 */

import type { Encoder, Decoder } from '../packer';
import { session } from '../predictor/session';
import type { Bound, MarkerPrior } from '../predictor/session';
import { STRUCT } from '../predictor/types';
import type { Resolved } from '../predictor/types';
import type { PNode } from './base';
import { kindOf } from './guards';

/** The typed-array kinds in `p.any`'s tag order, Float16Array last. */
const TYPED_KINDS = [
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
];

const BY_KIND = new Map<string, number>([
  ['string', STRUCT.STR],
  ['undefined', STRUCT.UNDEFINED],
  ['null', STRUCT.NULL],
  ['bigint', STRUCT.BIGINT],
  ['date', STRUCT.DATE],
  ['regexp', STRUCT.REGEXP],
  ['array', STRUCT.ARR_START],
  ['map', STRUCT.MAP_START],
  ['set', STRUCT.SET_START],
  ['ArrayBuffer', STRUCT.BUFFER],
  ['DataView', STRUCT.DATAVIEW],
  ...TYPED_KINDS.map((kind, i): [string, number] => [kind, STRUCT.TYPED_0 + i]),
]);

/**
 * The structure symbol of a value by its kind, as plain `p.any` tags it: integers that travel as
 * integers `INT`, other numbers `NUM`, booleans by value, and anything else no other kind takes
 * (plain objects, functions, symbols) `OBJ_START`.
 */
export function kindMarker(value: unknown): number {
  const kind = kindOf(value);
  if (kind === 'number') {
    return Number.isSafeInteger(value) && !Object.is(value, -0) ? STRUCT.INT : STRUCT.NUM;
  }
  if (kind === 'boolean') {
    return value === true ? STRUCT.TRUE : STRUCT.FALSE;
  }
  return BY_KIND.get(kind) ?? STRUCT.OBJ_START;
}

/** The structure symbol of a value of `kind` that is no number or boolean. */
export const markerOfKind = (kind: string): number => BY_KIND.get(kind) ?? STRUCT.OBJ_START;

/** The structure symbols `nodes` spell first, undefined when one of them may spell any. */
export function unionOf(nodes: readonly PNode<any>[]): ReadonlySet<number> | undefined {
  const out = new Set<number>();
  for (const node of nodes) {
    const set = node._markers();
    if (set === undefined) {
      return undefined;
    }
    for (const sym of set) out.add(sym);
  }
  return out;
}

/**
 * Declared weights as prior counts of structure symbols: each weight spread evenly over the
 * symbols its member spells first (none when they are unknown), summed per symbol and scaled so
 * the counts sum to 16 per symbol. Undefined without weights.
 */
export function markerPrior(
  key: object,
  weights: readonly number[] | undefined,
  sets: readonly (ReadonlySet<number> | undefined)[]
): MarkerPrior | undefined {
  if (weights === undefined) {
    return undefined;
  }
  const sums = new Map<number, number>();
  sets.forEach((set, i) => {
    if (set === undefined || set.size === 0) return;
    for (const sym of set) sums.set(sym, (sums.get(sym) ?? 0) + weights[i] / set.size);
  });
  let total = 0;
  for (const w of sums.values()) total += w;
  const scale = 16 * sums.size;
  const counts: [number, number][] = [];
  for (const [sym, w] of [...sums].sort((a, b) => a[0] - b[0])) {
    if (w > 0) counts.push([sym, Math.max(1, Math.floor((scale * w) / total))]);
  }
  return { key, counts };
}

/**
 * The one structure symbol a value of a node spelling `set` first can take where `bound` admits no
 * end, −1 when the schema leaves a choice.
 */
export function fixedOf(set: ReadonlySet<number> | undefined, bound?: Bound): number {
  if (set === undefined || set.size !== 1 || bound?.allow === true) {
    return -1;
  }
  const [sym] = set;
  return sym;
}

/**
 * Codes `sym`, the first structure symbol of a value of `child`, through the innermost container
 * on the predictor, or at `self` outside every one, and hands it to `child`.
 */
export function writeMarker(
  enc: Encoder,
  self: object,
  o: Resolved,
  child: PNode<any>,
  sym: number,
  bound?: Bound
): void {
  const access = session(enc).marker(self, o);
  if (fixedOf(child._markers(), bound) >= 0) {
    access.imply(sym, child);
  } else {
    access.write(enc, sym, child, bound, child._markerPrior());
  }
}

/** Reads what `writeMarker` wrote, handing it to `child`. */
export function readMarker(
  dec: Decoder,
  self: object,
  o: Resolved,
  child: PNode<any>,
  bound?: Bound
): number {
  const access = session(dec).marker(self, o);
  const fixed = fixedOf(child._markers(), bound);
  if (fixed >= 0) {
    access.imply(fixed, child);
    return fixed;
  }
  return access.read(dec, child, bound, child._markerPrior());
}

/**
 * The structure symbol coded for `node` by its parent, or, when none was, `sym` coded by the node
 * itself at `self`: through the innermost container on the predictor, or its own path.
 */
export function ownMarker(enc: Encoder, node: PNode<any>, o: Resolved, sym: number): number {
  const s = session(enc);
  const coded = s.take(node);
  if (coded >= 0) {
    return coded;
  }
  const access = s.marker(node, o);
  if (fixedOf(node._markers()) >= 0) {
    access.imply(sym);
  } else {
    access.write(enc, sym, undefined, undefined, node._markerPrior());
  }
  return sym;
}

/** Reads what `ownMarker` wrote. */
export function readOwnMarker(dec: Decoder, node: PNode<any>, o: Resolved): number {
  const s = session(dec);
  const coded = s.take(node);
  if (coded >= 0) {
    return coded;
  }
  const access = s.marker(node, o);
  const fixed = fixedOf(node._markers());
  if (fixed >= 0) {
    access.imply(fixed);
    return fixed;
  }
  return access.read(dec, undefined, undefined, node._markerPrior());
}
