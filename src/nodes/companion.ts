/**
 * Companion recall under `p.any().adaptive()` and `p.object().adaptive()`,
 * whose fields are its keys: a key's value is often the one it had the
 * last time an earlier key of the same record, or of a record around it,
 * had the value it has now (a session, an address or a browser that
 * follows a user id), or simply that key's value (a count kept under two
 * names), or its own previous value with that key's value then swapped
 * for its value now (a URL built from a name), or close to that key's
 * value (a time sent just after the time it happened). Each key learns
 * from its own values which earlier key predicts it, and once one has paid
 * for itself, codes a learned flag ahead of its value: for a prediction, a
 * hit is the whole value, a miss the flag and then the value as before;
 * for a closeness, the encoder spells the value as its difference from
 * that key's value or as before, whichever costs less, and the flag says
 * which. Both sides learn the same from the values coded, so nothing else
 * travels. `p.object().follows()` declares the earlier key instead.
 */

import type { Encoder, Decoder, Journal } from '../packer';
import { Fenwick } from './fenwick';
import { readLive, writeLive } from './adaptive';
import { FIELD_DIGITS, FieldScale } from './fields';

/** How many values a scope holds: the record's earlier values and those of the records around it. */
export const MAX_SCOPE = 128;

/** How many earlier keys each key keeps evidence on. */
export const MAX_PAIRS = 16;

/** How many values all keys' companions remember in one message. */
export const MAX_ENTRIES = 1 << 16;

/** Past this total the hit/miss counts halve, as recall's new/seen counts do. */
const FLAG_WINDOW = 64;

/** The bits a predictor's estimated saving must reach before it is offered. */
const OFFER = 8;

/**
 * How much of a predictor's estimated saving each later value keeps, so
 * the estimate follows how well it predicts lately: a predictor that keeps
 * saving `b` bits a value settles at 16·b.
 */
const DECAY = 15 / 16;

/** The turns after which a lookup that rarely had a prediction stops, and how rarely: under 1 in `IDLE_RATE`. */
const IDLE_TURNS = 64;
const IDLE_RATE = 16;

/** The bits a value the key has not had is taken to cost by its own spelling. */
const NEW_COST = 12;

/** The longest value a template is taken from or makes. */
export const MAX_TEMPLATE = 1024;

// A pair's numbers: the lookup's hits, misses and estimated saving in bits,
// and the turns it had a prediction in; the same three for its equality, for
// its template and for its difference; then the turns the pair was in scope.
const HITS = 0;
const MISSES = 1;
const GAIN = 2;
const PREDICTED = 3;
const EQ_HITS = 4;
const EQ_MISSES = 5;
const EQ_GAIN = 6;
const TPL_HITS = 7;
const TPL_MISSES = 8;
const TPL_GAIN = 9;
const DIFF_HITS = 10;
const DIFF_MISSES = 11;
const DIFF_GAIN = 12;
const TURNS = 13;
const STATS = 14;

/**
 * The bits a difference from another key must save over one from this
 * key's previous value, by `Origin.cost`, to count as a hit: the rough
 * costs tie often enough on values unrelated to either.
 */
const DIFF_SLACK = 2;

/** How many fields of a difference keep a learned scale of their own; later ones share the last. */
const DIFF_SCALES = 16;

/** The choices of a value offered a difference, spelled as one (1) or by its node (0), the difference winning a tie. */
const DIFF_CHOICES: readonly number[] = [1, 0];

/** Whether `a` and `b` are of a kind that one may be a difference from the other: numbers, Dates, or strings of one length. */
const alike = (a: unknown, b: unknown): boolean =>
  typeof a === 'string'
    ? typeof b === 'string' && a.length === b.length
    : typeof a === 'number'
      ? typeof b === 'number'
      : a instanceof Date && b instanceof Date;

/** The farthest a Date's timestamp lies from the epoch. */
const MAX_TIMESTAMP = 8.64e15;

/** Whether `code` is an ASCII digit. */
const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/**
 * A value other values may be spelled as differences from: a safe integer
 * or a valid Date, one field, its value or timestamp; or a string with a
 * digit, up to `MAX_TEMPLATE` long, a field per run of ASCII digits, each
 * split into fields of at most `FIELD_DIGITS` from its start, read as one
 * integer of exactly that width.
 */
