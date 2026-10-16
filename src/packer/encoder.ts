/**
 * The write-side packer primitive. Values are pushed as (integer, radix)
 * pairs via `compose`/`composeTerm`, or as weighted symbols via
 * `composeWeighted`, into a log of buckets; `output` folds the log into
 * digits. Schema nodes drive this — it knows nothing about types.
 *
 * The fold is the streaming rANS of `StreamWriter`: a weighted symbol owning
 * `freq` of `total` states costs log2(total/freq) bits, because the position
 * inside its bucket carries the next value's information instead of being
 * wasted. A uniform slot is the case freq = 1, which reduces the update to
 * plain multiply-add, which is mixed-radix arithmetic. The log keeps each
 * symbol's bucket and whether it is uniform or weighted, which is all the
 * fold needs; until `output`, a slot can still be patched.
 *
 * Writes can be tried: `mark` opens a transaction, `bitsSince` prices what
 * was written since, and `rollback` takes it all back, the log and every
 * change the writes made to the message's state, through the `journal`
 * nodes record their changes in. `commit` keeps it. `decide` builds a
 * choice among spellings on them.
 *
 * `composeMixture` writes a value several ways at once and leaves the
 * choice to the fold, which takes it off the state it folds onto. The
 * decoder, having read the value, puts the choice back with
 * `Decoder.parseMixture`, so the bits the choice took are recovered.
 */

import type { Bucket, CodecOptions, OutputType, Radix } from './types';
import {
  TERM_BASE,
  TERM_ESCAPE_MIN,
  TERM_PAYLOAD_BASE,
  TERM_PAYLOAD_MIN_DIGITS,
} from './constants';
import {
  BIG_CHUNK_BITS,
  ScaledRatio,
  bigRadix,
  outputAlphabet,
  validateChecksum,
  checksumOf,
  costUnits,
} from './utils';
import { StreamWriter, type Spelling } from './stream';
import { MixtureLayout } from './mixture';
import { MessageState, checkKey } from './state';
import { Journal } from './journal';

const ONE = 1 as Radix;
const BIG_CHUNK_STATES = 2 ** BIG_CHUNK_BITS;

