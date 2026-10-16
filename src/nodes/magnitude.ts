/**
 * The magnitude scale: an integer spelled relative to an origin by its
 * side of it, the bit-length class of its distance from it, and the raw
 * low bits that place it within the class. Small distances cost little and
 * large ones grow with their bit length rather than their size, which suits
 * a difference from a previous value, a length without a max, or any value
 * of an unbounded or very wide range.
 *
 * A value lies in an interval `[lo, hi]` that holds the origin, all safe
 * integers; an unbounded side is `±Number.MAX_SAFE_INTEGER`. Only classes
 * the interval reaches are coded, and a class the interval cuts codes its
 * tail over the part it keeps, so the scale wastes nothing at its edges.
 * Distances reach `2^54 - 2`, the span of the safe integers, so the
 * classes run to 54; every distance and tail is computed exactly in
 * floating point.
 */

import type { Encoder, Decoder } from '../packer';
import { AdaptivePrior, checkAdaptation, lineageOf, type Learning } from './adaptive';
import { Exclusion } from './excluded';

const TWO_32 = 2 ** 32;
const TWO_53 = 2 ** 53;

/** The class of the largest distance, `[2^53, 2^54)`. */
export const MAX_CLASS = 54;

/**
 * The bit-length class of a distance: 0 for 0, `c` for `[2^(c-1), 2^c)`.
 * A distance of at least 2^53 is class 54 whether or not the float holds it
 * exactly, as no safe interval reaches 2^54.
 */
export function classOf(distance: number): number {
  if (distance >= TWO_53) {
    return MAX_CLASS;
  }
  return distance < TWO_32
    ? 32 - Math.clz32(distance)
    : 64 - Math.clz32(Math.floor(distance / TWO_32));
}

/** Refuses `n` unless it is a safe integer. */
function checkSafe(n: number): void {
  if (!Number.isSafeInteger(n)) {
    throw new TypeError(`Magnitude bound ${n} is not a safe integer`);
  }
}

/** Refuses an interval, origin and value that are not safe integers with `lo <= origin <= hi` and the value within. */
function check(value: number | undefined, origin: number, lo: number, hi: number): void {
  if (value !== undefined) {
    checkSafe(value);
  }
  checkSafe(origin);
  checkSafe(lo);
  checkSafe(hi);
  if (lo > origin || origin > hi) {
    throw new RangeError(`Magnitude origin ${origin} is outside [${lo}, ${hi}]`);
  }
  if (value !== undefined && (value < lo || value > hi)) {
    throw new RangeError(`Magnitude value ${value} is outside [${lo}, ${hi}]`);
  }
}

/**
 * Where a value sits: `up` when at or above the origin, its distance from
 * the origin, exact below 2^53, and the distance's class.
 */
interface Placed {
  readonly up: boolean;
  readonly distance: number;
  readonly cls: number;
}

/** The side, distance and class of `value` from `origin`. */
function place(value: number, origin: number): Placed {
  const up = value >= origin;
  const distance = up ? value - origin : origin - value;
  return { up, distance, cls: classOf(distance) };
}

/** The farthest distance `[lo, hi]` reaches from `origin` above it, or below it when not `up`. */
const reach = (up: boolean, origin: number, lo: number, hi: number): number =>
  up ? hi - origin : origin - lo;

/**
 * How many tails class `cls`, at least 1, has on one side: the class's
 * distances the interval reaches. The interval holds the origin, so only
 * the farthest class it reaches is cut. Class 54 is reached only from an
 * origin at least 2^53 from the far bound, and counts from the operands
 * around 2^53, where every step has a safe exact result.
 */
function tailRadix(up: boolean, cls: number, origin: number, lo: number, hi: number): number {
  if (cls === MAX_CLASS) {
    return up ? hi - TWO_53 - origin + 1 : origin - TWO_53 - lo + 1;
  }
  const start = 2 ** (cls - 1);
  // A farthest distance past 2^53 rounds, but stays past the class's end.
  return Math.min(2 * start - 1, reach(up, origin, lo, hi)) - start + 1;
}

/** The tail of `value`, of class `cls` at least 1: its distance less the class's start. */
function tailOf({ up, distance, cls }: Placed, value: number, origin: number): number {
  if (cls === MAX_CLASS) {
    return up ? value - TWO_53 - origin : origin - TWO_53 - value;
  }
  return distance - 2 ** (cls - 1);
}

