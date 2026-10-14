/**
 * How a node spells one of its members: uniformly, by a static prior, or by
 * an adaptive one. Nodes hold a `Members` and stay out of which.
 */

import type { Encoder, Decoder } from '../packer';
import {
  AdaptivePrior,
  checkAdaptation,
  checkAdaptiveMembers,
  type AdaptiveOptions,
} from './adaptive';
import { buildWeights, readTable, writeTable, type WeightTable } from './weights';

/**
 * A node's declared prior over its members: weights, adapting when
 * `adaptive` is set, `{}` for the default options.
 */
export interface MemberPrior {
  readonly weights?: readonly number[];
  readonly adaptive?: AdaptiveOptions;
}

/**
 * How a node spells one of `count` members: uniformly (`radix` set, so
 * containers can read runs), by a static prior, or by an adaptive one.
 */
export interface Members {
  readonly count: number;
  readonly radix?: number;
  /** Writes member `pos`, an integer in `[0, count)`. */
  write(enc: Encoder, pos: number): void;
  /** Reads a member written by `write`. */
  read(dec: Decoder): number;
}

/** Every member equally likely: one digit in radix `count`. */
class UniformMembers implements Members {
  readonly radix: number;

  constructor(readonly count: number) {
    this.radix = count;
  }

  write(enc: Encoder, pos: number): void {
    enc.compose(pos, this.count);
  }

  read(dec: Decoder): number {
    return dec.parse(this.count);
  }
}

/** Members under a static weight table. */
class WeightedMembers implements Members {
  private readonly table: WeightTable;

  constructor(
    readonly count: number,
    weights: readonly number[],
    who: string
  ) {
    this.table = buildWeights(weights, count, who);
  }

  write(enc: Encoder, pos: number): void {
    writeTable(enc, this.table, pos);
  }

  read(dec: Decoder): number {
    return readTable(dec, this.table);
  }
}

/** Members under an adaptive prior, starting at the weights. */
class AdaptiveMembers implements Members {
  private readonly prior: AdaptivePrior;

  constructor(
    readonly count: number,
    weights: readonly number[],
    adaptation: AdaptiveOptions,
    who: string
  ) {
    this.prior = new AdaptivePrior([weights], count, adaptation.window, who);
  }

  write(enc: Encoder, pos: number): void {
    this.prior.write(enc, pos);
  }

  read(dec: Decoder): number {
    return this.prior.read(dec);
  }
}

/** Refuses a member count that is not a positive integer, as `buildWeights` does. */
function checkCount(count: number, who: string): void {
  if (!Number.isInteger(count)) {
    throw new TypeError(`${who} weights need a whole number of values, got ${count}`);
  }
  if (count < 1) {
    throw new RangeError(`${who} weights need at least one value, got ${count}`);
  }
}

/** The spelling of `count` members under `prior`; `who` names the node in an error. */
export function members(count: number, prior: MemberPrior | undefined, who: string): Members {
  checkCount(count, who);
  if (prior?.adaptive !== undefined) {
    const adaptation = checkAdaptation(prior.adaptive, who);
    checkAdaptiveMembers(count, who);
    const weights = prior.weights ?? new Array<number>(count).fill(1);
    return new AdaptiveMembers(count, weights, adaptation, who);
  }
  if (prior?.weights !== undefined) {
    return new WeightedMembers(count, prior.weights, who);
  }
  return new UniformMembers(count);
}
