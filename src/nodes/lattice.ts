import { Encoder, Decoder, CorruptInputError } from '../packer';
import { RangePrior, checkIndex, checkRange, priorKind, type Prior } from './weights';
import {
  AdaptivePrior,
  MAX_ADAPTIVE_MEMBERS,
  checkAdaptation,
  checkAdaptiveMembers,
  lineageOf,
  type Learning,
} from './adaptive';
import { LearnedMagnitude, magnitude, type Magnitude } from './magnitude';
import {
  ModeChoice,
  Previous,
  chooses,
  learningOf,
  recallOf,
  type Method,
  type MethodName,
  type MethodSet,
  type ValueProvider,
} from './methods';
import { Recall } from './recall';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/**
 * The two slots of a range of exactly 2^53 values: a radix is a safe
 * integer, and 2^53 is one past the largest, so the offset packs as two
 * digits whose radices multiply to it, at the same 53 bits.
 */
const SPLIT_HIGH = 2 ** 26;
const SPLIT_LOW = 2 ** 27;

/** A range's learned odds of an offset, coded through and taught apart. */
type LearnedOdds = Method<number> & ValueProvider<number>;

/**
 * A narrow range's learned odds: each offset from the range's min a member
 * of an adaptive prior over the range.
 */
class LearnedMembers implements LearnedOdds {
  constructor(private readonly prior: AdaptivePrior) {}

  available(): boolean {
    return true;
  }

  write(enc: Encoder, offset: number): void {
    this.prior.write(enc, offset);
  }

  read(dec: Decoder): number {
    return this.prior.read(dec);
  }

  learn(side: Encoder | Decoder, offset: number): void {
    this.prior.learn(side, offset);
  }
}

/**
 * A wide or unbounded range's learned scale: each offset on the learned
 * magnitude scale from the range's origin, over the offsets `[low, high]`
 * the range reaches.
 */
class LearnedOffsets implements LearnedOdds {
  constructor(
    private readonly scale: Magnitude,
    private readonly low: number,
    private readonly high: number
  ) {}

  available(): boolean {
    return true;
  }

  write(enc: Encoder, offset: number): void {
    this.scale.write(enc, offset, 0, this.low, this.high);
  }

  read(dec: Decoder): number {
    return this.scale.read(dec, 0, this.low, this.high);
  }

  learn(side: Encoder | Decoder, offset: number): void {
    this.scale.learn(side, offset, 0, this.low, this.high);
  }
}

/**
 * One integer index on the shared lattice wire, against optional [min, max]
 * bounds and optionally under a prior: the half of PInt, PDecimal, PDate,
 * p.versioned and every length prefix that is not about mapping a value to
 * its index. Both bounds -> one slot of exact radix, or two whose radices
 * multiply to 2^53 for the widest range, one state past what a radix holds;
 * one bound -> a term counting away from it (downward from a max, so the
 * term stays non-negative); unbounded -> sign before magnitude, the order
 * every signed value on the wire reads. Every bounded integer packs through
 * here, so their layouts can never drift apart. The range is validated once
 * here, and `write`/`read` check the bounds and pack the index, uniformly or
 * weighted. `show` spells an index as the value it stands for in an error.
 * Adaptive options turn the prior adaptive: over a range of at most
 * `MAX_ADAPTIVE_MEMBERS` values or under declared weights, an adaptive
 * prior over the range, the declared weights or even ones, with the values
 * a message codes learned on top; over a wider or unbounded range, the
 * learned magnitude scale from the range's origin. Coding learns nothing:
 * the range's owner teaches it each index through `learn`.
 */