/** Writes the tail of a placed value of class at least 1. */
function writeTail(
  enc: Encoder,
  placed: Placed,
  value: number,
  origin: number,
  lo: number,
  hi: number
): void {
  enc.compose(tailOf(placed, value, origin), tailRadix(placed.up, placed.cls, origin, lo, hi));
}

/** Reads the value of class `cls`, at least 1, on its side of `origin`, from its tail. */
function readTail(
  dec: Decoder,
  up: boolean,
  cls: number,
  origin: number,
  lo: number,
  hi: number
): number {
  const tail = dec.parse(tailRadix(up, cls, origin, lo, hi));
  if (cls === MAX_CLASS) {
    return up ? origin + TWO_53 + tail : origin - TWO_53 - tail;
  }
  const distance = 2 ** (cls - 1) + tail;
  return up ? origin + distance : origin - distance;
}

/**
 * How a node spells an integer on the magnitude scale: the value lies in
 * `[lo, hi]`, which holds `origin`, all safe integers. Each method throws a
 * TypeError or RangeError on arguments outside that, and a value read back
 * always lies in the interval.
 */
export interface Magnitude {
  /** Writes `value`, learning nothing. */
  write(enc: Encoder, value: number, origin: number, lo: number, hi: number): void;
  /** Reads a value `write` wrote under the same origin and interval, learning nothing. */
  read(dec: Decoder, origin: number, lo: number, hi: number): number;
  /** Learns `value`, written or not; nothing for a scale that does not learn. */
  learn(side: Encoder | Decoder, value: number, origin: number, lo: number, hi: number): void;
}

/** The static scale's digit for a placed value: 0 the origin, then the classes above it, then those below. */
const staticDigit = ({ up, cls }: Placed, ups: number): number =>
  cls === 0 ? 0 : up ? cls : ups + cls;

/** The static scale's radix: the origin and every class the interval reaches on either side. */
const staticRadix = (origin: number, lo: number, hi: number): number =>
  1 + classOf(hi - origin) + classOf(origin - lo);

/**
 * The static magnitude scale: one digit naming the side and class, every
 * class the interval reaches equally likely, the origin itself among them,
 * then the tail. A side the interval does not reach costs nothing.
 */
export const STATIC_MAGNITUDE: Magnitude = {
  write(enc, value, origin, lo, hi) {
    check(value, origin, lo, hi);
    const placed = place(value, origin);
    enc.compose(staticDigit(placed, classOf(hi - origin)), staticRadix(origin, lo, hi));
    if (placed.cls > 0) {
      writeTail(enc, placed, value, origin, lo, hi);
    }
  },

  read(dec, origin, lo, hi) {
    check(undefined, origin, lo, hi);
    const ups = classOf(hi - origin);
    const digit = dec.parse(staticRadix(origin, lo, hi));
    if (digit === 0) {
      // An origin of -0 reads back as 0.
      return origin + 0;
    }
    const up = digit <= ups;
    return readTail(dec, up, up ? digit : digit - ups, origin, lo, hi);
  },

  learn(_side, value, origin, lo, hi) {
    check(value, origin, lo, hi);
  },
};

/** `check`, and an interval starting at the origin, for a scale that reaches only above it; `who` names the scale. */
function checkUp(
  value: number | undefined,
  origin: number,
  lo: number,
  hi: number,
  who: string
): void {
  check(value, origin, lo, hi);
  if (lo < origin) {
    throw new RangeError(`${who} magnitude reaches below its origin ${origin} to ${lo}`);
  }
}

/**
 * The gamma scale, which reaches only above its origin: the class in unary,
 * a bit for each class passed and one to stop short of the farthest class
 * the interval reaches, then the tail. Class `c` costs `c + 1` bits and its
 * tail `c - 1` more, so the smallest distances cost least whatever the
 * interval's reach.
 */