export class Origin {
  /** Per field, where it starts in the string and its width; none for a number or Date. */
  private readonly starts: number[] = [];
  private readonly widths: number[] = [];
  readonly values: number[] = [];

  private constructor(readonly value: number | string | Date) {
    if (typeof value === 'number') {
      this.values.push(value);
    } else if (typeof value !== 'string') {
      this.values.push(value.getTime());
    } else {
      for (let k = 0; k < value.length; ) {
        if (!isDigit(value.charCodeAt(k))) {
          k++;
          continue;
        }
        const start = k;
        let field = 0;
        for (; k < value.length && k - start < FIELD_DIGITS && isDigit(value.charCodeAt(k)); k++) {
          field = field * 10 + value.charCodeAt(k) - 48;
        }
        this.starts.push(start);
        this.widths.push(k - start);
        this.values.push(field);
      }
    }
  }

  /** The origin `value` makes, undefined when it makes none. */
  static of(value: unknown): Origin | undefined {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) ? new Origin(value) : undefined;
    }
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? undefined : new Origin(value);
    }
    if (typeof value !== 'string' || value.length > MAX_TEMPLATE) {
      return undefined;
    }
    for (let k = 0; k < value.length; k++) {
      if (isDigit(value.charCodeAt(k))) {
        return new Origin(value);
      }
    }
    return undefined;
  }

  /** The least and greatest value field `i` holds. */
  bounds(i: number): [number, number] {
    const { value } = this;
    if (typeof value === 'number') {
      return [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
    }
    return typeof value === 'string'
      ? [0, 10 ** this.widths[i] - 1]
      : [-MAX_TIMESTAMP, MAX_TIMESTAMP];
  }

  /**
   * The fields of `value` spelled from this origin: a safe integer from a
   * number, a valid Date from a Date, or from a string one of its length
   * with the same text between digits the same, and a digit wherever it
   * has one. Undefined for any other.
   */
  fieldsOf(value: unknown): number[] | undefined {
    const origin = this.value;
    if (typeof origin === 'number') {
      // -0 is left to its node, which may keep it.
      return Number.isSafeInteger(value) && !Object.is(value, -0) ? [value as number] : undefined;
    }
    if (typeof origin !== 'string') {
      return value instanceof Date && !isNaN(value.getTime()) ? [value.getTime()] : undefined;
    }
    if (typeof value !== 'string' || value.length !== origin.length) {
      return undefined;
    }
    for (let k = 0; k < value.length; k++) {
      const code = value.charCodeAt(k);
      const digit = isDigit(code);
      if (digit !== isDigit(origin.charCodeAt(k)) || (!digit && code !== origin.charCodeAt(k))) {
        return undefined;
      }
    }
    const { starts, widths } = this;
    return starts.map((start, i) => Number(value.slice(start, start + widths[i])));
  }

  /** The value with `fields`, each within its bounds. */
  build(fields: readonly number[]): number | string | Date {
    const origin = this.value;
    if (typeof origin === 'number') {
      return fields[0];
    }
    if (typeof origin !== 'string') {
      return new Date(fields[0]);
    }
    const { starts, widths } = this;
    let text = '';
    let at = 0;
    for (let i = 0; i < starts.length; i++) {
      text += origin.slice(at, starts[i]) + String(fields[i]).padStart(widths[i], '0');
      at = starts[i] + widths[i];
    }
    return text + origin.slice(at);
  }

  /** The bits `fields` take as differences from this origin, roughly: per field twice the bit length of the distance, and one. */
  cost(fields: readonly number[]): number {
    const { values } = this;
    let bits = 0;
    for (let i = 0; i < fields.length; i++) {
      bits += 2 * Math.log2(Math.abs(fields[i] - values[i]) + 1) + 1;
    }
    return bits;
  }
}

/**
 * The template of a key whose previous value was `previous` while an
 * earlier key had `before`, that one having `now`: `previous` with every
 * `before` in it, as strings, replaced by `now`, or, without one, every
 * part of `before` that changed, past what it shares with `now` at either
 * end, replaced by what it changed to. Undefined when `previous` is no
 * string, holds neither, or it or the template is longer than
 * `MAX_TEMPLATE`.
 */