export class IndexRange {
  readonly lo?: number;
  readonly hi?: number;
  /**
   * The prior as given, in every mode (static, cdf or adaptive), so a node
   * rebuilding the range after a bound change passes it on.
   */
  readonly declared?: Prior;
  readonly prior?: RangePrior;
  /**
   * What the prior learns under, set when it adapts; the weights then live
   * in `learned`, not `prior`.
   */
  readonly learning?: Learning;
  /** The one radix an index packs in: both bounds, no prior or adaptive options, fewer than 2^53 values. */
  readonly radix?: number;
  /** Set with `radix`: the index `digit` steps above min, as a digit read in `radix` stands for. */
  readonly fromDigit?: (digit: number) => number;
  /**
   * Set with `radix`: the digit `write` composes for `index`, throwing exactly
   * as `write` would.
   */
  readonly toDigit?: (index: number, subject?: () => string) => number;
  /**
   * The index offsets count from: the min, else the max, else 0. An offset
   * is a safe integer, so a range reaching past 2^53 - 1 from its origin
   * offsets only the indices within that reach.
   */
  readonly origin: number;
  /** The lowest offset the range reaches: 0 from a min, else the safe integers' end. */
  readonly low: number;
  /** The highest offset the range reaches: the span between both bounds, 0 from a lone max, else the safe integers' end. */
  readonly high: number;
  /** Set with `learning`: the learned odds of an index's offset, which `write` and `read` code through and `learn` teaches. */
  readonly learned?: LearnedOdds;
  private readonly show: (index: number) => string;

  constructor(
    who: string,
    lo?: number,
    hi?: number,
    prior?: Prior,
    learning?: Learning,
    show: (index: number) => string = String
  ) {
    checkRange(who, lo, hi, show);
    if (prior !== undefined && (lo === undefined || hi === undefined)) {
      throw new TypeError(`${who} ${priorKind(prior)} requires both bounds`);
    }
    this.origin = lo ?? hi ?? 0;
    this.low = lo === undefined ? -MAX_SAFE : 0;
    this.high = hi === undefined ? MAX_SAFE : hi - this.origin;
    if (learning !== undefined) {
      const { window } = checkAdaptation(learning, who);
      if (typeof prior === 'function') {
        throw new TypeError(`${who} adaptive takes weights, not a cdf`);
      }
      if (
        lo !== undefined &&
        hi !== undefined &&
        (prior !== undefined || hi - lo < MAX_ADAPTIVE_MEMBERS)
      ) {
        const n = hi - lo + 1;
        checkAdaptiveMembers(n, who);
        const weights = prior ?? new Array<number>(n).fill(1);
        this.learned = new LearnedMembers(
          new AdaptivePrior([weights], n, window, who, lineageOf(learning))
        );
      } else {
        const scale = new LearnedMagnitude(lo === undefined, learning, who);
        this.learned = new LearnedOffsets(scale, this.low, this.high);
      }
      this.learning = learning;
    } else if (prior !== undefined) {
      this.prior = new RangePrior(prior, lo as number, hi as number, who, show);
    }
    this.declared = prior;
    this.lo = lo;
    // A max of -0 reads back as max - 0, itself -0; stored as 0, no index
    // decodes as -0.
    this.hi = hi === undefined ? undefined : hi + 0;
    if (
      lo !== undefined &&
      hi !== undefined &&
      prior === undefined &&
      learning === undefined &&
      hi - lo < MAX_SAFE
    ) {
      this.radix = hi - lo + 1;
      this.fromDigit = (digit) => lo + digit;
      this.toDigit = (index, subject = () => `Value ${show(index)}`) => {
        checkIndex(index, lo, hi, subject, show);
        return index - lo;
      };
    }
    this.show = show;
  }

  /** Whether `index` lies a safe integer's offset from the origin, which adds back to it exactly. */
  reaches(index: number): boolean {
    const offset = index - this.origin;
    return Number.isSafeInteger(offset) && this.origin + offset === index;
  }

  /**
   * The offset of `index` from the origin, refusing an index outside the
   * bounds or out of the origin's exact reach; -0 offsets as 0. `subject`
   * names the value in an error, as `write` takes it.
   */
  offset(index: number, subject: () => string = () => `Value ${this.show(index)}`): number {
    checkIndex(index, this.lo, this.hi, subject, this.show);
    if (!this.reaches(index)) {
      throw new RangeError(
        `${subject()} is too far from ${this.show(this.origin)} to encode exactly`
      );
    }
    return index - this.origin + 0;
  }

