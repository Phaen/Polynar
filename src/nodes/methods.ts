/**
 * Methods: the rules a node spells one value by, given what the same node
 * already wrote in the message (nothing, the previous value, the distinct
 * values so far). A declared method runs on every value; under
 * `.adaptive()` a learned mode picks, value by value, among the methods the
 * user left open. Which method a value takes is the encoder's choice alone:
 * it prices each spelling against the tables as they stand and the decoder
 * reads the mode back without checking it.
 */

import { type Encoder, type Decoder, ScaledRatio } from '../packer';
import { AdaptivePrior, checkAdaptation, type AdaptiveOptions } from './adaptive';
import { Exclusion } from './excluded';

/**
 * The methods a node declares, carried through every rebuild so a later
 * `.min()`, `.weights()` or `.adaptive()` keeps them. Each is set once.
 */
export interface Spelling {
  /** Each value after the first as its difference from the node's previous one. */
  readonly delta?: true;
  /** Each value as its place among the distinct values the node already wrote, or as new. */
  readonly recall?: true;
}

/** `spelling` with `method` declared; `who` names the node in the error a second declaration throws. */
export function withMethod(spelling: Spelling, method: keyof Spelling, who: string): Spelling {
  if (spelling[method] !== undefined) {
    throw new TypeError(`${who} ${method} is already set`);
  }
  return { ...spelling, [method]: true };
}

/**
 * One way of spelling a node's value. Each method keeps its own tables and
 * whatever per-message state it reads (a previous value, a list), and
 * learns from every value it codes; `learn` teaches it a value another
 * method coded.
 */
export interface Method<T> {
  /**
   * Whether the method can take the node's next value, from what both sides
   * know before it: a difference needs a previous value. A method that is
   * not available is left out of the mode.
   */
  available(side: Encoder | Decoder): boolean;
  /**
   * Multiplies `into` by the probability of the method's spelling of
   * `value` under the tables as they stand, learning nothing: the encoder's
   * price of the spelling. False when the method cannot spell `value`;
   * `into` is then left in any state.
   */
  price(enc: Encoder, value: T, into: ScaledRatio): boolean;
  /** Spells `value` and learns it. Called only when available. */
  write(enc: Encoder, value: T): void;
  /** Reads a value `write` spelled and learns it. Called only when available. */
  read(dec: Decoder): T;
  /** Learns `value`, coded by another method, as though it had spelled it; nothing when it cannot spell it. */
  learn(side: Encoder | Decoder, value: T): void;
}

/**
 * The per-value mode among a node's methods: each value is spelled by one
 * of them, named by a mode symbol over the methods available for it. The
 * symbol is written only when at least two are available, so a node's
 * first value, when only plain applies, costs its plain spelling and
 * nothing more. The modes are equally likely over the available methods,
 * or, under `adaptive`, a table of even weights under the adaptive prior
 * with the methods not available ruled out.
 *
 * The encoder prices each available method's spelling together with its
 * mode symbol as a `ScaledRatio` against the tables as they stand, and the
 * largest wins, a tie going to the lower index, so method 0, the plain
 * spelling, wins every tie. After a value every other available method
 * learns it, on both sides, so their tables follow the message whichever
 * spelled it.
 */
export class ModeChoice<T> {
  /** The learned mode table under `adaptive`. */
  private readonly prior?: AdaptivePrior;
  /** The exclusion of each set of available methods, keyed by their indices, built on first use. */
  private readonly exclusions = new Map<string, Exclusion>();

  constructor(
    readonly methods: readonly Method<T>[],
    adaptive: AdaptiveOptions | undefined,
    readonly who: string
  ) {
    if (methods.length === 0) {
      throw new TypeError(`${who} needs at least one method`);
    }
    if (adaptive !== undefined) {
      const { window } = checkAdaptation(adaptive, who);
      const n = methods.length;
      this.prior = new AdaptivePrior([new Array<number>(n).fill(1)], n, window, who);
    }
  }

  /** The methods available for the next value on `side`, in index order. */
  private available(side: Encoder | Decoder): number[] {
    const open: number[] = [];
    this.methods.forEach((method, i) => {
      if (method.available(side)) {
        open.push(i);
      }
    });
    if (open.length === 0) {
      throw new RangeError(`${this.who} has no method available for the value`);
    }
    return open;
  }

  /** The methods outside `open` ruled out, one exclusion per set of available methods. */
  private exclusion(open: readonly number[]): Exclusion {
    const key = open.join();
    let exclusion = this.exclusions.get(key);
    if (exclusion === undefined) {
      exclusion = new Exclusion(this.methods.length);
      for (let i = 0; i < this.methods.length; i++) {
        if (!open.includes(i)) {
          exclusion.add(i);
        }
      }
      this.exclusions.set(key, exclusion);
    }
    return exclusion;
  }

  /** Multiplies `into` by the probability of mode `mode` among `open`, as the table stands. */
  private priceMode(enc: Encoder, mode: number, open: readonly number[], into: ScaledRatio): void {
    if (this.prior === undefined) {
      into.multiply(1, open.length);
      return;
    }
    const [, freq, total] = this.prior.estimate(enc, mode, 0, this.exclusion(open));
    into.multiply(freq, total);
  }

  /**
   * The mode the encoder picks for `value` among `open`: the largest priced
   * spelling, the lower index on a tie. A method that cannot spell the
   * value is passed over; when none can, the error is the lowest one's
   * own, thrown by its `write`.
   */
  private choose(enc: Encoder, value: T, open: readonly number[]): number {
    let best = open[0];
    let most: ScaledRatio | undefined;
    for (const i of open) {
      const ratio = new ScaledRatio();
      this.priceMode(enc, i, open, ratio);
      if (this.methods[i].price(enc, value, ratio) && (most === undefined || ratio.exceeds(most))) {
        best = i;
        most = ratio;
      }
    }
    return best;
  }

  /** Spells `value` by the method the encoder picks, then lets every other available method learn it. */
  write(enc: Encoder, value: T): void {
    const open = this.available(enc);
    let mode = open[0];
    if (open.length > 1) {
      mode = this.choose(enc, value, open);
      if (this.prior === undefined) {
        enc.compose(open.indexOf(mode), open.length);
      } else {
        this.prior.write(enc, mode, 0, this.exclusion(open));
      }
    }
    this.methods[mode].write(enc, value);
    this.teach(enc, value, open, mode);
  }

  /** Reads a value `write` spelled, then lets every other available method learn it. */
  read(dec: Decoder): T {
    const open = this.available(dec);
    let mode = open[0];
    if (open.length > 1) {
      // The uniform digit is below the count, and an excluded mode owns no
      // states, so the mode read is always one of the available methods.
      mode =
        this.prior === undefined
          ? open[dec.parse(open.length)]
          : this.prior.read(dec, 0, this.exclusion(open));
    }
    const value = this.methods[mode].read(dec);
    this.teach(dec, value, open, mode);
    return value;
  }

  /** Every available method but `mode` learns `value`, in index order. */
  private teach(side: Encoder | Decoder, value: T, open: readonly number[], mode: number): void {
    for (const i of open) {
      if (i !== mode) {
        this.methods[i].learn(side, value);
      }
    }
  }
}
