/**
 * The rational state bound of one mixed-radix block, shared by the encoder
 * and the decoder so both make the same block-boundary, index-form, digit
 * count and exhaustion decisions.
 *
 * The bound is V/den with U/den the running density factor and S/den the
 * digit bound: per symbol of `total` states and `freq` weight the candidate
 * is V + U·(total−1), S takes the larger of itself and the candidate, then
 * V' = (V + U·(total−freq))·freq, U' = U·total, den' = den·freq. Every
 * decision compares one of these rationals with a power of the digit base.
 *
 * Carrying the rationals exactly costs a big-integer product per symbol that
 * grows without bound, so the exact numbers are kept only where they stay
 * small. While every weight is one the bound is a plain integer product,
 * split into a committed BigInt and a pending Number factor below 2^53. Once
 * a weighted symbol arrives the bound continues as doubles under a shared
 * power-of-two scale, each carrying a rigorous relative error margin: a
 * comparison whose margins do not separate the two sides is undecidable
 * there, and the block recomputes its exact bound from the symbols recorded
 * so far and decides with that, staying exact for the rest of the block.
 * Every answer is therefore the exact one.
 */

import { DEFAULT_BLOCK_BITS } from './constants';
import { bitLength } from './utils';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIG = BigInt(MAX_SAFE);
const TWO_53_BIG = 1n << 53n;
/** Exponent granularity of the scaled doubles and of constant floats. */
const STEP = 256;
const STEP_UP = 2 ** STEP;
const STEP_DOWN = 2 ** -STEP;
/** Scale factors 2^(STEP·i) for i in [-3, 3], the exponent gaps worth comparing. */
const SCALES = [2 ** -768, 2 ** -512, 2 ** -256, 1, 2 ** 256, 2 ** 512, 2 ** 768];
/** Twice the unit roundoff: one rounding costs at most this, relatively. */
const ULP2 = 2 ** -52;
/** Error units budgeted per symbol in the float regime. */
const OPS_PER_SYMBOL = 3;

const enum Regime {
  Uniform,
  Float,
  Exact,
}

/** Starts every block in the exact regime: the reference the faster regimes are tested against. */
let exactOnly = false;

/** Internal: sets whether blocks start in the exact regime. Not exported from the package. */
export function setExactOnly(on: boolean): void {
  exactOnly = on;
}

/**
 * A positive BigInt as a double mantissa in [1, 2^STEP) times 2^exponent,
 * the exponent a multiple of STEP. The top 53 bits convert exactly and the
 * rest truncate, so the mantissa is within one error unit below the value.
 */
function floatOf(x: bigint): [number, number] {
  const bits = bitLength(x);
  const e = Math.floor((bits - 1) / STEP) * STEP;
  const drop = Math.max(0, bits - 53);
  return [Number(x >> BigInt(drop)) * 2 ** (drop - e), e];
}

/**
 * Compares a scaled double x·2^E, known to within k error units, with the
 * constant m·2^e: 1 when it is certainly larger, -1 when it is certainly
 * not, 0 when the margins overlap. The scaled doubles lie in
 * [2^-53, 2^400) and constant mantissas in [1, 2^STEP), so a constant four
 * steps or more above decides on its own. No value is ever compared with a
 * constant four steps below it: every candidate stays within 2^110 of the
 * block's digit space, and a digit search starts within two digits of the
 * value.
 */
function compareFloat(x: number, E: number, m: number, e: number, k: number): -1 | 0 | 1 {
  const d = (E - e) / STEP;
  if (d <= -4) {
    return -1;
  }
  const y = m * SCALES[3 - d];
  // The margins cover the k roundings of x, the one rounding of m, and the
  // two roundings of applying them. n roundings of at most u = ULP2 / 2 each
  // compound to (1 + u)^n - 1 <= 2nu = n * ULP2 while nu <= 1; past that mu
  // exceeds 1 and both tests fail, so no number of roundings gives a wrong
  // answer, only an undecidable 0.
  const mu = (k + 8) * ULP2;
  if (x * (1 - mu) > y * (1 + mu)) {
    return 1;
  }
  if (x * (1 + mu) <= y * (1 - mu)) {
    return -1;
  }
  return 0;
}

/**
 * Powers of one digit base, exact and as constant floats, and the block
 * size they set: `blockDigits` is the largest digit count whose state space,
 * `cap` = base^blockDigits, stays within 2^blockBits. Encoder and decoder
 * both derive block boundaries from it, so it is found in integer
 * arithmetic, where a float log could round differently across engines.
 */
