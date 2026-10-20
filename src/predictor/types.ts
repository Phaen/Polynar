/**
 * Shared contracts of the similarity predictor (src/predictor). Every module codes against
 * these; nothing here has behaviour.
 *
 * Numbers: every value is an integer below 2^53 held in a `number` or a typed array. Log-domain
 * quantities (parameters, deltas, exponents) are in bits with RB fractional bits; shares and
 * probabilities have PB bits; see arith.ts for the constants and the exact operations.
 */

/** What `.adaptive(options)` takes (spec §2.1). */
export interface AdaptiveOptions {
  readonly prior?: Prior;
  readonly window?: number;
  readonly separate?: boolean;
  readonly order?: number;
  readonly candidates?: number;
  readonly offsets?: number;
  readonly history?: number;
  readonly quantisation?: number;
}

/** The options after validation and defaults, with the prior loaded. */
export interface Resolved {
  readonly prior: LoadedPrior;
  readonly window: number; // Infinity when none
  readonly separate: boolean;
  readonly order: number;
  readonly candidates: number;
  readonly offsets: number;
  readonly history: number;
  readonly quantisation: number;
}

/** One shipped or trained table: Int8 data with an integer scale and offset in RB units. */
export interface PriorTable {
  readonly scale: number;
  readonly offset: number;
  readonly data: readonly number[];
}

/** The shipped prior (spec §7). Plain JSON, integers only. */
export interface Prior {
  readonly format: 1;
  readonly order: number;
  readonly arith: {
    readonly RB: number;
    readonly SB: number;
    readonly HB: number;
    readonly PB: number;
    readonly tables: string;
  };
  readonly constants: PriorConstants;
  readonly tables: {
    readonly escape: PriorTable; // 1
    readonly kernel: PriorTable; // 3: case, boundary, digit link weights (bits, <= 0)
    readonly hybrid: PriorTable; // 8 * (order + 5) * 6
    readonly apm: PriorTable; // 3 * (order + 1) * 24 logits
    readonly pnov: PriorTable; // 32
    readonly vfeat: PriorTable; // 5
    readonly oscale: PriorTable; // 6
    readonly lev: PriorTable; // 5
    readonly logn: PriorTable; // 8 * (order + 1) + 1
    readonly vstep: PriorTable; // 76
    readonly numberShared: {
      readonly hit: PriorTable;
      readonly range: PriorTable;
      readonly conf: PriorTable;
    }; // 12, 2, 120 logits
    readonly numberStart: PriorTable; // 139
  };
  readonly builtin: {
    readonly symbols: readonly number[]; // code points in id order (END is never listed; it is id 0)
    readonly counts0: readonly number[]; // order-0 count per symbol, END's count first
    readonly contexts1: readonly (readonly [prev: number, next: number, count: number])[]; // prev/next as -1 for END, else code points; sorted by (prev, next)
  };
  readonly trainedOn?: string;
}

/** Learning constants; log-domain values in RB bits, shifts as counts. */
export interface PriorConstants {
  readonly eta: number;
  readonly rho0: number;
  readonly n0: number;
  readonly rates: {
    readonly vfeat: readonly [number, number, number, number, number];
    readonly logn: number;
    readonly lev: number;
    readonly apm: number; // PB-bit rate of the confidence maps (0.02 -> 1311)
    readonly kernel: number;
    readonly oscale: number;
    readonly pnov: number;
    readonly vstep: number;
    readonly number: number;
    readonly step: number;
  };
  readonly decays: { readonly lev: number; readonly hit: number };
  readonly clamps: {
    readonly cell: number;
    readonly delta: number;
    readonly vfeat: number;
    readonly lev: number;
    readonly logn: number;
    readonly oscale: readonly [number, number];
    readonly vstep: number;
    readonly number: number;
    readonly hit: number;
    readonly range: number;
  };
  readonly ladder: readonly [number, number, number];
}