export function template(previous: unknown, before: unknown, now: unknown): string | undefined {
  if (
    typeof previous !== 'string' ||
    previous.length > MAX_TEMPLATE ||
    typeof before === 'object' ||
    before === undefined
  ) {
    return undefined;
  }
  let from = String(before);
  let to = String(now);
  if (from === to) {
    return undefined;
  }
  if (from === '' || !previous.includes(from)) {
    let start = 0;
    const end = Math.min(from.length, to.length);
    while (start < end && from.charCodeAt(start) === to.charCodeAt(start)) {
      start++;
    }
    let tail = 0;
    while (
      tail < end - start &&
      from.charCodeAt(from.length - 1 - tail) === to.charCodeAt(to.length - 1 - tail)
    ) {
      tail++;
    }
    from = from.slice(start, from.length - tail);
    to = to.slice(start, to.length - tail);
    if (from === '' || !previous.includes(from)) {
      return undefined;
    }
  }
  const parts = previous.split(from);
  return previous.length + (parts.length - 1) * (to.length - from.length) > MAX_TEMPLATE
    ? undefined
    : parts.join(to);
}

/** Sets `stats[i]` to `value`, recording the change in `journal`. */
function set(stats: Float64Array, i: number, value: number, journal?: Journal): void {
  if (journal?.active === true) {
    journal.set(stats, i, stats[i]);
  }
  stats[i] = value;
}

/**
 * One message's values in scope on one side, flat as companion, value:
 * those coded since the array item, map entry, set item or top-level value
 * being coded began, up to `MAX_SCOPE`.
 */
export class Scope {
  readonly entries: unknown[] = [];
  /** How many more values the message's companions may remember. */
  readonly budget = new Float64Array([MAX_ENTRIES]);

  /** Where the value about to be coded begins in the scope. */
  open(): number {
    return this.entries.length;
  }

  /** Ends the value that began at `base`: what it added leaves the scope. */
  close(base: number, journal?: Journal): void {
    const { entries } = this;
    if (entries.length === base) {
      return;
    }
    if (journal?.active === true) {
      const removed = entries.slice(base);
      journal.call(() => {
        entries.push(...removed);
      });
    }
    entries.length = base;
  }

  /** Adds `companion`'s key's value `value`, while there is room. */
  push(companion: Companion, value: unknown, journal?: Journal): void {
    const { entries } = this;
    const at = entries.length;
    if (at === 2 * MAX_SCOPE) {
      return;
    }
    if (journal?.active === true) {
      journal.truncate(entries, at);
    }
    entries.push(companion, value);
    set(companion.at, 0, at, journal);
  }

  /**
   * `companion`'s key's latest value in the scope, `absent` when it has
   * none there. Only its latest push is looked at, so after that one left
   * the scope an earlier one still in it is not seen.
   */
  valueOf(companion: Companion, absent: unknown): unknown {
    const at = companion.at[0];
    const { entries } = this;
    return at < entries.length && entries[at] === companion ? entries[at + 1] : absent;
  }
}

/** What one earlier key knows of a later one's values. */
interface Pair {
  readonly other: Companion;
  /** The later key's value the last time the earlier one had each value; undefined once stopped. */
  last: Map<unknown, unknown> | undefined;
  readonly stats: Float64Array;
}

/**
 * One coding of a key's value: the pairs in scope with the earlier key's
 * value and template each, the prediction offered if any, and whether it
 * was the value.
 */
export interface Turn {
  readonly pairs: Pair[];
  readonly values: unknown[];
  readonly templates: (string | undefined)[];
  /** Per pair of the key, the earlier key's value now, undefined when out of scope. */
  readonly now: unknown[];
  readonly offered: boolean;
  /** Whether the prediction may be a value this key has not had: an earlier key's value, a template or a difference. */
  readonly fresh: boolean;
  /** The prediction; for a difference, the value it spelled once read. */
  prediction: unknown;
  /** When the offer is a difference, the earlier key's value it counts from. */
  readonly origin?: Origin;
  hit: boolean;
}

/** Counts one more hit or miss of `flag`. */
function learnFlag(flag: Fenwick, hit: boolean): void {
  flag.add(hit ? 1 : 0, 2);
  if (flag.total > FLAG_WINDOW) {
    flag.halve(true);
  }
}