/** Rejects a bucket `[cum, cum + freq)` that does not lie in `[0, total)` or is empty. */
function checkBucket(cum: number, freq: number, total: number): void {
  if (!Number.isInteger(total) || !Number.isInteger(freq) || !Number.isInteger(cum)) {
    throw new TypeError(`Bucket must be integers, got cum ${cum}, freq ${freq}, total ${total}`);
  }
  if (total < 1 || total > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Total ${total} is not a positive safe integer`);
  }
  if (freq < 1) {
    throw new RangeError(`Frequency ${freq} is not positive`);
  }
  if (cum < 0 || cum + freq > total) {
    throw new RangeError(`Bucket [${cum}, ${cum + freq}) is outside [0, ${total})`);
  }
}

/**
 * An encoder's log, as `ReplayDecoder` and a value's identity read it:
 * event `i` is the bucket `[cums[i], cums[i] + freqs[i])` of `totals[i]`
 * states, a weighted symbol when `weighted[i]`, else a uniform slot with a
 * freq of 1. A symbol of an alternatives group holds coding 0's bucket
 * until `output` settles the group. A mixture reads as the spelling of its
 * heaviest choice, then that choice's bucket among the mixture's weights.
 */
export interface EventLog {
  readonly cums: readonly number[];
  readonly freqs: readonly number[];
  readonly totals: readonly number[];
  readonly weighted: readonly boolean[];
}

/** An open transaction of an encoder, as `mark` returns it. */
export interface Mark {
  /** The events logged before it. */
  readonly events: number;
  /** The alternatives pending before it. */
  readonly pending: number;
  /** The groups opened before it. */
  readonly groups: number;
  /** The mixtures written before it. */
  readonly mixtures: number;
  /** What each try `decide` runs around it had spent, as it stood. */
  readonly running?: readonly number[];
  /** Its mark in the journal. */
  readonly journal: number;
}

/** What an encoder takes beyond the defaults. */
export interface EncoderOptions {
  /**
   * Whether `decide` checks its shortcuts instead of taking them: every
   * candidate is tried in full, with no budget to abort it, and a spelling
   * written again decides each choice inside it afresh, throwing when one
   * differs from the choice its try made. For tests: the message comes out
   * as without, at the cost of every try the shortcuts save.
   */
  readonly checkDecisions?: boolean;
}

/**
 * The coding an alternatives symbol or a selector is priced in by
 * `bitsSince`, or the last when a group has fewer: the coding a group
 * settles on is known only at `output`, and 2 is a middle learner among an
 * adaptive prior's.
 */
const PRICED_CODING = 2;

/**
 * The units costs are counted in, per bit: each symbol's cost is rounded
 * to a whole number of them, so sums are exact integers, the same in any
 * order and never smaller for one more symbol, up to 2^33 bits.
 */
const UNITS = 2 ** 20;

/** The cost of a symbol owning `freq` of `total` states, in `UNITS`. */
const unitsOf = (total: number, freq: number): number => costUnits(freq, total);

/** The cost of `bucket`, in `UNITS`. */
const bucketUnits = (bucket: Bucket): number => unitsOf(bucket[2], bucket[1]);

/**
 * Thrown into the innermost try of `decide` running when a budget is
 * passed: `level` is the try's own depth when its own budget is passed,
 * else the outermost depth whose budget is. Not an Error, so containers
 * pass it on as thrown.
 */
class Abort {
  constructor(readonly level: number) {}
}

/** One `decide` under way. */
interface Trial {
  readonly priority: readonly number[];
  readonly write: (choice: number) => void;
  /** Its depth among the tries running: its tries' place in `running`. */
  readonly level: number;
  /** The cheapest candidate so far, -1 before any wrote, and its cost in `UNITS`. */
  best: number;
  least: number;
  /** The choices made inside the best candidate's try. */
  kept: number[];
  /** Whether the best candidate's try was kept as written. */
  done: boolean;
  /** What each candidate that could not write threw. */
  readonly failures: Map<number, unknown>;
  /** Whether an outer budget stopped a candidate. */
  stopped: boolean;
}

/** A value written by `composeMixture`, its choice left to the fold. */
interface Mixture {
  /** Its slots in the log: the heaviest choice's spelling from `start`, its own symbol at `at`. */
  readonly start: number;
  readonly at: number;
  readonly layout: MixtureLayout;
  /** Each choice's spelling, none for a choice of weight 0. */
  readonly spellings: readonly (Spelling | undefined)[];
  /** What it costs in `UNITS`, as `bitsSince` prices it. */
  readonly units: number;
}

/**
 * The cost in `UNITS` of a mixture whose choices' spellings cost `units`:
 * −log2 of the sum of their probabilities, which is what a choice costs
 * less the bits its weight gives back when the weights are those
 * probabilities, and never below 0.
 */
function mixtureUnits(units: readonly number[]): number {
  const least = Math.min(...units);
  let sum = 0;
  for (const u of units) {
    sum += 2 ** ((least - u) / UNITS);
  }
  return Math.max(0, Math.round(least - Math.log2(sum) * UNITS));
}

/** A symbol written as one of its group's alternative buckets, waiting for the group's choice. */
interface Alternative {
  /** The symbol's slot in the buffer. */
  at: number;
  group: object;
  buckets: readonly Bucket[];
}

export class Encoder {
  private cums: number[] = [];
  private freqs: Radix[] = [];
  private totals: Radix[] = [];
  /** Whether each symbol is weighted, read by `parseWeighted`, rather than a uniform slot. */
  private weighted: boolean[] = [];
  /** Where the message's state records its changes while a transaction is open. */
  readonly journal = new Journal();
  private readonly states = new MessageState(this.journal);
  /**
   * The groups opened by `composeSelector`: the selector's slot in the
   * buffer, -1 when it carries nothing (a single coding whose bucket holds
   * every state), and the selector's bucket under each coding.
   */
  private readonly groups = new Map<object, { at: number; choices: readonly Bucket[] }>();
  /** The groups in the order they were opened. */
  private readonly opened: object[] = [];
  /** The alternative symbols written since the last `output`, in buffer order. */
  private pending: Alternative[] = [];
  /** The mixtures written so far, in buffer order. */
  private readonly mixtures: Mixture[] = [];
  /** Whether `composeMixture` is writing its spellings. */
  private mixing = false;
  /** The choices `decide` made in the try running now, each followed by those inside it. */
  private tape?: number[];
  /** Set while a spelling `decide` tried is written again: its choices, and the next to take. */
  private replay?: { readonly tape: readonly number[]; at: number };
  private readonly checkDecisions: boolean;
  /** The `UNITS` each try `decide` runs has spent so far, outermost first. */
  private readonly running: number[] = [];
  /** The budget of each such try: the cost of the best candidate before it, or none. */
  private readonly limits: number[] = [];
  /** Whether each such try wins a tie with its budget. */
  private readonly ties: boolean[] = [];

  constructor(options: EncoderOptions = {}) {
    this.checkDecisions = options.checkDecisions === true;
  }

  /** Per-message state for nodes, keyed by node identity; see `MessageState`. */
  state<S>(key: object, init: () => S): S {
    return this.states.get(key, init);
  }

  /** The message's provider under `key`, `kind|key`; see `MessageState.provider`. */
  provider<S>(key: string, init: () => S): S {
    return this.states.provider(key, init);
  }

  /** How many slots of the message state were dropped so far; see `SlotCache`. */
  get stateEpoch(): number {
    return this.states.epoch;
  }

  /** Push one value in a fixed radix: `integer` must lie in `[0, radix)`. */
  compose(integer: number, radix: number): void {
    // An out-of-range value would not throw on its own; it would silently
    // corrupt every value packed after it, so it fails here, at the source.
    // The same check as `radixOf`, inline: compose runs once per value, and
    // the call measurably slows it.
    if (!Number.isInteger(radix)) {
      throw new TypeError(`Radix must be an integer, got ${radix}`);
    }
    if (radix < 1 || radix > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Radix ${radix} is not a positive safe integer`);
    }
    const states = radix as Radix;
    if (!Number.isInteger(integer)) {
      throw new TypeError(`Digit must be an integer, got ${integer}`);
    }
    if (integer < 0 || integer >= radix) {
      throw new RangeError(`Digit ${integer} is outside [0, ${radix})`);
    }
    // A radix-1 digit carries nothing, and the fold takes no bucket that
    // holds every state.
    if (radix === 1) {
      return;
    }

    this.cums.push(integer);
    this.freqs.push(ONE);
    this.totals.push(states);
    this.weighted.push(false);
    if (this.running.length > 0) {
      this.charge(unitsOf(states, 1));
    }
  }

  /**
   * Push one value in a radix of any size: `index` must lie in
   * `[0, radix)`. A safe radix is one `compose`; a larger one is a top digit
   * and low chunks, most significant first, as `bigRadix` lays them out.
   */
  composeBig(index: bigint, radix: bigint): void {
    if (radix < 1n) {
      throw new RangeError(`Radix ${radix} is not positive`);
    }
    if (index < 0n || index >= radix) {
      throw new RangeError(`Digit ${index} is outside [0, ${radix})`);
    }
    const { chunks, top } = bigRadix(radix);
    this.compose(Number(index >> BigInt(BIG_CHUNK_BITS * chunks)), top);
    for (let i = chunks - 1; i >= 0; i--) {
      this.compose(
        Number(BigInt.asUintN(BIG_CHUNK_BITS, index >> BigInt(BIG_CHUNK_BITS * i))),
        BIG_CHUNK_STATES
      );
    }
  }

  /**
   * Push one weighted symbol: the bucket `[cum, cum + freq)` out of `total`
   * states. Costs log2(total/freq) bits — fractional, exact. The decoder
   * recovers the symbol from which bucket the residual lands in, so both
   * sides must derive identical integer tables.
   */
  composeWeighted(cum: number, freq: number, total: number): void {
    checkBucket(cum, freq, total);
    // A bucket holding every state carries nothing, like a radix-1 digit.
    if (freq === total) {
      return;
    }

    // Total is a radix, and freq lies in [1, total).
    this.cums.push(cum);
    this.freqs.push(freq as Radix);
    this.totals.push(total as Radix);
    this.weighted.push(true);
    if (this.running.length > 0) {
      this.charge(unitsOf(total, freq));
    }
  }

  /**
   * Open a choice among codings for `group`, the node that spells its
   * symbols more than one way (a static prior and an adaptive one, say).
   * `choices[i]` is the bucket the selector is written as under coding i;
   * the buckets share one total, and coding i is member i among
   * `choices.length`. The node writes the selector once,
   * before the group's first symbol, then each symbol through
   * `composeAlternatives` as the bucket every coding gives it. At `output`
   * the encoder keeps the coding whose selector and symbols cost the fewest
   * bits, the lowest index on a tie, and writes its bucket as the selector.
   * The decoder reads the selector as the weighted symbol it is, and then
   * knows how to read the rest. A group is opened at most once per message.
   */
  composeSelector(group: object, choices: readonly Bucket[]): void {
    checkKey(group, 'Group');
    if (this.groups.has(group)) {
      throw new TypeError('Group already has a selector');
    }
    const count = choices.length;
    if (count === 0) {
      throw new RangeError('Selector needs at least one coding');
    }
    const total = choices[0][2];
    for (const [cum, freq, t] of choices) {
      checkBucket(cum, freq, t);
      if (t !== total) {
        throw new RangeError(`Selector buckets share one total, got ${t} after ${total}`);
      }
      if (count > 1 && freq === t) {
        throw new RangeError(`Selector bucket [${cum}, ${cum + freq}) holds every state`);
      }
    }
    // The placeholder is the selector for coding 0; `resolve` patches in the
    // choice. A lone coding whose bucket holds every state records nothing,
    // like any radix-1 digit.
    const [cum, freq] = choices[0];
    const logged = freq !== total;
    if (logged) {
      this.cums.push(cum);
      this.freqs.push(freq as Radix);
      this.totals.push(total as Radix);
      this.weighted.push(true);
    }
    this.groups.set(group, { at: logged ? this.totals.length - 1 : -1, choices });
    this.opened.push(group);
    if (logged && this.running.length > 0) {
      this.charge(bucketUnits(choices[Math.min(PRICED_CODING, count - 1)]));
    }
  }

  /**
   * Push one symbol of the group opened by `composeSelector`, as the bucket
   * each coding gives it: `buckets[i]` is the symbol under coding i. Every
   * bucket carries information, so the symbol takes a slot whichever coding
   * wins.
   */
  composeAlternatives(group: object, buckets: readonly Bucket[]): void {
    const opened = this.groups.get(group);
    if (opened === undefined) {
      throw new TypeError('Group has no selector');
    }
    if (buckets.length !== opened.choices.length) {
      throw new TypeError(
        `Group has ${opened.choices.length} codings, got ${buckets.length} alternative buckets`
      );
    }
    for (const [cum, freq, total] of buckets) {
      checkBucket(cum, freq, total);
      if (freq === total) {
        throw new RangeError(`Alternative bucket [${cum}, ${cum + freq}) holds every state`);
      }
    }

    // The placeholder carries coding 0's bucket until `resolve` patches in the choice.
    const [cum, freq, total] = buckets[0];
    this.cums.push(cum);
    this.freqs.push(freq as Radix);
    this.totals.push(total as Radix);
    this.weighted.push(true);
    this.pending.push({ at: this.totals.length - 1, group, buckets });
    if (this.running.length > 0) {
      this.charge(bucketUnits(buckets[Math.min(PRICED_CODING, buckets.length - 1)]));
    }
  }

  /**
   * Write a value as a mixture of its spellings: `write(j)` writes it as
   * choice j, and choice j has weight `weights[j]`, a non-negative integer,
   * the weights summing to a positive safe integer. The fold takes a choice
   * with probability its weight over their sum, off the bits the symbols
   * after the value left on the state, and writes its spelling. The decoder
   * reads the spelling, and with it the value and the choice, and hands
   * both to `Decoder.parseMixture` with the same weights, which puts the
   * choice back and so recovers −log2 of its probability. When the weights
   * are the spellings' probabilities, the value costs −log2 of their sum.
   * Where nothing follows the mixture, there is nothing to take a choice
   * off, and the fold spells the heaviest choice.
   *
   * Every choice of positive weight is written, each from the message state
   * as it stands, and whatever a spelling changes in it is taken back: the
   * state after the value must not depend on the choice. A spelling writes
   * plain symbols only, no selector, alternatives or mixture. A lone choice
   * of positive weight is written as it is, and the decoder reads nothing
   * more for it.
   */
  composeMixture(weights: readonly number[], write: (choice: number) => void): void {
    const layout = new MixtureLayout(weights);
    if (layout.only >= 0) {
      write(layout.only);
      return;
    }
    this.mix(
      weights.map((weight) => weight > 0),
      write,
      () => layout
    );
  }

  /**
   * `composeMixture` of `count` choices whose weights follow from what
   * their spellings cost: every choice is written, then `weigh` gets each
   * one's cost in `COST_UNITS`, as `bitsSince` prices it times 2^20, and
   * returns the weights, `count` of them. Where only one has positive
   * weight, its spelling is the value's, with no choice to put back.
   *
   * Choice `kept`, when given, keeps what its spelling changes in the
   * message state, and the choices after it are written from the state it
   * leaves: for a value whose state after it is the one that spelling
   * leaves, which the caller would otherwise teach it again. Where any
   * spelling throws, every change is taken back.
   */
  composePriced(
    count: number,
    weigh: (units: readonly number[]) => readonly number[],
    write: (choice: number) => void,
    kept = -1
  ): void {
    this.mix(
      new Array<boolean>(count).fill(true),
      write,
      (units) => {
        const weights = weigh(units);
        if (weights.length !== count) {
          throw new RangeError(`Expected ${count} weights, got ${weights.length}`);
        }
        return new MixtureLayout(weights);
      },
      kept
    );
  }

  /**
   * Writes the spelling of each choice `written` names, each from the
   * message state as it stands and taken back but for choice `kept`'s, then
   * the mixture of them `lay` lays out from their costs.
   */
  private mix(
    written: readonly boolean[],
    write: (choice: number) => void,
    lay: (units: readonly number[]) => MixtureLayout,
    kept = -1
  ): void {
    if (this.mixing) {
      throw new TypeError('A mixture spelling cannot write a mixture');
    }
    const { running, limits, ties } = this;
    // A spelling is written to be priced, not as a candidate of the tries
    // running: they pay for the mixture as a whole.
    const spent = running.splice(0);
    const budgets = limits.splice(0);
    const sides = ties.splice(0);
    const spellings: (Spelling | undefined)[] = [];
    const costs: number[] = [];
    this.mixing = true;
    // Taken with no try running, so taking it back leaves `running` be.
    const outer = kept >= 0 ? this.mark() : undefined;
    try {
      for (let j = 0; j < written.length; j++) {
        if (!written[j]) {
          spellings.push(undefined);
          costs.push(Infinity);
          continue;
        }
        const mark = this.mark();
        let keep = false;
        try {
          write(j);
          if (this.opened.length !== mark.groups || this.pending.length !== mark.pending) {
            throw new TypeError('A mixture spelling cannot write a selector or alternatives');
          }
          const at = mark.events;
          spellings.push({
            cums: this.cums.slice(at),
            freqs: this.freqs.slice(at),
            totals: this.totals.slice(at),
            weighted: this.weighted.slice(at),
          });
          costs.push(this.unitsSince(mark));
          keep = j === kept;
        } finally {
          if (keep) {
            this.unlog(mark);
          } else {
            this.rollback(mark);
          }
        }
      }
      if (outer !== undefined) {
        this.commit(outer);
      }
    } catch (error) {
      if (outer !== undefined) {
        this.rollback(outer);
      }
      throw error;
    } finally {
      this.mixing = false;
      running.push(...spent);
      limits.push(...budgets);
      ties.push(...sides);
    }

    const layout = lay(costs);
    const { top, cums: choices, total, only } = layout;
    const start = this.totals.length;
    const { cums, freqs, totals, weighted } = spellings[top] as Spelling;
    for (let i = 0; i < totals.length; i++) {
      this.cums.push(cums[i]);
      this.freqs.push(freqs[i] as Radix);
      this.totals.push(totals[i] as Radix);
      this.weighted.push(weighted[i]);
    }
    const units = mixtureUnits(costs.filter((_, j) => layout.weights[j] > 0));
    if (only < 0) {
      this.cums.push(choices[top]);
      this.freqs.push(layout.weights[top] as Radix);
      this.totals.push(total as Radix);
      this.weighted.push(true);
      this.mixtures.push({ start, at: this.totals.length - 1, layout, spellings, units });
    }
    if (running.length > 0) {
      this.charge(units);
    }
  }

  /**
   * Adds the cost of the symbol just logged, in `UNITS`, to every try
   * `decide` runs, and aborts the innermost when a budget is passed: its
   * own, when it can no longer win, else the outermost budget passed
   * around it, which its `decide` weighs.
   */
  private charge(units: number): void {
    const { running, limits, ties } = this;
    let passed = -1;
    for (let k = 0; k < running.length; k++) {
      const spent = running[k] + units;
      running[k] = spent;
      if (passed < 0 && (spent > limits[k] || (spent === limits[k] && !ties[k]))) {
        passed = k;
      }
    }
    if (passed >= 0) {
      const own = running.length - 1;
      const spent = running[own];
      const lost = spent > limits[own] || (spent === limits[own] && !ties[own]);
      throw new Abort(lost ? own : passed);
    }
  }

  /**
   * Settle every group with alternatives pending: pick its cheapest coding,
   * patch the choice into its selector and its symbols' slots. Groups
   * without alternatives keep coding 0, which their selector already holds.
   */
  private resolve(): void {
    const symbols = new Map<object, Alternative[]>();
    for (const alternative of this.pending) {
      const list = symbols.get(alternative.group);
      if (list === undefined) {
        symbols.set(alternative.group, [alternative]);
      } else {
        list.push(alternative);
      }
    }
    for (const [group, { at, choices }] of this.groups) {
      const list = symbols.get(group);
      if (list === undefined) {
        continue;
      }
      // ratios[i] is coding i's probability product over coding 0's, its
      // selector included; the largest ratio costs the fewest bits. Coding
      // 0's own ratio is 1.
      const count = choices.length;
      const ratios = Array.from({ length: count }, () => new ScaledRatio());
      for (let i = 1; i < count; i++) {
        ratios[i].multiply(choices[i][1], choices[0][1]);
      }
      for (const { buckets } of list) {
        const [, freq0, total0] = buckets[0];
        for (let i = 1; i < count; i++) {
          const [, freq, total] = buckets[i];
          ratios[i].multiply(freq * total0, total * freq0);
        }
      }
      let chosen = 0;
      for (let i = 1; i < count; i++) {
        if (ratios[i].exceeds(ratios[chosen])) {
          chosen = i;
        }
      }

      if (at >= 0) {
        const [cum, freq, total] = choices[chosen];
        this.cums[at] = cum;
        this.freqs[at] = freq as Radix;
        this.totals[at] = total as Radix;
      }
      for (const { at: slot, buckets } of list) {
        const [cum, freq, total] = buckets[chosen];
        this.cums[slot] = cum;
        this.freqs[slot] = freq as Radix;
        this.totals[slot] = total as Radix;
      }
    }
    this.pending = [];
  }

  /**
   * Open a transaction: what is written from here on, and every change it
   * makes to the message's state, can be priced with `bitsSince` and taken
   * back with `rollback`, or kept with `commit`. Transactions nest; each
   * closes before the one it was opened in.
   */
  mark(): Mark {
    return {
      events: this.totals.length,
      pending: this.pending.length,
      groups: this.opened.length,
      mixtures: this.mixtures.length,
      running: this.running.length > 0 ? this.running.slice() : undefined,
      journal: this.journal.mark(),
    };
  }

  /**
   * The cost in bits of the symbols written since `mark`: log2 of total
   * over freq each, an alternatives symbol and a selector priced in
   * `PRICED_CODING`, each rounded to a 2^-20th of a bit.
   */
  bitsSince(mark: Mark): number {
    return this.unitsSince(mark) / UNITS;
  }

  /** `bitsSince` in `UNITS`. */
  private unitsSince(mark: Mark): number {
    const { freqs, totals, pending, groups, opened } = this;
    // The log holds coding 0's buckets for alternatives and selectors until
    // `output`, so those are priced off their buckets, in log order.
    let alternative = mark.pending;
    let next = alternative < pending.length ? pending[alternative].at : -1;
    const selectors: number[] = [];
    const codings: Bucket[] = [];
    for (let k = mark.groups; k < opened.length; k++) {
      const { at, choices } = groups.get(opened[k]) as { at: number; choices: readonly Bucket[] };
      if (at >= 0) {
        selectors.push(at);
        codings.push(choices[Math.min(PRICED_CODING, choices.length - 1)]);
      }
    }
    const { mixtures } = this;
    let mixture = mark.mixtures;
    let start = mixture < mixtures.length ? mixtures[mixture].start : -1;
    let selector = 0;
    let units = 0;
    for (let i = mark.events; i < totals.length; i++) {
      if (i === start) {
        // A mixture's span holds plain symbols only.
        units += mixtures[mixture].units;
        i = mixtures[mixture].at;
        mixture++;
        start = mixture < mixtures.length ? mixtures[mixture].start : -1;
      } else if (i === next) {
        const { buckets } = pending[alternative];
        units += bucketUnits(buckets[Math.min(PRICED_CODING, buckets.length - 1)]);
        alternative++;
        next = alternative < pending.length ? pending[alternative].at : -1;
      } else if (i === selectors[selector]) {
        units += bucketUnits(codings[selector]);
        selector++;
      } else {
        units += unitsOf(totals[i], freqs[i]);
      }
    }
    return units;
  }

  /** Take back everything written since `mark`, the innermost open transaction, and close it. */
  rollback(mark: Mark): void {
    this.journal.rollback(mark.journal);
    const at = mark.events;
    this.cums.length = at;
    this.freqs.length = at;
    this.totals.length = at;
    this.weighted.length = at;
    this.pending.length = mark.pending;
    this.mixtures.length = mark.mixtures;
    const { opened, groups } = this;
    for (let k = mark.groups; k < opened.length; k++) {
      groups.delete(opened[k]);
    }
    opened.length = mark.groups;
    const { running } = mark;
    if (running !== undefined) {
      for (let k = 0; k < running.length; k++) {
        this.running[k] = running[k];
      }
    }
  }

  /**
   * Keeps the changes to the message state since `mark`, the innermost open
   * transaction, and closes it, but drops the symbols logged since, which
   * wrote no selector, alternatives or mixture.
   */
  private unlog(mark: Mark): void {
    this.journal.release(mark.journal);
    const at = mark.events;
    this.cums.length = at;
    this.freqs.length = at;
    this.totals.length = at;
    this.weighted.length = at;
  }

  /** Keep everything written since `mark`, the innermost open transaction, and close it. */
  commit(mark: Mark): void {
    this.journal.release(mark.journal);
  }

  /**
   * Writes one of the spellings `write(c)` writes for each candidate `c`,
   * the one costing the fewest bits, and returns it. A tie goes to the
   * candidate listed first in `priority`, which lists every candidate. A
   * candidate whose `write` throws is passed over; when every one throws,
   * the error of the first in `priority` is thrown.
   *
   * The candidates are tried in `order`, each written and rolled back but
   * the last, which is kept when it wins; another winner is written again.
   * Every try after a candidate that wrote runs under a budget, the cost of
   * the best so far, and is aborted as soon as it spends more, or as much
   * when it loses the tie; a try inside another try is aborted too when it
   * takes the outer one past its budget. So the candidate most likely to
   * win goes first. Costs are whole `UNITS` and only grow, so the
   * candidate chosen is always the one trying every candidate in full
   * would choose.
   *
   * The choices made inside the winner's try, by `decide` calls nested in
   * it, are kept, and writing it again takes them instead of trying again:
   * the state it is written in is the state it was tried in, so the tries
   * would choose the same. A spelling written again under a choice of an
   * enclosing `decide` takes this choice the same way.
   */
  decide(
    priority: readonly number[],
    order: readonly number[],
    write: (choice: number) => void
  ): number {
    const replay = this.replay;
    if (replay !== undefined) {
      return this.checkDecisions
        ? this.recheck(replay, priority, order, write)
        : this.take(replay, write);
    }
    const parent = this.tape;
    const trial: Trial = {
      priority,
      write,
      level: this.running.length,
      best: -1,
      least: Infinity,
      kept: [],
      done: false,
      failures: new Map(),
      stopped: false,
    };
    try {
      for (let k = 0; k < order.length; k++) {
        this.attempt(trial, order[k], k === order.length - 1);
        if (trial.done) {
          break;
        }
      }
      // A candidate an outer budget stopped had spent more than that budget
      // had left, or as much where the tie went against it. A candidate that
      // wrote did so within every budget, so it costs less than any stopped
      // one spent, or as much where the tie goes to it: it wins. With none
      // written, whichever candidate would have won passes the budget with
      // the least left too, and that try loses.
      if (trial.best < 0 && trial.stopped) {
        throw new Abort(this.tightest(trial.level));
      }
      if (trial.best < 0) {
        throw trial.failures.get(priority.find((c) => trial.failures.has(c)) as number);
      }
      if (!trial.done) {
        this.tape = undefined;
        this.rewrite(trial.kept, trial.best, write);
      }
    } finally {
      this.tape = parent;
    }
    if (parent !== undefined) {
      parent.push(trial.best);
      for (const choice of trial.kept) {
        parent.push(choice);
      }
    }
    return trial.best;
  }

  /** Whether candidate `choice` costing `units` beats the best of `trial` so far. */
  private beats(trial: Trial, choice: number, units: number): boolean {
    const { priority, best, least } = trial;
    return (
      best < 0 ||
      units < least ||
      (units === least && priority.indexOf(choice) < priority.indexOf(best))
    );
  }

  /**
   * The depth among the first `level` tries running whose budget has the
   * least left, one losing a tie on its budget before one winning it.
   */
  private tightest(level: number): number {
    const { running, limits, ties } = this;
    let tightest = 0;
    let least = Infinity;
    for (let k = 0; k < level; k++) {
      const left = limits[k] - running[k];
      if (left < least || (left === least && !ties[k])) {
        tightest = k;
        least = left;
      }
    }
    return tightest;
  }

  /**
   * Tries candidate `choice` of `trial` under its budget. A winner is kept
   * when `last`, else rolled back.
   */
  private attempt(trial: Trial, choice: number, last: boolean): void {
    const { running, limits, ties } = this;
    const { level, priority } = trial;
    const mark = this.mark();
    const tape: number[] = [];
    this.tape = tape;
    const budgeted = trial.best >= 0 && !this.checkDecisions;
    running.push(0);
    limits.push(budgeted ? trial.least : Infinity);
    ties.push(budgeted && priority.indexOf(choice) < priority.indexOf(trial.best));
    let units: number;
    try {
      trial.write(choice);
      // Every symbol logged since the mark charged its cost to the try, and a
      // rollback inside it set the try's spending back with the log, so what
      // it spent is what `unitsSince(mark)` would sum.
      units = running[running.length - 1];
    } catch (error) {
      if (error instanceof Abort) {
        trial.stopped ||= error.level < level;
      } else {
        trial.failures.set(choice, error);
      }
      this.rollback(mark);
      return;
    } finally {
      running.pop();
      limits.pop();
      ties.pop();
    }
    if (this.beats(trial, choice, units)) {
      trial.best = choice;
      trial.least = units;
      trial.kept = tape;
      if (last) {
        this.commit(mark);
        trial.done = true;
        return;
      }
    }
    this.rollback(mark);
  }

  /**
   * A choice a node makes on its own inside a spelling `decide` tries, such
   * as which match to take, as numbers `compute` works out. A spelling
   * written again takes the numbers its try noted instead of working them
   * out again.
   */
  note(compute: () => readonly number[]): readonly number[] {
    const replay = this.replay;
    if (replay === undefined) {
      const values = compute();
      const tape = this.tape;
      if (tape !== undefined) {
        tape.push(values.length);
        for (const value of values) {
          tape.push(value);
        }
      }
      return values;
    }
    const { tape, at } = replay;
    const count = tape[at];
    const values = tape.slice(at + 1, at + 1 + count);
    replay.at = at + 1 + count;
    if (this.checkDecisions) {
      this.replay = undefined;
      let fresh: readonly number[];
      try {
        fresh = compute();
      } finally {
        this.replay = replay;
      }
      if (fresh.length !== count || fresh.some((value, i) => value !== values[i])) {
        throw new Error('A choice written again differs from the one its try made');
      }
    }
    return values;
  }

  /** Writes `choice` again, taking the choices of `tape`, the ones its try made. */
  private rewrite(tape: readonly number[], choice: number, write: (choice: number) => void): void {
    const replay = { tape, at: 0 };
    this.replay = replay;
    try {
      write(choice);
    } finally {
      this.replay = undefined;
    }
    if (replay.at !== tape.length) {
      throw new Error(`Rewrite took ${replay.at} of ${tape.length} choices its try made`);
    }
  }

  /** Writes the next choice of `replay`, the choices inside it taken from it too. */
  private take(
    replay: { readonly tape: readonly number[]; at: number },
    write: (choice: number) => void
  ): number {
    const choice = replay.tape[replay.at++];
    write(choice);
    return choice;
  }

  /**
   * Decides afresh where `replay` holds the choice, then refuses a choice,
   * or one inside it, that differs from the one held.
   */
  private recheck(
    replay: { readonly tape: readonly number[]; at: number },
    priority: readonly number[],
    order: readonly number[],
    write: (choice: number) => void
  ): number {
    const tape: number[] = [];
    this.replay = undefined;
    this.tape = tape;
    let choice: number;
    try {
      choice = this.decide(priority, order, write);
    } finally {
      this.replay = replay;
      this.tape = undefined;
    }
    for (let k = 0; k < tape.length; k++) {
      if (tape[k] !== replay.tape[replay.at + k]) {
        throw new Error('A choice written again differs from the one its try made');
      }
    }
    replay.at += tape.length;
    return choice;
  }

  /** The log of every symbol written so far; see `EventLog`. */
  events(): EventLog {
    const { cums, freqs, totals, weighted } = this;
    return { cums, freqs, totals, weighted };
  }

  /** Push one unbounded non-negative integer. */
  composeTerm(integer: number): void {
    // The digit loops below only terminate for non-negative integers.
    if (!Number.isInteger(integer)) {
      throw new TypeError(`Term must be an integer, got ${integer}`);
    }
    if (integer < 0) {
      throw new RangeError(`Term ${integer} is negative`);
    }

    if (integer < TERM_ESCAPE_MIN) {
      // Inline: a terminated base-TERM_BASE run. Values here stay far below
      // 2^53, so plain number arithmetic is exact.
      this.composeRun(integer, TERM_BASE + 2);
      return;
    }

    // Escaped: the widened first slot's extra symbol, the base-8 digit count
    // (offset by its known minimum, as a plain run), then the digits.
    this.compose(TERM_BASE + 1, TERM_BASE + 2);

    // Digits come out in BigInt: integer-valued doubles are exact, but float
    // division above 2^53 is not, and escaped terms live in that range.
    const base = BigInt(TERM_PAYLOAD_BASE);
    const digits: number[] = [];
    let value = BigInt(integer);
    while (value !== 0n) {
      digits.push(Number(value % base));
      value /= base;
    }

    this.composeRun(digits.length - TERM_PAYLOAD_MIN_DIGITS, TERM_BASE + 1);
    for (let i = 0; i < digits.length - 1; i++) {
      this.compose(digits[i], TERM_PAYLOAD_BASE);
    }
    // The top digit is never zero, so it packs one state tighter — which also
    // makes zero-padded (non-canonical) digit strings unrepresentable.
    this.compose(digits[digits.length - 1] - 1, TERM_PAYLOAD_BASE - 1);
  }

  /**
   * A terminated base-TERM_BASE digit run, lowest digit first: digit d rides
   * as symbol d+1, symbol 0 terminates. The first slot's radix is a parameter
   * because a term's opening slot carries one extra state for the escape.
   * `value` is a non-negative integer, so the run ends; `firstRadix` is
   * TERM_BASE + 1 or TERM_BASE + 2.
   */
  private composeRun(value: number, firstRadix: number): void {
    let radix = firstRadix;
    while (value !== 0) {
      this.compose((value % TERM_BASE) + 1, radix);
      value = Math.floor(value / TERM_BASE);
      radix = TERM_BASE + 1;
    }
    this.compose(0, radix);
  }

  /**
   * The log folded into base-`size` digits by `StreamWriter`, in reverse,
   * so the decoder can peel the values off front to back, which it needs
   * because later radices can depend on earlier decoded values (an array's
   * length prefix, say).
   *
   * A checksum of `sum` bits is the message's first symbol, a uniform slot
   * of 2^sum states, so it is folded last. Its value covers the state it
   * folds onto and every digit emitted before it, which is everything the
   * decoder reads after it; emitting for it does not depend on its value, so
   * it is taken once that emission is done.
   */
  private toDigits(size: number, sum: number): number[] {
    const { cums, freqs, totals, weighted } = this;
    const head = sum > 0 ? 2 ** sum : 0;
    let writer: StreamWriter;
    if (this.mixtures.length === 0) {
      writer = new StreamWriter(size, totals, freqs, head);
      for (let i = totals.length - 1; i >= 0; i--) {
        writer.push(cums[i], freqs[i], totals[i], weighted[i]);
      }
    } else {
      writer = this.mixedWriter(size, head);
    }
    if (sum > 0) {
      const radix = 2 ** sum;
      writer.renormalise(1, radix);
      const count = writer.count;
      const h = checksumOf(sum, writer.state, count, (i) => writer.emittedAt(i));
      writer.push(h, 1, radix, false);
    }
    return writer.digits();
  }

  /**
   * `toDigits`' writer with the log folded into it, for a log with
   * mixtures: the writer takes each mixture as a latent choice, a freq of 0,
   * in place of its span, and `unmix` folds it with the spelling it takes.
   */
  private mixedWriter(size: number, head: number): StreamWriter {
    const { cums, freqs, totals, weighted, mixtures } = this;
    const symbolTotals: number[] = [];
    const symbolFreqs: number[] = [];
    /** Each symbol's slot in the log, or -1 - k for mixture k. */
    const slots: number[] = [];
    let k = 0;
    for (let i = 0; i < totals.length; i++) {
      if (k < mixtures.length && i === mixtures[k].start) {
        symbolTotals.push(mixtures[k].layout.total);
        symbolFreqs.push(0);
        slots.push(-1 - k);
        i = mixtures[k].at;
        k++;
      } else {
        symbolTotals.push(totals[i]);
        symbolFreqs.push(freqs[i]);
        slots.push(i);
      }
    }
    const writer = new StreamWriter(size, symbolTotals, symbolFreqs, head);
    for (let e = slots.length - 1; e >= 0; e--) {
      const i = slots[e];
      if (i >= 0) {
        writer.push(cums[i], freqs[i], totals[i], weighted[i]);
      } else {
        const { layout, spellings } = mixtures[-1 - i];
        writer.unmix(
          layout.total,
          (residual) => layout.locate(residual),
          (choice) => spellings[choice] as Spelling
        );
      }
    }
    return writer;
  }

  /** The message as bytes, or as text when `type` is `'text'`. */
  output(options: CodecOptions<'text'> & { type: 'text' }): string;
  output(options?: CodecOptions<'binary'>): Uint8Array;
  output(options?: CodecOptions<OutputType>): Uint8Array | string;
  output(options: CodecOptions<OutputType> = {}): Uint8Array | string {
    if (this.journal.active) {
      throw new TypeError('Encoder has a transaction open');
    }
    const type = options.type ?? 'binary';
    const alphabet = outputAlphabet(type, options.charset);
    this.resolve();
    const digits = this.toDigits(alphabet.size, validateChecksum(options.checksum));

    if (type === 'text') {
      let str = '';
      for (const digit of digits) {
        str += alphabet.charAt(digit);
      }
      return str;
    }

    return alphabet.bytesOf(digits);
  }
}