  /** The index `offset` stands for, read off the wire: a CorruptInputError when it does not add back exactly. */
  fromOffset(offset: number): number {
    const index = this.origin + offset;
    if (index - this.origin !== offset) {
      throw new CorruptInputError('Index offset is outside the exact range of its origin');
    }
    return index;
  }

  /** `subject` names the value in an error, as in `Date 2020-01-01T00:00:00.000Z`. */
  write(
    enc: Encoder,
    index: number,
    subject: () => string = () => `Value ${this.show(index)}`
  ): void {
    if (this.prior !== undefined) {
      this.prior.write(enc, index, subject);
      return;
    }
    if (this.learned !== undefined) {
      this.learned.write(enc, this.offset(index, subject));
      return;
    }
    checkIndex(index, this.lo, this.hi, subject, this.show);
    this.writeIndex(enc, index);
  }

  read(dec: Decoder): number {
    if (this.learned !== undefined) {
      return this.fromOffset(this.learned.read(dec));
    }
    return this.prior === undefined ? this.readIndex(dec) : this.prior.read(dec);
  }

  /** Learns `index`, just written or read, where the odds learn. */
  learn(side: Encoder | Decoder, index: number): void {
    this.learned?.learn(side, index - this.origin + 0);
  }

  /** Packs `index`, an integer within the bounds as `write` checked. */
  private writeIndex(enc: Encoder, index: number): void {
    const { lo, hi } = this;
    if (lo !== undefined && hi !== undefined) {
      const offset = index - lo;
      if (hi - lo < MAX_SAFE) {
        enc.compose(offset, hi - lo + 1);
      } else {
        enc.compose(Math.floor(offset / SPLIT_LOW), SPLIT_HIGH);
        enc.compose(offset % SPLIT_LOW, SPLIT_LOW);
      }
    } else if (lo !== undefined) {
      const offset = index - lo;
      // Float subtraction rounds once the offset passes 2^53, which would
      // silently encode a neighbouring value, so anything that cannot
      // reconstruct exactly is refused; the check IS the decode expression.
      if (lo + offset !== index) {
        throw new RangeError(
          `Value ${this.show(index)} is too far from its bound ${this.show(lo)} to encode exactly`
        );
      }
      enc.composeTerm(offset);
    } else if (hi !== undefined) {
      const offset = hi - index;
      if (hi - offset !== index) {
        throw new RangeError(
          `Value ${this.show(index)} is too far from its bound ${this.show(hi)} to encode exactly`
        );
      }
      enc.composeTerm(offset);
    } else {
      // -0 fails `index < 0` and packs as 0, as it does through the bounded
      // branches' subtractions, so callers pass it unnormalised.
      enc.compose(index < 0 ? 1 : 0, 2);
      enc.composeTerm(Math.abs(index));
    }
  }

  /** Reads an index without a prior, in the layout `writeIndex` packs. */
  private readIndex(dec: Decoder): number {
    const { lo, hi } = this;
    if (lo !== undefined && hi !== undefined) {
      if (hi - lo < MAX_SAFE) {
        return lo + dec.parse(hi - lo + 1);
      }
      return lo + dec.parse(SPLIT_HIGH) * SPLIT_LOW + dec.parse(SPLIT_LOW);
    }
    if (lo !== undefined) {
      const offset = dec.parseTerm();
      const index = lo + offset;
      // Counterpart of the encode-side exactness guard: an offset whose sum
      // rounds could never have been emitted.
      if (index - lo !== offset) {
        throw new CorruptInputError('Term offset is outside the exact range of its bound');
      }
      return index;
    }
    if (hi !== undefined) {
      const offset = dec.parseTerm();
      const index = hi - offset;
      if (hi - index !== offset) {
        throw new CorruptInputError('Term offset is outside the exact range of its bound');
      }
      return index;
    }
    const negative = dec.parse(2) === 1;
    const magnitude = dec.parseTerm();
    // A signed zero reads as 0; negating zero is the only way -0 could arise.
    return negative && magnitude !== 0 ? -magnitude : magnitude;
  }
}