/** A prior after validation: tables expanded to RB fixed point, immutable, shared by sessions. */
export interface LoadedPrior {
  readonly source: Prior;
  readonly order: number;
  readonly constants: PriorConstants;
  readonly escape: number;
  readonly kernel: Float64Array; // 3
  readonly hybrid: Float64Array; // NSRC * (order + 5) * HF
  readonly apm: Float64Array; // PB-bit probabilities, 3 * (order + 1) * APM_B
  readonly pnov: Float64Array;
  readonly vfeat: Float64Array;
  readonly oscale: Float64Array;
  readonly lev: Float64Array;
  readonly logn: Float64Array;
  readonly vstep: Float64Array;
  readonly numberHit: Float64Array;
  readonly numberRange: Float64Array;
  readonly numberConf: Float64Array; // PB-bit probabilities
  readonly numberStart: Float64Array;
  /** The built-in population's data, resolved to a session's ids by tables.ts `frozen(prior, ids)`. */
  readonly builtinSymbols: readonly number[];
  readonly builtinCounts0: readonly number[];
  readonly builtinContexts1: readonly (readonly [number, number, number])[];
}

/** The mutable copy of a prior's learned tables for one message (weights.ts owns the updates). */
export interface RunPrior {
  readonly loaded: LoadedPrior;
  escape: number;
  readonly kernel: Float64Array;
  readonly hybrid: Float64Array;
  readonly apm: Float64Array;
  readonly pnov: Float64Array;
  readonly vfeat: Float64Array;
  readonly oscale: Float64Array;
  readonly lev: Float64Array;
  readonly logn: Float64Array;
  readonly vstep: Float64Array;
}

/** Vote sources: the block axis of the hybrid weights (spec §4.4; prototype SRC). */
export const SRC = {
  node: 0,
  msg: 1,
  builtin: 2,
  value: 3,
  parent: 4,
  msgF: 5,
  nodeF: 6,
  sticky: 7,
} as const;
export const NSRC = 8;
/** Hybrid parameters per (source, level) block: theta, then slopes for recency, frozen, depth, offset agreement, determinism. */
export const HF = 6;
/** Confidence-map cells per row. */
export const APM_B = 24;
/** Levels per source: exact agreement 0..order, then four long buckets. */
export const levels = (order: number): number => order + 5;

/** Fixed symbol ids (spec §4.3; INT added after review, bytes reserved after the structure ids). */
export const END = 0;
export const STRUCT = {
  OBJ_START: 1,
  OBJ_END: 2,
  ARR_START: 3,
  ARR_END: 4,
  KEY: 5,
  NOKEY: 6,
  STR: 7,
  INT: 8,
  NUM: 9,
  TRUE: 10,
  FALSE: 11,
  NULL: 12,
  UNDEFINED: 13,
  DATE: 14,
  BIGINT: 15,
  REGEXP: 16,
  MAP_START: 17,
  MAP_END: 18,
  SET_START: 19,
  SET_END: 20,
  BUFFER: 21,
  DATAVIEW: 22,
  TYPED_0: 23, // ..TYPED_10 = 33
  HINT: 34,
} as const;
export const DIGIT = 35;
/** Byte ids are fixed too, so the byte and text alphabets never collide within one id space. */
export const BYTE_BASE = 36;
export const CP_BASE = BYTE_BASE + 256; // 292: first id a code point can take
export const ESCAPE = -1;

/** Which symbols a predictor codes; a charset is a text alphabet closed to its members. */
export type AlphabetKind = 'text' | 'bytes' | 'structure';

/**
 * END rules of one value, in units (a symbol's UTF-16 code units for text, 1 for anything else):
 * END is not an entry below `min` or between whole `step`s of units (1 when left out), the value
 * ends without a step at `max`, and END never appears when `fixed`.
 */
export interface Ends {
  readonly min: number;
  readonly max: number | undefined;
  readonly fixed: boolean;
  readonly step?: number;
}

/** The position of the symbol being coded, as the stream knows it (prototype `x`). */
export interface Position {
  /** Offset within the value's text; END gets the value's length. */
  off: number;
  /** Symbols since the innermost record opened; Infinity outside a record. */
  roff: number;
}

/** A symbol predictor's distribution for one step, as the coder consumes it (spec §6.1). */
export interface MemberLike {
  readonly total: number;
  readonly n: number;
  readonly hasEscape: boolean;
  cum(i: number): number;
  freq(i: number): number;
  locate(residual: number): number;
  indexOf(id: number): number;
  idAt(i: number): number;
}

/** A key into the session's path registry: a node, a p.any key path, or a node's derived path. */
export type PathKey = object | string | readonly [object, number];
