/**
 * The latent choice of a mixture, as both ends lay it out from the same
 * weights: choice j owns `weights[j]` of `total` states, the heaviest (the
 * lowest index on a tie) from residual 0, then the rest in index order. A
 * choice of weight 0 owns no states and is never taken. The encoder takes
 * the choice owning residual 0 off an empty state, so a mixture at the
 * message's end spells its likeliest choice.
 */

import type { Located } from './stream';

export class MixtureLayout {
  /** The choice owning every state, -1 when more than one has weight. */
  readonly only: number;
  /** Each choice's cum. */
  readonly cums: number[];
  readonly total: number;
  /** The heaviest choice. */
  readonly top: number;
  /** The choices that own states, in residual order, and where each one's bucket ends. */
  private readonly order: number[] = [];
  private readonly ends: number[] = [];

  constructor(readonly weights: readonly number[]) {
    const { total, top, owners } = measure(weights);
    this.total = total;
    this.top = top;
    this.only = owners === 1 ? top : -1;
    const cums = new Array<number>(weights.length).fill(0);
    let end = weights[top];
    this.order.push(top);
    this.ends.push(end);
    for (let j = 0; j < weights.length; j++) {
      if (j !== top && weights[j] > 0) {
        cums[j] = end;
        end += weights[j];
        this.order.push(j);
        this.ends.push(end);
      }
    }
    this.cums = cums;
  }

  /** The choice owning `residual`, in [0, total), with its bucket. */
  locate(residual: number): Located<number> {
    const { order, ends } = this;
    let lo = 0;
    let hi = order.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ends[mid] > residual) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    const choice = order[lo];
    return [choice, this.cums[choice], this.weights[choice]];
  }
}

/** What `measure` returns, written over by the next call. */
const measured = { total: 0, top: 0, owners: 0 };

/**
 * The sum of `weights`, the heaviest choice and how many choices own
 * states, the weights refused unless non-negative integers with one
 * positive, summing to a safe integer. The result is reused by the next
 * call.
 */
export function measure(weights: readonly number[]): {
  readonly total: number;
  readonly top: number;
  readonly owners: number;
} {
  let total = 0;
  let top = -1;
  let owners = 0;
  for (let j = 0; j < weights.length; j++) {
    const weight = weights[j];
    if (!Number.isInteger(weight)) {
      throw new TypeError(`Weight must be an integer, got ${weight}`);
    }
    if (weight < 0) {
      throw new RangeError(`Weight ${weight} is negative`);
    }
    total += weight;
    if (weight > 0) {
      owners++;
      if (top < 0 || weight > weights[top]) {
        top = j;
      }
    }
  }
  if (top < 0) {
    throw new RangeError('A mixture needs a choice of positive weight');
  }
  if (total > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Weights sum to ${total}, past the largest safe integer`);
  }
  measured.total = total;
  measured.top = top;
  measured.owners = owners;
  return measured;
}

/**
 * Where choice `choice`'s bucket starts in the layout of `weights`, whose
 * heaviest choice is `top`, as `MixtureLayout` lays it out.
 */
export function choiceCum(weights: readonly number[], top: number, choice: number): number {
  if (choice === top) {
    return 0;
  }
  let cum = weights[top];
  for (let j = 0; j < choice; j++) {
    if (j !== top && weights[j] > 0) {
      cum += weights[j];
    }
  }
  return cum;
}