/**
 * The difference of an index from the node's previous one: the offset on
 * a magnitude scale whose origin is the previous offset, over the offsets
 * the range reaches, so a side or class the bounds rule out costs nothing.
 * Codes from the node's second value in a message on. Each offset it
 * learns teaches the scale its difference from the previous offset, then
 * becomes the previous offset.
 */
export class Delta implements Method<number>, ValueProvider<number> {
  /** The offset the next difference counts from. */
  private readonly previous = new Previous<number>();

  constructor(
    private readonly scale: Magnitude,
    private readonly low: number,
    private readonly high: number
  ) {}

  /** Counts the next difference on `side` from `offset`, in place of the previous offset. */
  from(side: Encoder | Decoder, offset: number): void {
    this.previous.learn(side, offset);
  }

  available(side: Encoder | Decoder): boolean {
    return this.previous.get(side) !== undefined;
  }

  write(enc: Encoder, offset: number): void {
    this.scale.write(enc, offset, this.previous.get(enc) as number, this.low, this.high);
  }

  read(dec: Decoder): number {
    return this.scale.read(dec, this.previous.get(dec) as number, this.low, this.high);
  }

  learn(side: Encoder | Decoder, offset: number): void {
    const origin = this.previous.swap(side, offset);
    if (origin !== undefined) {
      this.scale.learn(side, offset, origin, this.low, this.high);
    }
  }
}

/** The methods of a lattice node, which `.adaptive()` opens. */
export const INDEX_METHODS: readonly MethodName[] = ['learn', 'delta', 'recall'];

/**
 * The methods a lattice node spells its indices by, over its range: by
 * default the range's own spelling. `.delta()` spells every value after
 * the node's first in the message as its difference from the previous
 * one, on the static magnitude scale, or the learned one where the node
 * learns; it takes no weights or cdf. With the delta open, a mode picks
 * per value between the plain spelling and the difference. With
 * `.recall()`, a value the node already wrote in the message is spelled by
 * its place among those values first, a new one then by the other methods.
 * Every value, recalled or spelled, then teaches the range's learned odds
 * and the difference, in that order, so the previous value is the last
 * the node coded.
 */
export class IndexMethods {
  /** Set by a declared or open delta: the difference, and the previous offset it counts from. */
  private readonly delta?: Delta;
  /** Set by an open delta: the mode between plain, 0, and the difference, 1. */
  private readonly mode?: ModeChoice<number>;
  private readonly recall?: Recall<number>;
  /** What every value the node codes teaches, by its offset from the range's origin, in order. */
  private readonly providers: readonly ValueProvider<number>[];
  /** Whether no method is declared, so every value spells as the range writes it. */
  readonly plain: boolean;

  constructor(
    readonly range: IndexRange,
    methods: MethodSet,
    who: string
  ) {
    const { declared, learned } = range;
    const learning = learningOf(methods);
    if (methods.delta === 'declared' && declared !== undefined) {
      throw new TypeError(`${who} delta takes no ${priorKind(declared)}`);
    }
    if (methods.delta !== undefined) {
      this.delta = new Delta(magnitude(learning, true, who), range.low, range.high);
    }
    if (chooses(methods, ['delta'])) {
      // `.adaptive()` opens the delta with the range's learned odds.
      this.mode = new ModeChoice([learned as LearnedOdds, this.delta as Delta], learning, who);
    }
    const providers: ValueProvider<number>[] = [];
    if (learned !== undefined) {
      providers.push(learned);
    }
    if (this.delta !== undefined) {
      providers.push(this.delta);
    }
    this.providers = providers;
    this.recall = recallOf(methods);
    this.plain = methods.delta !== 'declared' && this.recall === undefined;
  }