/** Stands for no value in the scope; no coded value is it. */
const ABSENT = Symbol('absent');

/**
 * Sets `map`'s entry `key`, which it holds when `had`, to `value`, a new
 * one only while the message's budget lasts, recording the change in
 * `journal`.
 */
function remember(
  map: Map<unknown, unknown>,
  key: unknown,
  had: boolean,
  value: unknown,
  budget: Float64Array,
  journal?: Journal
): void {
  const active = journal?.active === true;
  if (had) {
    if (active) {
      const old = map.get(key);
      journal.call(() => {
        map.set(key, old);
      });
    }
  } else {
    if (budget[0] === 0) {
      return;
    }
    set(budget, 0, budget[0] - 1, journal);
    if (active) {
      journal.drop(map, key);
    }
  }
  map.set(key, value);
}

/**
 * The companion recall of one key in one message on one side: a pair for
 * each of the first `MAX_PAIRS` other keys met in its scope, the latest
 * first, each with four predictors, the value this key had when that key
 * last had its current value (the lookup), that key's value itself (the
 * equality), this key's previous value with that key's value then
 * replaced by its value now (the template, while that key was in scope
 * then too), and the value as its difference from that key's value, an
 * `Origin` (the difference), and an estimate of the bits each saves: on a
 * hit, what this key's own odds of the value would have cost, less the
 * flag; on a miss, the flag. A difference hits where it costs less than
 * the difference from this key's previous value, by `Origin.cost` and
 * `DIFF_SLACK`, and saves what it costs less; a value equal to the other
 * is left to the equality. Of the predictors with a prediction now that
 * hit twice, the one with the most saved, past `OFFER`, is offered. A
 * difference's fields each sit on a learned scale of the key's own.
 */
export class Companion {
  /** Where this key's latest value sits in the scope. */
  readonly at = new Float64Array(1);
  private readonly pairs: Pair[] = [];
  private readonly paired = new Set<Companion>();
  /** How often this key had each primitive value, and how many it had in all. */
  private readonly counts = new Map<unknown, number>();
  private readonly seen = new Float64Array(1);
  private readonly flag: Fenwick;
  /** Whether a value offered a difference is spelled as one, and the scales of its fields. */
  private readonly differs: Fenwick;
  private readonly scales: FieldScale[] = [];
  /** This key's previous value, and per pair the earlier key's value then, undefined when out of scope. */
  private previous: unknown;
  private before: unknown[] = [];

  constructor(
    private readonly scope: Scope,
    journal?: Journal
  ) {
    this.flag = new Fenwick([1, 1], journal);
    this.differs = new Fenwick([1, 1], journal);
  }

  /** Pairs this key with the keys in scope it has no pair with, while there is room. */
  private pairUp(journal?: Journal): void {
    const { entries } = this.scope;
    const { pairs, paired } = this;
    for (let i = entries.length - 2; i >= 0 && pairs.length < MAX_PAIRS; i -= 2) {
      const other = entries[i] as Companion;
      if (other !== this && !paired.has(other)) {
        if (journal?.active === true) {
          journal.truncate(pairs, pairs.length);
          journal.drop(paired, other);
        }
        pairs.push({ other, last: new Map(), stats: new Float64Array(STATS) });
        paired.add(other);
      }
    }
  }