class Powers {
  readonly big: bigint[] = [1n];
  readonly m: number[] = [1];
  readonly e: number[] = [0];
  readonly blockDigits: number;
  readonly cap: bigint;
  private readonly base: bigint;

  constructor(base: number, blockBits: number) {
    this.base = BigInt(base);
    const limit = 1n << BigInt(blockBits);
    let digits = 1;
    this.ensure(2);
    while (this.big[digits + 1] <= limit) {
      digits++;
      this.ensure(digits + 1);
    }
    this.blockDigits = digits;
    this.cap = this.big[digits];
  }

  ensure(d: number): void {
    while (this.big.length <= d) {
      const next = this.big[this.big.length - 1] * this.base;
      const [m, e] = floatOf(next);
      this.big.push(next);
      this.m.push(m);
      this.e.push(e);
    }
  }
}

/**
 * Keyed by base and block size as one number: a base is at most 2^16, the
 * size of the largest charset, so the block size lands in the bits above.
 * Holds the most recently used tables, evicting the least recently used one
 * when full.
 */
const powersCache = new Map<number, Powers>();
const POWERS_CACHE_SIZE = 16;

export function powersOf(base: number, blockBits: number = DEFAULT_BLOCK_BITS): Powers {
  const key = blockBits * 0x20000 + base;
  let powers = powersCache.get(key);
  if (powers === undefined) {
    powers = new Powers(base, blockBits);
    if (powersCache.size >= POWERS_CACHE_SIZE) {
      powersCache.delete(powersCache.keys().next().value as number);
    }
  } else {
    powersCache.delete(key);
  }
  powersCache.set(key, powers);
  return powers;
}

export class BlockBound {
  private readonly base: number;
  private readonly log2Base: number;
  private readonly powers: Powers;
  readonly blockDigits: number;
  private readonly cap: bigint;
  /** The block's digit space: cap for a full block, less for a final one. */
  private capacity: bigint;
  private capacityM: number;
  private capacityE: number;
  private capacityIsCap: boolean;

  private regime = Regime.Uniform;
  /** The block's symbols so far, for recomputing the exact bound. */
  private recTotal: number[] = [];
  private recFreq: number[] = [];
  private n = 0;
  /** Member count of the latest symbol, which sets the tight bound. */
  private lastCount = 1;

  /* Uniform regime: V = U = S = uBig·uNum exactly, den = 1. */
  private uBig = 1n;
  private uNum = 1;
  /** floor(cap / uBig) and floor(capacity / uBig), or Infinity when any pending factor fits. */
  private roomCap = Infinity;
  private roomCapacity = Infinity;
  /** The bound before the latest symbol, whose tight form is tBig·tNum·lastCount. */
  private tBig = 1n;
  private tNum = 1;

  /* Float regime: the rationals as doubles scaled by 2^-E, within ops error units. */
  private v = 1;
  private u = 1;
  private s = 1;
  private tight = 1;
  private E = 0;
  private ops = 0;

  /* Exact regime. */
  private V = 1n;
  private U = 1n;
  private S = 1n;
  private den = 1n;
  private capDen: bigint;
  private capacityDen: bigint;
  private tightV = 1n;
  private tightDen = 1n;

  constructor(size: number, blockBits: number) {
    const powers = powersOf(size, blockBits);
    this.base = size;
    this.log2Base = Math.log2(size);
    this.powers = powers;
    this.blockDigits = powers.blockDigits;
    this.cap = powers.cap;
    this.capacity = powers.cap;
    this.capacityM = powers.m[powers.blockDigits];
    this.capacityE = powers.e[powers.blockDigits];
    this.capacityIsCap = true;
    this.capDen = powers.cap;
    this.capacityDen = powers.cap;
  }

  /** Start a fresh block whose digit space is `digits` base-`size` digits. */
  reset(digits: number = this.blockDigits): void {
    this.capacity = this.powers.big[digits];
    this.capacityM = this.powers.m[digits];
    this.capacityE = this.powers.e[digits];
    this.capacityIsCap = digits === this.blockDigits;
    this.regime = Regime.Uniform;
    this.n = 0;
    this.lastCount = 1;
    this.uBig = 1n;
    this.uNum = 1;
    this.tBig = 1n;
    this.tNum = 1;
    this.commit();
    if (exactOnly) {
      this.goExact();
    }
  }

