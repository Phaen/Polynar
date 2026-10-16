/**
 * Values spelled by recall: a value the node has already coded in the
 * message costs its place among the distinct values seen so far, a new one
 * an escape plus its full spelling. `.recall()` on a node puts it in front
 * of the node's own spelling; `p.any` prices its strings, record keys and
 * record shapes this way.
 */

import { Encoder, Decoder, COST_UNITS, costUnits, log2Units, type Journal } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { Fenwick } from './fenwick';
import { readLive, writeLive } from './adaptive';
import { MAX_CLASS, classOf } from './magnitude';

/**
 * How many `identity` calls are running. Inside one, every recall writes
 * its value's identity when it is given one, and spells the value
 * otherwise, so a container's identity spells each value inside it once
 * rather than once more per recall around it, and a string or a number
 * costs its key rather than a trial of its learned spellings.
 */
let measuring = 0;

/** Writes `key` so that no other key writes the same symbols: its length, then each code unit. */
function writeKey(enc: Encoder, key: string): void {
  enc.compose(key.length, Number.MAX_SAFE_INTEGER);
  for (let i = 0; i < key.length; i++) {
    enc.compose(key.charCodeAt(i), 0x10000);
  }
}

/**
 * The identity a value is recalled under: the symbols a fresh message
 * holding only the value logs as `write` spells it, each its bucket and
 * total, with every recall inside it writing the identity of its value in
 * place of the value. Values with the same spelling decode the same, so
 * recalling one for the other changes nothing the decoder sees. Throws
 * whatever `write` throws.
 */
export function identity(write: (enc: Encoder) => void): string {
  const enc = new Encoder();
  measuring++;
  try {
    write(enc);
  } finally {
    measuring--;
  }
  const { cums, freqs, totals, weighted } = enc.events();
  let key = '';
  for (let i = 0; i < totals.length; i++) {
    key += weighted[i] ? `${cums[i]}+${freqs[i]}/${totals[i]},` : `${cums[i]}/${totals[i]},`;
  }
  return key;
}

/**
 * Runs `run` as outside every `identity`, so the recalls it writes through
 * write values as a message does, for a write that is read back.
 */
export function unmeasured<T>(run: () => T): T {
  const outer = measuring;
  measuring = 0;
  try {
    return run();
  } finally {
    measuring = outer;
  }
}

/**
 * A deep copy of a decoded value, made in the caller's realm, for a recall
 * whose values may be mutated: plain objects (an own `__proto__` key kept
 * as one, a null prototype kept), arrays, Maps (keys and values), Sets,
 * Dates, RegExps, ArrayBuffers, DataViews and typed arrays copy, their
 * contents copied in turn. Primitives and instances of any other class
 * pass through as they are.
 */
export function copy<T>(value: T): T {
  return clone(value) as T;
}