  /** This key's pairs with a value in scope now, each with that value, and the prediction. */
  private turn(journal?: Journal): Turn {
    if (this.pairs.length < MAX_PAIRS) {
      this.pairUp(journal);
    }
    const { scope, pairs, previous, before } = this;
    const inScope: Pair[] = [];
    const values: unknown[] = [];
    const templates: (string | undefined)[] = [];
    const now: unknown[] = new Array(pairs.length);
    let best = OFFER;
    let offered = false;
    let fresh = false;
    let prediction: unknown;
    let origin: Origin | undefined;
    for (let k = 0; k < pairs.length; k++) {
      const pair = pairs[k];
      const value = scope.valueOf(pair.other, ABSENT);
      if (value === ABSENT) {
        continue;
      }
      now[k] = value;
      inScope.push(pair);
      values.push(value);
      const tpl = template(previous, before[k], value);
      templates.push(tpl);
      const { last, stats } = pair;
      if (last !== undefined && stats[GAIN] > best && stats[HITS] > 1 && last.has(value)) {
        best = stats[GAIN];
        offered = true;
        fresh = false;
        prediction = last.get(value);
        origin = undefined;
      }
      if (stats[EQ_GAIN] > best && stats[EQ_HITS] > 1) {
        best = stats[EQ_GAIN];
        offered = true;
        fresh = true;
        prediction = value;
        origin = undefined;
      }
      if (tpl !== undefined && stats[TPL_GAIN] > best && stats[TPL_HITS] > 1) {
        best = stats[TPL_GAIN];
        offered = true;
        fresh = true;
        prediction = tpl;
        origin = undefined;
      }
      if (stats[DIFF_GAIN] > best && stats[DIFF_HITS] > 1) {
        const from = Origin.of(value);
        if (from !== undefined) {
          best = stats[DIFF_GAIN];
          offered = true;
          fresh = true;
          prediction = undefined;
          origin = from;
        }
      }
    }
    return {
      pairs: inScope,
      values,
      templates,
      now,
      offered,
      fresh,
      prediction,
      origin,
      hit: false,
    };
  }

  /**
   * Writes `value`, by `spell` unless the prediction offered is the value,
   * when its flag stands for it, or the encoder spells it as a difference
   * where that costs less, when its flag and the difference stand for it.
   * Returns the turn, its `hit` set when the flag stands for the value.
   */
  write(enc: Encoder, value: unknown, spell: () => void): Turn {
    const turn = this.turn(enc.journal);
    const { origin } = turn;
    if (!turn.offered) {
      spell();
    } else if (origin === undefined) {
      turn.hit = Object.is(value, turn.prediction);
      writeLive(enc, this.flag, turn.hit ? 1 : 0);
      learnFlag(this.flag, turn.hit);
      if (!turn.hit) {
        spell();
      }
    } else {
      const fields = origin.fieldsOf(value);
      const choice = (c: number): void => {
        writeLive(enc, this.differs, c);
        learnFlag(this.differs, c === 1);
        if (c === 1) {
          for (let i = 0; i < origin.values.length; i++) {
            const [lo, hi] = origin.bounds(i);
            const field = (fields as number[])[i];
            this.scale(i).write(enc, field, origin.values[i], lo, hi);
            this.scale(i).learn(enc, field, origin.values[i]);
          }
        } else {
          spell();
        }
      };
      if (fields === undefined) {
        choice(0);
      } else {
        turn.hit = enc.decide(DIFF_CHOICES, DIFF_CHOICES, choice) === 1;
        turn.prediction = value;
      }
    }
    return turn;
  }

  /** Reads what `write` wrote: the turn, its `hit` set, and its `prediction` the value, when the flag stands for it. */
  read(dec: Decoder): Turn {
    const turn = this.turn();
    const { origin } = turn;
    if (!turn.offered) {
      return turn;
    }
    if (origin === undefined) {
      turn.hit = readLive(dec, this.flag) === 1;
      learnFlag(this.flag, turn.hit);
      return turn;
    }
    turn.hit = readLive(dec, this.differs) === 1;
    learnFlag(this.differs, turn.hit);
    if (turn.hit) {
      const fields = origin.values.map((at, i) => {
        const [lo, hi] = origin.bounds(i);
        const field = this.scale(i).read(dec, at, lo, hi);
        this.scale(i).learn(dec, field, at);
        return field;
      });
      turn.prediction = origin.build(fields);
    }
    return turn;
  }

  /** What `value` costs as a difference from this key's previous value, by `Origin.cost`; undefined when it is none. */
  private selfCost(value: unknown): number | undefined {
    const from = Origin.of(this.previous);
    const fields = from?.fieldsOf(value);
    return fields === undefined ? undefined : (from as Origin).cost(fields);
  }

  /** The learned scale of field `i` of a difference. */
  private scale(i: number): FieldScale {
    const { scales } = this;
    const at = Math.min(i, DIFF_SCALES - 1);
    while (scales.length <= at) {
      scales.push(new FieldScale());
    }
    return scales[at];
  }