  /** Writes `index`; `subject` names the value in an error, as the range's `write` takes it. */
  write(enc: Encoder, index: number, subject?: () => string): void {
    const { recall, providers } = this;
    // The providers learn offsets, so every index must lie within the
    // origin's exact reach.
    const offset = providers.length === 0 ? index : this.range.offset(index, subject);
    if (recall === undefined) {
      this.spell(enc, index, offset, subject);
    } else {
      // An index that does not encode is never seen, so it never matches.
      recall.write(enc, String(index + 0), () => this.spell(enc, index, offset, subject));
    }
    this.after(enc, offset);
  }

  /** Teaches every provider the value at `offset` from the origin, just coded. */
  private after(side: Encoder | Decoder, offset: number): void {
    for (const provider of this.providers) {
      provider.learn(side, offset);
    }
  }

  /** Writes `index`, at `offset` from the origin, by the mode, the difference, or the range. */
  private spell(enc: Encoder, index: number, offset: number, subject?: () => string): void {
    const { delta, mode } = this;
    if (mode !== undefined) {
      mode.write(enc, offset);
    } else if (delta?.available(enc) === true) {
      delta.write(enc, offset);
    } else {
      this.range.write(enc, index, subject);
    }
  }

  read(dec: Decoder): number {
    const { recall } = this;
    const index =
      recall === undefined ? this.unspell(dec) : recall.read(dec, () => this.unspell(dec));
    if (this.providers.length > 0) {
      // The encoder refuses an index out of the origin's exact reach.
      if (!this.range.reaches(index)) {
        throw new CorruptInputError('Index is outside the exact range of its origin');
      }
      this.after(dec, index - this.range.origin + 0);
    }
    return index;
  }

  /** Reads an index `spell` wrote. */
  private unspell(dec: Decoder): number {
    const { delta, mode } = this;
    if (mode !== undefined) {
      return this.range.fromOffset(mode.read(dec));
    }
    if (delta?.available(dec) === true) {
      return this.range.fromOffset(delta.read(dec));
    }
    return this.range.read(dec);
  }
}

/** The declared bounds of a length or count; a fixed length is min === max. */
export interface LengthBounds {
  readonly min?: number;
  readonly max?: number;
  readonly prior?: Prior;
}

/** A length or count bound: a non-negative integer, checked at definition. */
export const lengthBound = (
  n: number | undefined,
  who: string,
  which: string
): number | undefined => {
  if (n === undefined) {
    return undefined;
  }
  if (!Number.isInteger(n)) {
    throw new TypeError(`${who} ${which} must be a non-negative integer, got ${n}`);
  }
  if (n < 0) {
    throw new RangeError(`${who} ${which} must be a non-negative integer, got ${n}`);
  }
  return n;
};

/**
 * The range of a string, byte-run or array length, its floor defaulting to
 * 0, learning under `learning`. `noun` names the quantity in an error, as
 * in `p.array weights requires a max count`.
 */
export function lengthRange(
  bounds: LengthBounds,
  who: string,
  noun: string,
  learning?: Learning
): IndexRange {
  const min = lengthBound(bounds.min, who, 'min');
  const max = lengthBound(bounds.max, who, 'max');
  const { prior } = bounds;

  if (prior !== undefined && max === undefined) {
    throw new TypeError(`${who} ${priorKind(prior)} requires a max ${noun}`);
  }
  return new IndexRange(who, min ?? 0, max, prior, learning);
}

/** Refuses a second `min`, `max` or order restriction on one node: each is set once. */
export function checkUnset(
  current: unknown,
  who: string,
  bound: 'min' | 'max' | 'sorted' | 'unique' | 'unordered'
): void {
  if (current !== undefined) {
    throw new TypeError(`${who} ${bound} is already set`);
  }
}