export const GAMMA_MAGNITUDE: Magnitude = {
  write(enc, value, origin, lo, hi) {
    checkUp(value, origin, lo, hi, 'Gamma');
    const placed = place(value, origin);
    for (let cls = 0; cls < placed.cls; cls++) {
      enc.compose(1, 2);
    }
    if (placed.cls < classOf(hi - origin)) {
      enc.compose(0, 2);
    }
    if (placed.cls > 0) {
      writeTail(enc, placed, value, origin, lo, hi);
    }
  },

  read(dec, origin, lo, hi) {
    checkUp(undefined, origin, lo, hi, 'Gamma');
    const top = classOf(hi - origin);
    let cls = 0;
    while (cls < top && dec.parse(2) === 1) {
      cls++;
    }
    // An origin of -0 reads back as 0.
    return cls === 0 ? origin + 0 : readTail(dec, true, cls, origin, lo, hi);
  },

  learn(_side, value, origin, lo, hi) {
    checkUp(value, origin, lo, hi, 'Gamma');
  },
};

/** Distances below this are a symbol each on the learned scale; larger ones a symbol per class. */
export const DIRECT = 64;
/** The class of the first distance past the direct ones. */
const FIRST_CLASS = classOf(DIRECT);
/** The symbols of one side of the learned scale, the origin's own included: 112. */
export const SIDE_SYMBOLS = DIRECT + MAX_CLASS - FIRST_CLASS + 1;

/** The learned scale's symbol for a distance of class `cls`: the distance itself when direct. */
const symbolOf = (distance: number, cls: number): number =>
  distance < DIRECT ? distance : DIRECT + cls - FIRST_CLASS;

/**
 * The starting weights of one side of the learned scale, as the term code
 * prices its distances: a distance of `n` base-3 digits costs `log2 5 + 2n`
 * bits, plus `extra`. Each symbol weighs its distances' share of 2^12, at
 * least 1. Every step is exact or one correctly rounded operation, so every
 * engine builds the same table; the shares of distances past 2^53 round,
 * and come to the floor of 1 either way.
 */
export function sideWeights(extra: number): number[] {
  const weights: number[] = [];
  for (let symbol = 0; symbol < SIDE_SYMBOLS; symbol++) {
    const cls = symbol - DIRECT + FIRST_CLASS;
    const first = symbol < DIRECT ? symbol : 2 ** (cls - 1);
    const last = symbol < DIRECT ? symbol : 2 ** cls - 1;
    // Distance 0 has no digits; those of n digits are [3^(n-1), 3^n).
    let mass = first === 0 ? 2 ** (12 - extra) : 0;
    for (let n = 1, low = 1; low <= last; n++, low *= 3) {
      const from = Math.max(first, low);
      const to = Math.min(last, 3 * low - 1);
      if (to >= from) {
        mass += (to - from + 1) * 2 ** (12 - 2 * n - extra);
      }
    }
    weights.push(Math.max(1, Math.round(mass / 5)));
  }
  return weights;
}

/**
 * The starting weights of one side of the learned scale, as the gamma scale
 * prices its distances, plus `extra` bits: each symbol weighs its
 * distances' share of 2^12, at least 1.
 */
export function gammaWeights(extra: number): number[] {
  const weights: number[] = [];
  for (let symbol = 0; symbol < SIDE_SYMBOLS; symbol++) {
    const cls = symbol < DIRECT ? classOf(symbol) : symbol - DIRECT + FIRST_CLASS;
    // A class weighs 2^-(c+1), shared evenly by its distances when each is a symbol.
    const share = symbol < DIRECT && cls > 0 ? cls - 1 : 0;
    weights.push(Math.max(1, Math.round(2 ** (12 - extra - cls - 1 - share))));
  }
  return weights;
}

/** How a learned scale's starting weights price distances: as the term code or the gamma scale does. */
export type Prices = 'term' | 'gamma';

/**
 * The starting weights of a learned scale by its prices: unsigned, one
 * side; signed, the upper side, then the lower one from 1, each a bit
 * dearer for the sign.
 */
const WEIGHTS: Record<Prices, readonly [unsigned: number[], signed: number[]]> = {
  term: [sideWeights(0), ((side) => [...side, ...side.slice(1)])(sideWeights(1))],
  gamma: [gammaWeights(0), ((side) => [...side, ...side.slice(1)])(gammaWeights(1))],
};