  /**
   * Learns from `value`, the value coded on `turn`: each pair in scope
   * scores its predictors and remembers it, the key counts it and keeps
   * it for its templates, and, a string, number or Date, it joins the scope.
   */
  learn(turn: Turn, value: unknown, journal?: Journal): void {
    const primitive = typeof value !== 'object' || value === null;
    const { budget } = this.scope;
    const { counts, seen } = this;
    const count = primitive ? counts.get(value) : undefined;
    // The bits this key's own odds give the value.
    const own = count === undefined ? NEW_COST : Math.log2(seen[0] / count);
    const { pairs, values, templates } = turn;
    // What the value costs as a difference from this key's previous one, priced once some pair needs it.
    let priced = false;
    let self: number | undefined;
    for (let k = 0; k < pairs.length; k++) {
      const pair = pairs[k];
      const other = values[k];
      const { stats, last } = pair;
      set(stats, TURNS, stats[TURNS] + 1, journal);
      if (last !== undefined) {
        const predicted = last.get(other);
        const had = predicted !== undefined || last.has(other);
        if (had) {
          const hits = stats[HITS];
          const misses = stats[MISSES];
          const odds = (hits + 0.5) / (hits + misses + 1);
          set(stats, PREDICTED, stats[PREDICTED] + 1, journal);
          if (primitive && Object.is(predicted, value)) {
            set(stats, HITS, hits + 1, journal);
            set(stats, GAIN, stats[GAIN] * DECAY + own + Math.log2(odds), journal);
          } else {
            set(stats, MISSES, misses + 1, journal);
            set(stats, GAIN, stats[GAIN] * DECAY + Math.log2(1 - odds), journal);
          }
        }
        if (stats[TURNS] >= IDLE_TURNS && stats[PREDICTED] * IDLE_RATE < stats[TURNS]) {
          pair.last = undefined;
          if (journal?.active === true) {
            journal.call(() => {
              pair.last = last;
            });
          }
        } else if (primitive && typeof other !== 'object') {
          remember(last, other, had, value, budget, journal);
        }
      }
      const hits = stats[EQ_HITS];
      const odds = (hits + 0.5) / (hits + stats[EQ_MISSES] + 1);
      if (Object.is(other, value)) {
        set(stats, EQ_HITS, hits + 1, journal);
        set(stats, EQ_GAIN, stats[EQ_GAIN] * DECAY + own + Math.log2(odds), journal);
      } else {
        set(stats, EQ_MISSES, stats[EQ_MISSES] + 1, journal);
        set(stats, EQ_GAIN, stats[EQ_GAIN] * DECAY + Math.log2(1 - odds), journal);
      }
      const tpl = templates[k];
      if (tpl !== undefined) {
        const hits = stats[TPL_HITS];
        const odds = (hits + 0.5) / (hits + stats[TPL_MISSES] + 1);
        if (tpl === value) {
          set(stats, TPL_HITS, hits + 1, journal);
          set(stats, TPL_GAIN, stats[TPL_GAIN] * DECAY + own + Math.log2(odds), journal);
        } else {
          set(stats, TPL_MISSES, stats[TPL_MISSES] + 1, journal);
          set(stats, TPL_GAIN, stats[TPL_GAIN] * DECAY + Math.log2(1 - odds), journal);
        }
      }
      // A value equal to the other is the equality's to predict.
      if (alike(other, value) && !Object.is(other, value)) {
        if (!priced) {
          priced = true;
          self = this.selfCost(value);
        }
        if (self !== undefined) {
          const from = Origin.of(other);
          const fields = from?.fieldsOf(value);
          const hits = stats[DIFF_HITS];
          const odds = (hits + 0.5) / (hits + stats[DIFF_MISSES] + 1);
          const saved =
            fields === undefined ? 0 : self - (from as Origin).cost(fields) - DIFF_SLACK;
          if (saved > 0) {
            set(stats, DIFF_HITS, hits + 1, journal);
            set(stats, DIFF_GAIN, stats[DIFF_GAIN] * DECAY + saved + Math.log2(odds), journal);
          } else {
            set(stats, DIFF_MISSES, stats[DIFF_MISSES] + 1, journal);
            set(stats, DIFF_GAIN, stats[DIFF_GAIN] * DECAY + Math.log2(1 - odds), journal);
          }
        }
      }
    }
    if (journal?.active === true) {
      const { previous, before } = this;
      journal.call(() => {
        this.previous = previous;
        this.before = before;
      });
    }
    this.previous = value;
    this.before = turn.now;
    if (primitive) {
      remember(counts, value, count !== undefined, (count ?? 0) + 1, budget, journal);
      set(seen, 0, seen[0] + 1, journal);
    }
    if (typeof value === 'string' || typeof value === 'number' || value instanceof Date) {
      this.scope.push(this, value, journal);
    }
  }
}