  /** Whether a symbol of `total` states pushes the bound past the block cap. */
  exceedsCap(total: number): boolean {
    return this.exceeds(total, true);
  }

  /** Whether the symbol's bucket candidate needs more state than the block's digits hold. */
  exceedsCapacity(total: number): boolean {
    return !this.capacityIsCap && this.exceeds(total, false);
  }

  /** Whether even the symbol's index form, over `count` members, needs more state than the digits hold. */
  indexExceedsCapacity(total: number, count: number): boolean {
    return count >= total ? this.exceedsCapacity(total) : this.exceeds(count, false);
  }

  /**
   * Fold one symbol into the bound, after `exceedsCap` has judged the same
   * `total`. `count` is its member count (the index form's radix, at most
   * `total`); the tight bound the symbol admits is S or its index
   * candidate, whichever is larger, taken before the update.
   */
  update(total: number, freq: number, count: number): void {
    if (this.regime === Regime.Uniform) {
      if (freq === 1) {
        this.record(total, freq, count);
        this.tBig = this.uBig;
        this.tNum = this.uNum;
        this.uNum *= total;
        return;
      }
      this.toFloat();
    }
    if (this.regime === Regime.Float) {
      this.record(total, freq, count);
      const c = this.v + this.u * (total - 1);
      const asIndex = count < total ? this.v + this.u * (count - 1) : c;
      this.tight = this.s < asIndex ? asIndex : this.s;
      if (this.s < c) {
        this.s = c;
      }
      if (freq === 1) {
        this.v = c;
        this.u *= total;
      } else {
        this.v += this.u * (total - freq);
        this.u = (this.u * total) / freq;
      }
      this.ops += OPS_PER_SYMBOL;
      if (this.u >= STEP_UP) {
        this.v *= STEP_DOWN;
        this.u *= STEP_DOWN;
        this.s *= STEP_DOWN;
        this.tight *= STEP_DOWN;
        this.E += STEP;
      }
      return;
    }
    const totalBig = BigInt(total);
    const c = this.V + this.U * (totalBig - 1n);
    const asIndex = count < total ? this.V + this.U * BigInt(count - 1) : c;
    this.tightV = this.S < asIndex ? asIndex : this.S;
    this.tightDen = this.den;
    if (this.S < c) {
      this.S = c;
    }
    if (freq === 1) {
      this.V = c;
    } else {
      const freqBig = BigInt(freq);
      this.V = (this.V + this.U * (totalBig - freqBig)) * freqBig;
      this.S *= freqBig;
      this.den *= freqBig;
      this.capDen *= freqBig;
      this.capacityDen *= freqBig;
    }
    this.U *= totalBig;
  }

  /**
   * Fold up to `max` symbols of `radix` states and weight one, for as long
   * as each fits the block's digits, and return how many were folded. The
   * state afterwards is the one that many `exceedsCap`, `exceedsCapacity`
   * and `update` steps reach; the first symbol that would cross the cap or
   * the digit space stays unfolded, for the per-symbol path to judge.
   */
  fold(radix: number, max: number): number {
    let n = 0;
    if (this.regime !== Regime.Uniform) {
      while (n < max && !this.exceedsCap(radix) && !this.exceedsCapacity(radix)) {
        this.update(radix, 1, radix);
        n++;
      }
      return n;
    }
    // The digit space never exceeds the cap, so a symbol within it is
    // within both.
    for (; n < max; n++) {
      const q = this.uNum * radix;
      if (q > MAX_SAFE) {
        return n + this.foldProduct(radix, max - n);
      }
      if (q > this.roomCapacity) {
        break;
      }
      this.record(radix, 1, radix);
      this.tBig = this.uBig;
      this.tNum = this.uNum;
      this.uNum = q;
    }
    return n;
  }