/**
 * The learned magnitude scale: a symbol per distance below `DIRECT` and per
 * class past it, then the tail, the symbols under an adaptive prior that
 * starts at the term code's prices, or the gamma scale's when `prices` says
 * so. A `signed` scale holds both sides, the distances above the origin
 * first, then those below it from 1; an unsigned one only those above, and
 * refuses an interval reaching below its origin. Symbols the interval does
 * not reach are ruled out, so they cost nothing.
 */
export class LearnedMagnitude implements Magnitude {
  private readonly prior: AdaptivePrior;
  /** The exclusion of each pair of farthest symbols, built on first use; none when every symbol is reached. */
  private readonly exclusions = new Map<number, Exclusion | undefined>();

  constructor(
    readonly signed: boolean,
    learning: Learning,
    private readonly who: string,
    prices: Prices = 'term'
  ) {
    const { window } = checkAdaptation(learning, who);
    const weights = WEIGHTS[prices][signed ? 1 : 0];
    this.prior = new AdaptivePrior([weights], weights.length, window, who, lineageOf(learning));
  }

  /** `check`, and for an unsigned scale an interval starting at the origin. */
  private checkSide(value: number | undefined, origin: number, lo: number, hi: number): void {
    if (this.signed) {
      check(value, origin, lo, hi);
    } else {
      checkUp(value, origin, lo, hi, this.who);
    }
  }

  /** The member of a value `distance` from the origin, above it when `up`: its symbol, or past the upper side's below it. */
  private member(up: boolean, distance: number): number {
    const symbol = symbolOf(distance, classOf(distance));
    return up ? symbol : SIDE_SYMBOLS - 1 + symbol;
  }

  /** The members the interval does not reach, ruled out. */
  private exclusion(origin: number, lo: number, hi: number): Exclusion | undefined {
    const farthest = (distance: number): number => symbolOf(distance, classOf(distance));
    const ups = farthest(hi - origin);
    const downs = this.signed ? farthest(origin - lo) : 0;
    const key = ups * SIDE_SYMBOLS + downs;
    if (this.exclusions.has(key)) {
      return this.exclusions.get(key);
    }
    let exclusion: Exclusion | undefined;
    const last = SIDE_SYMBOLS - 1;
    if (ups < last || (this.signed && downs < last)) {
      exclusion = new Exclusion(this.prior.members);
      for (let symbol = ups + 1; symbol <= last; symbol++) {
        exclusion.add(symbol);
      }
      if (this.signed) {
        for (let symbol = downs + 1; symbol <= last; symbol++) {
          exclusion.add(last + symbol);
        }
      }
    }
    this.exclusions.set(key, exclusion);
    return exclusion;
  }

  write(enc: Encoder, value: number, origin: number, lo: number, hi: number): void {
    this.checkSide(value, origin, lo, hi);
    const placed = place(value, origin);
    this.prior.write(
      enc,
      this.member(placed.up, placed.distance),
      0,
      this.exclusion(origin, lo, hi)
    );
    if (placed.cls >= FIRST_CLASS) {
      writeTail(enc, placed, value, origin, lo, hi);
    }
  }

  read(dec: Decoder, origin: number, lo: number, hi: number): number {
    this.checkSide(undefined, origin, lo, hi);
    const member = this.prior.read(dec, 0, this.exclusion(origin, lo, hi));
    const up = member < SIDE_SYMBOLS;
    const symbol = up ? member : member - (SIDE_SYMBOLS - 1);
    if (symbol < DIRECT) {
      // An origin of -0 reads back as 0.
      return up ? origin + symbol : origin - symbol;
    }
    return readTail(dec, up, symbol - DIRECT + FIRST_CLASS, origin, lo, hi);
  }

  learn(side: Encoder | Decoder, value: number, origin: number, lo: number, hi: number): void {
    this.checkSide(value, origin, lo, hi);
    const up = value >= origin;
    this.prior.learn(side, this.member(up, up ? value - origin : origin - value));
  }
}

/**
 * The magnitude scale of a node: learned under `learning`, holding both
 * sides when `signed`, and static otherwise, which reaches whichever sides
 * the interval does.
 */
export function magnitude(learning: Learning | undefined, signed: boolean, who: string): Magnitude {
  return learning === undefined ? STATIC_MAGNITUDE : new LearnedMagnitude(signed, learning, who);
}