/** What a `Follow` predicts for one value: whether it offers a prediction, which, of which kind, and whether that was the value. */
export interface Followed {
  readonly offered: boolean;
  readonly prediction: unknown;
  /** 0 for a value the field had, 1 for the leading field's value itself, 2 for a template. */
  readonly kind: number;
  hit: boolean;
}

/**
 * A declared companion, `.follows()` on `p.object`: a field predicted from
 * an earlier one of the same object, in one message on one side. While the
 * leading field holds a string or number, a flag comes first: a hit is the
 * field's value the last time the leading field had this value, or, the
 * first time, the field's previous value with the leading field's value
 * then replaced by its value now, or else the leading field's value
 * itself. The flag is a bit, or learned per kind of prediction when
 * `learning`.
 */
export class Follow {
  private readonly last = new Map<unknown, unknown>();
  /** The learned flags of a remembered prediction, of the leading value itself and of a template. */
  private readonly flags?: readonly [Fenwick, Fenwick, Fenwick];
  /** The field's previous value, and the leading field's value then. */
  private previous: unknown;
  private before: unknown;

  constructor(
    private readonly budget: Float64Array,
    learning: boolean,
    journal?: Journal
  ) {
    if (learning) {
      this.flags = [
        new Fenwick([1, 1], journal),
        new Fenwick([1, 1], journal),
        new Fenwick([1, 1], journal),
      ];
    }
  }

  /** The prediction while the leading field has `leader`. */
  private predict(leader: unknown): Followed {
    if (typeof leader !== 'string' && typeof leader !== 'number') {
      return { offered: false, prediction: undefined, kind: 0, hit: false };
    }
    const { last } = this;
    const predicted = last.get(leader);
    if (predicted !== undefined || last.has(leader)) {
      return { offered: true, prediction: predicted, kind: 0, hit: false };
    }
    const tpl = template(this.previous, this.before, leader);
    return tpl === undefined
      ? { offered: true, prediction: leader, kind: 1, hit: false }
      : { offered: true, prediction: tpl, kind: 2, hit: false };
  }

  /** Writes whether `value` is the prediction while the leading field has `leader`. */
  write(enc: Encoder, leader: unknown, value: unknown): Followed {
    const turn = this.predict(leader);
    if (turn.offered) {
      turn.hit = Object.is(value, turn.prediction);
      const { flags } = this;
      if (flags === undefined) {
        enc.compose(turn.hit ? 1 : 0, 2);
      } else {
        const flag = flags[turn.kind];
        writeLive(enc, flag, turn.hit ? 1 : 0);
        learnFlag(flag, turn.hit);
      }
    }
    return turn;
  }

  /** Reads what `write` wrote: the turn, its `hit` set when the prediction is the value. */
  read(dec: Decoder, leader: unknown): Followed {
    const turn = this.predict(leader);
    if (turn.offered) {
      const { flags } = this;
      if (flags === undefined) {
        turn.hit = dec.parse(2) === 1;
      } else {
        const flag = flags[turn.kind];
        turn.hit = readLive(dec, flag) === 1;
        learnFlag(flag, turn.hit);
      }
    }
    return turn;
  }

  /**
   * Remembers `value` as the field's value while the leading field has
   * `leader`, and as its previous value, with `leader` the leading field's
   * then.
   */
  learn(leader: unknown, value: unknown, journal?: Journal): void {
    if (journal?.active === true) {
      const { previous, before } = this;
      journal.call(() => {
        this.previous = previous;
        this.before = before;
      });
    }
    const keyed = typeof leader === 'string' || typeof leader === 'number';
    this.previous = value;
    this.before = keyed ? leader : undefined;
    if (!keyed || (typeof value === 'object' && value !== null)) {
      return;
    }
    const { last } = this;
    remember(last, leader, last.has(leader), value, this.budget, journal);
  }
}