  /**
   * Uniform regime, once the pending factor is full: fold the most symbols
   * of `radix`, up to `max`, whose product with the bound stays within the
   * block's digit space, as one power of the radix.
   */
  private foldProduct(radix: number, max: number): number {
    const product = this.uBig * BigInt(this.uNum);
    const room = this.capacity / product;
    const radixBig = BigInt(radix);
    if (room < radixBig) {
      return 0;
    }
    // The estimate from the bit length is off by at most one either way.
    let n = Math.max(1, Math.min(max, Math.floor((bitLength(room) - 1) / Math.log2(radix))));
    let pow = radixBig ** BigInt(n);
    while (pow > room) {
      n--;
      pow /= radixBig;
    }
    while (n < max && pow * radixBig <= room) {
      n++;
      pow *= radixBig;
    }
    for (let i = 0; i < n; i++) {
      this.record(radix, 1, radix);
    }
    this.tBig = product * (pow / radixBig);
    this.tNum = 1;
    this.uBig = product * pow;
    this.uNum = 1;
    this.commit();
    return n;
  }

  /** Whether the tight bound of the latest symbol leaves a whole digit of the block unused. */
  tightFitsAnotherDigit(): boolean {
    switch (this.regime) {
      case Regime.Uniform:
        return (
          this.tBig * BigInt(this.tNum) * BigInt(this.lastCount) * BigInt(this.base) <=
          this.capacity
        );
      case Regime.Float: {
        const cmp = compareFloat(
          this.tight * this.base,
          this.E,
          this.capacityM,
          this.capacityE,
          this.ops + 2
        );
        if (cmp !== 0) {
          return cmp < 0;
        }
        this.goExact();
        return this.tightFitsAnotherDigit();
      }
      default:
        return this.tightV * BigInt(this.base) <= this.capacity * this.tightDen;
    }
  }

  /** The fewest digits whose state space covers the digit bound S/den. */
  digitsForS(): number {
    switch (this.regime) {
      case Regime.Uniform:
        return this.exactDigits(this.uBig * BigInt(this.uNum), 1n);
      case Regime.Float: {
        const d = this.floatDigits(this.s, this.ops + 2);
        if (d >= 0) {
          return d;
        }
        this.goExact();
        return this.digitsForS();
      }
      default:
        return this.exactDigits(this.S, this.den);
    }
  }

  /**
   * For a message's last symbol, not yet folded in: whether its bucket form
   * needs more digits than its index form over `count` members, and the
   * digits the index form needs.
   */
  indexDecision(total: number, count: number): { indexed: boolean; digits: number } {
    switch (this.regime) {
      case Regime.Uniform: {
        const before = this.uBig * BigInt(this.uNum);
        const asBucket = this.exactDigits(before * BigInt(total), 1n);
        const asIndex = this.exactDigits(before * BigInt(count), 1n);
        return { indexed: asBucket > asIndex, digits: asIndex };
      }
      case Regime.Float: {
        const c = this.candidate(total);
        const asIndex = this.candidate(count);
        const sizing = this.s < asIndex ? asIndex : this.s;
        const asBucket = this.floatDigits(c, this.ops + 2);
        const digits = this.floatDigits(sizing, this.ops + 2);
        if (asBucket >= 0 && digits >= 0) {
          return { indexed: asBucket > digits, digits };
        }
        this.goExact();
        return this.indexDecision(total, count);
      }
      default: {
        const asBucket = this.V + this.U * BigInt(total - 1);
        const asIndex = this.V + this.U * BigInt(count - 1);
        const sizing = this.S < asIndex ? asIndex : this.S;
        const digits = this.exactDigits(sizing, this.den);
        return { indexed: this.exactDigits(asBucket, this.den) > digits, digits };
      }
    }
  }

  /** Whether the candidate for `k` states exceeds the block cap, or the block's digit space when `toCap` is false. */
  private exceeds(k: number, toCap: boolean): boolean {
    switch (this.regime) {
      case Regime.Uniform:
        return this.pending(k) > (toCap ? this.roomCap : this.roomCapacity);
      case Regime.Float: {
        const cmp = compareFloat(
          this.candidate(k),
          this.E,
          toCap ? this.powers.m[this.blockDigits] : this.capacityM,
          toCap ? this.powers.e[this.blockDigits] : this.capacityE,
          this.ops + 2
        );
        if (cmp !== 0) {
          return cmp > 0;
        }
        this.goExact();
        return this.exceeds(k, toCap);
      }
      default:
        return this.V + this.U * BigInt(k - 1) > (toCap ? this.capDen : this.capacityDen);
    }
  }

  /** Note a symbol folded into the bound, for the exact recomputation. */
  private record(total: number, freq: number, count: number): void {
    this.recTotal[this.n] = total;
    this.recFreq[this.n] = freq;
    this.n++;
    this.lastCount = count;
  }

