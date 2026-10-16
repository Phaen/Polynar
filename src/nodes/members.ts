/**
 * How a node spells one of its members: uniformly, by a static prior, or by
 * an adaptive one. Nodes hold a `Members` and stay out of which.
 */

import type { Encoder, Decoder } from '../packer';
import {
  AdaptivePrior,
  checkAdaptation,
  checkAdaptiveMembers,
  lineageOf,
  type LearningOptions,
} from './adaptive';
import { buildWeights, readTable, writeTable, type WeightTable } from './weights';

/**
 * A node's declared prior over its members: weights, or `rows` of weights
 * with one list per context the members are spelled in, whose odds learn
 * under the `learn` options when set, `{}` for the defaults.
 */
export interface MemberPrior {
  readonly weights?: readonly number[];
  readonly rows?: readonly (readonly number[])[];
  readonly learn?: LearningOptions;
}

/**
 * How a node spells one of `count` members: uniformly (`radix` set, so
 * containers can read runs), by a static prior, or by an adaptive one.
 */
export interface Members {
  readonly count: number;
  readonly radix?: number;
  /** Writes member `pos`, an integer in `[0, count)`, in context `row`, and learns it where the members learn. */
  write(enc: Encoder, pos: number, row?: number): void;
  /** Reads a member written by `write` in context `row`, and learns it as `write` did. */
  read(dec: Decoder, row?: number): number;
}

/** Every member equally likely in every row: one digit in radix `count`. */
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

/** Members under a static weight table per row. */
class WeightedMembers implements Members {
  private readonly tables: readonly WeightTable[];

  constructor(
    readonly count: number,
    rows: readonly (readonly number[])[],
    who: string
  ) {
    this.tables = rows.map((weights) => buildWeights(weights, count, who));
  }

  /** The table of `row`, which must be one of the rows. */
  private table(row: number): WeightTable {
    const table = this.tables[row];
    // Any row outside the list (negative, fractional, NaN, past the end)
    // reads undefined.
    if (table === undefined) {
      throw new RangeError(`Row ${row} is outside [0, ${this.tables.length})`);
    }
    return table;
  }

  write(enc: Encoder, pos: number, row = 0): void {
    writeTable(enc, this.table(row), pos);
  }

  read(dec: Decoder, row = 0): number {
    return readTable(dec, this.table(row));
  }
}

/** Members under an adaptive prior, starting at the rows. */
class AdaptiveMembers implements Members {
  private readonly prior: AdaptivePrior;

  constructor(
    readonly count: number,
    rows: readonly (readonly number[])[],
    adaptation: LearningOptions,
    who: string
  ) {
    this.prior = new AdaptivePrior(rows, count, adaptation.window, who, lineageOf(adaptation));
  }

  write(enc: Encoder, pos: number, row = 0): void {
    this.prior.write(enc, pos, row);
    this.prior.learn(enc, pos, row);
  }

  read(dec: Decoder, row = 0): number {
    const pos = this.prior.read(dec, row);
    this.prior.learn(dec, pos, row);
    return pos;
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
  const weights = prior?.weights;
  const given = prior?.rows;
  if (weights !== undefined && given !== undefined) {
    throw new TypeError(`${who} takes weights or rows, not both`);
  }
  if (given?.length === 0) {
    throw new TypeError(`${who} rows need at least one row`);
  }
  const rows = given ?? (weights === undefined ? undefined : [weights]);
  if (prior?.learn !== undefined) {
    checkAdaptation(prior.learn, who);
    checkAdaptiveMembers(count, who);
    const ones = [new Array<number>(count).fill(1)];
    return new AdaptiveMembers(count, rows ?? ones, prior.learn, who);
  }
  if (rows !== undefined) {
    return new WeightedMembers(count, rows, who);
  }
  return new UniformMembers(count);
}
