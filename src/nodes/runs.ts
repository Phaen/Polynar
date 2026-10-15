/**
 * Restricted runs of values a node spells as a whole (`PNode._run`), as
 * strings are: ascending by JS `<`, each written against the one before
 * it. A run that may be in any order is written ascending and decodes so.
 * One whose values are distinct but keep their order is written whichever
 * way costs less, as a choice and then either the values one by one as
 * they stand, or ascending followed by where each value stood, ranked
 * among the places not yet taken as `./ordinal` ranks distinct digits.
 * Arrays, sets and the keys of maps and records share these restrictions,
 * as they share `./ordinal`'s.
 */

import type { Encoder, Decoder } from '../packer';
import type { PNode, Run } from './base';
import { atPath, describe } from './path';
import { arrangementDigits, arrangementRanks, type Order } from './ordinal';
import type { Members } from './members';

/** The two spellings of distinct values in their own order, the plain one winning a tie. */
const PLAIN = 0;
const ASCENDING = 1;
const KEPT: readonly number[] = [PLAIN, ASCENDING];

/** Whether a run under `order` keeps the values' own order. */
const kept = (order: Order): boolean => order.sorted === undefined && order.unordered === undefined;

/** Compares two values of a run by JS `<`. */
const ascending = (a: unknown, b: unknown): number =>
  (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;

/** The run of `node`, which spells runs, for `order`. */
const runOf = (node: PNode<any>, order: Order): Run<unknown> =>
  (node._run as (unique: boolean) => Run<unknown>).call(node, order.unique !== undefined);

/**
 * Writes `values` of `node`, which spells runs, restricted by `order`, and
 * returns the position in `values` of each value in ascending order. A
 * repeat under `unique` and a descent under `sorted` throw, as does a value
 * `node` refuses, located by `segment` of its position. Values that keep
 * their order spell the choice between their two spellings in `choice`, of
 * two members, which they need.
 */
export function writeRun(
  enc: Encoder,
  node: PNode<any>,
  values: readonly unknown[],
  order: Order,
  segment: (i: number) => string | number,
  choice?: Members
): number[] {
  const seen = order.unique === undefined ? undefined : new Set<unknown>();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    try {
      if (seen?.has(value)) {
        throw new RangeError(`Value ${describe(value)} repeats an earlier one`);
      }
      if (order.sorted !== undefined && i > 0 && ascending(value, values[i - 1]) < 0) {
        throw new RangeError(`Value ${describe(value)} is below the one before it`);
      }
    } catch (error) {
      throw atPath(error, segment(i));
    }
    seen?.add(value);
  }
  const at = values.map((_, i) => i);
  if (order.sorted === undefined) {
    at.sort((a, b) => ascending(values[a], values[b]));
  }
  const spell = (write: (value: unknown) => void, i: number): void => {
    try {
      write(values[i]);
    } catch (error) {
      throw atPath(error, segment(i));
    }
  };
  const ascend = (): void => {
    const run = runOf(node, order);
    for (const i of at) {
      spell((value) => run.write(enc, value), i);
    }
  };
  if (!kept(order)) {
    ascend();
    return at;
  }
  enc.decide(KEPT, KEPT, (spelling) => {
    (choice as Members).write(enc, spelling);
    if (spelling === PLAIN) {
      values.forEach((_, i) => spell((value) => node._write(enc, value), i));
      return;
    }
    ascend();
    const place: number[] = [];
    at.forEach((i, k) => {
      place[i] = k;
    });
    const ranks = arrangementRanks(place);
    for (let i = 0; i < ranks.length; i++) {
      enc.compose(ranks[i], ranks.length - i);
    }
  });
  return at;
}

/** Reads `count` values `writeRun` wrote under the same node, order and choice, in the order they decode. */
export function readRun(
  dec: Decoder,
  node: PNode<any>,
  count: number,
  order: Order,
  choice?: Members
): unknown[] {
  const values: unknown[] = [];
  if (kept(order) && (choice as Members).read(dec) === PLAIN) {
    for (let k = 0; k < count; k++) {
      values.push(node._read(dec));
    }
    return values;
  }
  const run = runOf(node, order);
  for (let k = 0; k < count; k++) {
    values.push(run.read(dec));
  }
  if (!kept(order)) {
    return values;
  }
  const ranks: number[] = [];
  for (let i = 0; i < count; i++) {
    ranks.push(dec.parse(count - i));
  }
  return arrangementDigits(ranks).map((k) => values[k]);
}