  /** Uniform regime: the pending factor with `k` folded in, committing first when it would overflow. */
  private pending(k: number): number {
    const q = this.uNum * k;
    if (q > MAX_SAFE) {
      this.commit();
      return k;
    }
    return q;
  }

  /** Uniform regime: fold the pending factor into the committed product and refresh the rooms. */
  private commit(): void {
    if (this.uNum !== 1) {
      this.uBig *= BigInt(this.uNum);
      this.uNum = 1;
    }
    if (this.uBig === 1n) {
      this.roomCapacity = this.capacity > MAX_SAFE_BIG ? Infinity : Number(this.capacity);
      this.roomCap = this.capacityIsCap ? this.roomCapacity : Infinity;
      return;
    }
    const scaled = this.uBig * TWO_53_BIG;
    this.roomCapacity = scaled > this.capacity ? Number(this.capacity / this.uBig) : Infinity;
    this.roomCap = this.capacityIsCap
      ? this.roomCapacity
      : scaled > this.cap
        ? Number(this.cap / this.uBig)
        : Infinity;
  }

  /** Leave the uniform regime for the float one. */
  private toFloat(): void {
    const [m, e] = floatOf(this.uBig);
    let x = m * this.uNum;
    let E = e;
    if (x >= STEP_UP) {
      x *= STEP_DOWN;
      E += STEP;
    }
    this.v = x;
    this.u = x;
    this.s = x;
    this.tight = x;
    this.E = E;
    this.ops = 2;
    this.regime = Regime.Float;
  }

  /** Float regime: the candidate for `k` states. */
  private candidate(k: number): number {
    return this.v + this.u * (k - 1);
  }

  /**
   * Recompute the exact bound from the block's recorded symbols and stay
   * exact for the rest of the block.
   */
  private goExact(): void {
    let V = 1n;
    let U = 1n;
    let S = 1n;
    let den = 1n;
    let tightV = 1n;
    let tightDen = 1n;
    for (let i = 0; i < this.n; i++) {
      const total = BigInt(this.recTotal[i]);
      const freq = this.recFreq[i];
      const c = V + U * (total - 1n);
      if (i === this.n - 1) {
        const asIndex = this.lastCount < this.recTotal[i] ? V + U * BigInt(this.lastCount - 1) : c;
        tightV = S < asIndex ? asIndex : S;
        tightDen = den;
      }
      if (S < c) {
        S = c;
      }
      if (freq === 1) {
        V = c;
      } else {
        const freqBig = BigInt(freq);
        V = (V + U * (total - freqBig)) * freqBig;
        S *= freqBig;
        den *= freqBig;
      }
      U *= total;
    }
    this.V = V;
    this.U = U;
    this.S = S;
    this.den = den;
    this.tightV = tightV;
    this.tightDen = tightDen;
    this.capDen = this.cap * den;
    this.capacityDen = this.capacity * den;
    this.regime = Regime.Exact;
  }

  /**
   * The fewest d with den·base^d ≥ x. The search starts one below the
   * digit count of the bit-length estimate, which no float rounding of the
   * estimate can lift to the answer, and walks up.
   */
  private exactDigits(x: bigint, den: bigint): number {
    const powers = this.powers;
    let d = Math.max(0, Math.floor((bitLength(x) - bitLength(den) - 1) / this.log2Base) - 1);
    powers.ensure(d + 1);
    if (den === 1n) {
      while (powers.big[d] < x) {
        d++;
        powers.ensure(d + 1);
      }
      return d;
    }
    while (den * powers.big[d] < x) {
      d++;
      powers.ensure(d + 1);
    }
    return d;
  }

  /**
   * The fewest d with base^d ≥ x·2^E for a scaled double within k error
   * units, or -1 when the margins cannot settle it. The search starts one
   * below the digit count of the logarithm estimate, which no rounding of
   * the logarithm can lift to the answer, and walks up while the value is
   * certainly above the power; the first power it is certainly not above
   * is the answer, with the one below it certainly exceeded.
   */
  private floatDigits(x: number, k: number): number {
    const powers = this.powers;
    let d = Math.max(0, Math.floor((Math.log2(x) + this.E) / this.log2Base) - 1);
    for (;;) {
      powers.ensure(d + 1);
      const above = compareFloat(x, this.E, powers.m[d], powers.e[d], k);
      if (above === 0) {
        return -1;
      }
      if (above < 0) {
        return d;
      }
      d++;
    }
  }
}