/** `copy` over any value. */
function clone(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(clone);
  }
  if (value instanceof Map) {
    return new Map([...value].map(([key, item]) => [clone(key), clone(item)]));
  }
  if (value instanceof Set) {
    return new Set([...value].map(clone));
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof RegExp) {
    return new RegExp(value);
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }
  if (value instanceof DataView) {
    const { buffer, byteOffset, byteLength } = value;
    return new DataView(buffer.slice(byteOffset, byteOffset + byteLength));
  }
  if (ArrayBuffer.isView(value)) {
    // `from` copies the view's elements into a buffer of its own, and keeps
    // the class, a Buffer included.
    return (value.constructor as unknown as { from(items: unknown): unknown }).from(value);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  const out: Record<string, unknown> = Object.create(proto as object | null);
  for (const key of Object.keys(value)) {
    // Defined rather than assigned, so a '__proto__' key lands as an own property.
    Object.defineProperty(out, key, {
      value: clone((value as Record<string, unknown>)[key]),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * What each value adds to its side of the new/seen counts, which start at
 * 1 each, and the total past which they halve, rounding up. The halving
 * makes the odds of a new value follow the rate at which new values
 * currently come rather than their rate over the whole message, so a
 * field that settles on a few values stops paying for the run of new ones
 * it opened with, within a few dozen values. The side a field never takes
 * keeps its count of 1, so a field whose values never recur pays about
 * 1/500 of a bit per value for the escape.
 */
const FLAG_STEP = 32;
const FLAG_WINDOW = 1024;

/**
 * What each recency class adds to its count per recall; the share of each
 * spelling's past costs every later recall keeps, 1 - 2^-`EVIDENCE_DECAY`;
 * and by how much less, in `COST_UNITS`, recency must have cost to spell
 * the next recall, 6 bits, so values that recur at random keep their
 * counts rather than follow the noise.
 */
const CLASS_STEP = 2;
const EVIDENCE_DECAY = 4;
const MARGIN = 6 * COST_UNITS;

/**
 * The learned odds of one message's recall: whether the value is new or
 * seen, by the counts above; and, for a seen value, which one, spelled one
 * of two ways. By count, each member counting 1 when first coded and 1
 * more each time it is recalled; or by recency, its rank among the seen
 * values by when each was last coded, the latest 0, as the bit-length
 * class of the rank under learned counts and then the rank within the
 * class, every one alike. Both spellings price every recall, and a recall
 * goes by recency only while the recent recalls cost less so by `MARGIN`,
 * so a field whose values come back in runs or rotations codes them by
 * recency and one whose values recur at steady rates keeps its counts.
 * An open recall keeps to counts.
 */
interface Learning {
  readonly fresh: Fenwick;
  readonly counts: Fenwick;
  readonly recency?: Recency;
}

/** What spells a seen value by recency, and what picks it. */
interface Recency {
  /** A 1 at each member's latest turn, a turn being a value coded. */
  readonly turns: Fenwick;
  /** Per turn, its member; per member, its latest turn. */
  readonly owners: number[];
  readonly latest: number[];
  /** The counts of the recency classes, from class 0, rank 0. */
  readonly classes: Fenwick;
  /** The decayed past costs, in `COST_UNITS`, by count and by recency. */
  readonly evidence: Float64Array;
}

/** What the encoder knows of one message's recall: each value's member by identity, and the learned odds. */
interface Writing {
  readonly index: Map<string, number>;
  readonly learning: Learning;
}

/** What the decoder knows of one message's recall: the values in order of first appearance, and the learned odds. */
interface Reading<T> {
  readonly values: T[];
  readonly learning: Learning;
}

/** Fresh learned odds, with `recency` too when given, recording their changes in `journal` when given. */
function learning(recency: boolean, journal?: Journal): Learning {
  return {
    fresh: new Fenwick([1, 1], journal),
    counts: Fenwick.zeros(0, journal),
    recency: recency
      ? {
          turns: Fenwick.zeros(0, journal),
          owners: [],
          latest: [],
          classes: new Fenwick(new Array<number>(MAX_CLASS + 1).fill(1), journal),
          evidence: new Float64Array(2),
        }
      : undefined,
  };
}

/** Whether `recency` spells the next recall: the recent recalls cost less so, by `MARGIN`. */
const byRecency = (recency: Recency | undefined): recency is Recency =>
  recency !== undefined && recency.evidence[1] + MARGIN < recency.evidence[0];

/** The rank of seen value `seen`, from 0, by when each was last coded, the latest first. */
function rankOf({ turns, latest }: Recency, seen: number): number {
  return turns.total - turns.prefix(latest[seen] + 1);
}

/** The first rank of recency class `cls`, past 0, and how many ranks of `n` it holds. */
function classSpan(cls: number, n: number): [start: number, width: number] {
  const start = 2 ** (cls - 1);
  return [start, Math.min(start, n - start)];
}

/** Lists seen value `seen` as the one coded last, recording the change in `journal`. */
function touch({ turns, owners, latest }: Recency, seen: number, journal?: Journal): void {
  const active = journal?.active === true;
  const turn = turns.size;
  turns.push(1);
  if (active) {
    journal.truncate(owners, turn);
  }
  owners.push(seen);
  if (seen === latest.length) {
    if (active) {
      journal.truncate(latest, seen);
    }
    latest.push(turn);
  } else {
    if (active) {
      journal.set(latest, seen, latest[seen]);
    }
    turns.add(latest[seen], -1);
    latest[seen] = turn;
  }
}

/** Lists a new value in `learning`. */
function learnNew({ counts, recency }: Learning, journal?: Journal): void {
  counts.push(1);
  if (recency !== undefined) {
    touch(recency, counts.size - 1, journal);
  }
}

/**
 * Learns the recall of seen value `seen`: it counts once more, and by
 * recency, what each spelling would have cost joins its evidence and the
 * value becomes the latest.
 */
function learnSeen({ counts, recency }: Learning, seen: number, journal?: Journal): void {
  if (recency !== undefined) {
    const { classes, evidence } = recency;
    const n = counts.size;
    const cls = classOf(rankOf(recency, seen));
    let units = costUnits(classes.freq(cls), classes.prefix(classOf(n - 1) + 1));
    if (cls > 0) {
      units += log2Units(classSpan(cls, n)[1]);
    }
    const costs = [costUnits(counts.freq(seen), counts.total), units];
    for (let k = 0; k < 2; k++) {
      if (journal?.active === true) {
        journal.set(evidence, k, evidence[k]);
      }
      evidence[k] = evidence[k] - Math.floor(evidence[k] / 2 ** EVIDENCE_DECAY) + costs[k];
    }
    classes.add(cls, CLASS_STEP);
    touch(recency, seen, journal);
  }
  counts.add(seen, 1);
}

/** Counts one more value as new (0) or seen (1). */
function learn(fresh: Fenwick, seen: number): void {
  fresh.add(seen, FLAG_STEP);
  if (fresh.total > FLAG_WINDOW) {
    fresh.halve(true);
  }
}

/** The two choices of an open recall for a value it has seen, recalling it winning a tie. */
const RECALLED = 1;
const CHOICES: readonly number[] = [RECALLED, 0];

/** How a recall codes: `open` as `Recall` describes it, `copy` as `read` returns a value. */
export interface RecallOptions<T> {
  readonly open?: boolean;
  readonly copy?: (value: T) => T;
}

/**
 * The recall of one node: member 0 of its table is "new", every later
 * member a value the node coded in the message, in order of first
 * appearance. A value first costs whether it is new or seen, learned as
 * the message goes on, and a seen one then its member among the seen
 * values by how often each was coded, or, once that has cost more lately,
 * by how recently, so a field whose values never recur soon pays next to
 * nothing for the escape and a value that keeps coming back costs well
 * under a bit. The message's first value meets a table of one member,
 * which costs nothing. The encoder matches values by an identity string,
 * `identity` unless the caller has a cheaper one; the decoder needs none.
 *
 * `open`, as `.adaptive()` leaves recall on a node that does not declare
 * it, the recall is only one of the node's methods: the encoder spells a
 * value it has seen in full instead when that costs less,
 * as a new value the decoder then lists again, so a node whose own
 * spelling already prices its repeats well loses next to nothing. It
 * keeps to counts: a choice made value by value would take recency's
 * cheap recalls over a spelling, such as a difference, that learns more
 * from the value.
 */
export class Recall<T> {
  readonly open: boolean;
  /** Turns a recalled value into what `read` returns; the value itself when left out. */
  private readonly copy?: (value: T) => T;

  constructor(options: RecallOptions<T> = {}) {
    this.open = options.open === true;
    this.copy = options.copy;
  }

  private writing(enc: Encoder): Writing {
    return enc.state(this, () => ({
      index: new Map(),
      learning: learning(!this.open, enc.journal),
    }));
  }

  private reading(dec: Decoder): Reading<T> {
    return dec.state(this, () => ({
      values: [],
      learning: learning(!this.open),
    }));
  }

  /**
   * Writes the member of the value whose identity is `key`, or that `key`
   * returns, or member 0 and then `spell()` when the node has not coded it
   * in the message, or, when open, when spelling it costs less. Inside
   * `identity` it writes a `key` given as a string, or else spells the
   * value without asking `key`. Returns whether the value was recalled.
   */
  write(enc: Encoder, key: string | (() => string), spell: () => void): boolean {
    if (measuring > 0) {
      if (typeof key === 'string') {
        writeKey(enc, key);
      } else {
        spell();
      }
      return false;
    }
    const writing = this.writing(enc);
    const id = typeof key === 'string' ? key : key();
    const member = writing.index.get(id);
    if (member === undefined) {
      this.writeNew(enc, writing, id, spell);
      return false;
    }
    if (!this.open) {
      this.writeSeen(enc, writing, member);
      return true;
    }
    const choice = enc.decide(CHOICES, CHOICES, (c) => {
      if (c === RECALLED) {
        this.writeSeen(enc, writing, member);
      } else {
        this.writeNew(enc, writing, id, spell);
      }
    });
    return choice === RECALLED;
  }

  /** Writes `member`, a value already coded. */
  private writeSeen(enc: Encoder, { learning }: Writing, member: number): void {
    const { fresh, counts, recency } = learning;
    writeLive(enc, fresh, 1);
    learn(fresh, 1);
    const seen = member - 1;
    const n = counts.size;
    if (!byRecency(recency)) {
      writeLive(enc, counts, seen);
    } else if (n > 1) {
      const { classes } = recency;
      const rank = rankOf(recency, seen);
      const cls = classOf(rank);
      enc.composeWeighted(classes.cum(cls), classes.freq(cls), classes.prefix(classOf(n - 1) + 1));
      if (cls > 0) {
        const [start, width] = classSpan(cls, n);
        enc.compose(rank - start, width);
      }
    }
    learnSeen(learning, seen, enc.journal);
  }

  /**
   * Writes the escape and `spell()`, and lists the value as a new member;
   * a value already listed keeps its first member for the encoder.
   */
  private writeNew(
    enc: Encoder,
    { index, learning }: Writing,
    key: string,
    spell: () => void
  ): void {
    const seen = learning.counts.size;
    if (seen > 0) {
      writeLive(enc, learning.fresh, 0);
      learn(learning.fresh, 0);
    }
    spell();
    learnNew(learning, enc.journal);
    if (!index.has(key)) {
      index.set(key, seen + 1);
      if (enc.journal.active) {
        enc.journal.drop(index, key);
      }
    }
  }

  /**
   * Reads a value `write` wrote: a recalled value as `copy` makes it from
   * the one first decoded, or a new one read by `spell()`.
   */
  read(dec: Decoder, spell: () => T): T {
    const { values, learning } = this.reading(dec);
    let member = 0;
    if (values.length > 0) {
      const { fresh, counts, recency } = learning;
      const recalled = readLive(dec, fresh);
      learn(fresh, recalled);
      if (recalled === 1) {
        const n = counts.size;
        let seen = 0;
        if (!byRecency(recency)) {
          seen = readLive(dec, counts);
        } else if (n > 1) {
          const { classes, turns, owners } = recency;
          const cls = dec.parseMember(classes.prefix(classOf(n - 1) + 1), classes);
          let rank = 0;
          if (cls > 0) {
            const [start, width] = classSpan(cls, n);
            rank = start + dec.parse(width);
          }
          seen = owners[turns.locate(turns.total - 1 - rank)];
        }
        learnSeen(learning, seen);
        member = seen + 1;
      }
    }
    if (member > 0) {
      const value = values[member - 1];
      return this.copy === undefined ? value : this.copy(value);
    }
    const value = spell();
    learnNew(learning);
    values.push(value);
    return value;
  }
}

/**
 * A value spelled by its place among the distinct values coded so far in
 * the message through `recall`, or as a new value through `inner`, under
 * learned odds. `key` gives the identity values are matched under. A
 * recall of its own unless given one, which nodes with different spellings
 * may share, so a value one of them coded recalls through any of them.
 */
export class PRecall<T> extends PNode<T> {
  readonly _kinds?: readonly Kind[];

  constructor(
    private readonly inner: PNode<T>,
    private readonly key: (value: T) => string,
    private readonly recall = new Recall<T>()
  ) {
    super();
    this._kinds = inner._kinds;
  }

  _write(enc: Encoder, value: T): void {
    this.recall.write(enc, this.key(value), () => this.inner._write(enc, value));
  }

  _read(dec: Decoder): T {
    return this.recall.read(dec, () => this.inner._read(dec));
  }
}
