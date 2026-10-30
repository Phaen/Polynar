/**
 * The predictor state of one message (spec §4.3, §4.6): per prior, the id table, the message
 * populations of each alphabet, the run-time copy of the prior and the paths' state; the list
 * scope; and the string coders that drive the symbol predictor and the value step (spec §4.5,
 * §6.5).
 *
 * Predictors with different priors share nothing: an id table is seeded from its prior's
 * symbols, so each prior gets a space of its own. Within a space, the message population of an
 * alphabet and the state of a path are built with the options of the first predictor that uses
 * them.
 *
 * The coders take and return the alphabet's own symbols (code points for text, byte values for
 * bytes, structure ids for structure), never code-point ids: an id is assigned on first
 * reference, and both sides must reference a new code point at the same moment, after the
 * step's table, which only the coder can arrange.
 */

import type { Decoder, Encoder } from '../packer';
import { CorruptInputError } from '../packer/errors';
import { div, log2Fix } from './arith';
import { Ids } from './alphabet';
import { NumberCoder, NumberState } from './numbers';
import type { NumberRange, PlainNumber, RecordEntry } from './numbers';
import { SymbolPredictor, defaultFeatures, newPathState } from './symbols';
import type { Features, MessageCore, PathState, Sink, Source } from './symbols';
import type { Distribution } from './distribution';
import { Population, frozen } from './tables';
import type { Frozen } from './tables';
import { END, ESCAPE } from './types';
import type { AlphabetKind, Ends, LoadedPrior, PathKey, Resolved, RunPrior } from './types';
import { MemberStep, VSTEP_N } from './values';
import type { Occurrences, RecordView } from './values';
import { newRunPrior } from './weights';

export type { Features, Sink, Source, Table } from './symbols';
export type { NumberRange, PlainNumber } from './numbers';

export interface SessionOptions {
  /** Switches of the engine's parts, for measurement; every part is on by default. */
  readonly features?: Partial<Features>;
  /** D2's fallback: the value population exists only from the message's second value on. */
  readonly valueFromSecond?: boolean;
  /**
   * Training (train.ts): every predictor of the message codes in one space under `carry.loaded`,
   * whatever prior its node names, and learns into `carry` itself, so the next message that
   * carries it continues from this one's end state.
   */
  readonly carry?: RunPrior;
  /** Training: called with every symbol a predictor learns, coded or implied, in order. */
  readonly trace?: Trace;
}

/** A symbol id a predictor learned and the alphabet it belongs to. */
export type Trace = (id: number, alphabet: AlphabetKind) => void;

/** Codes one value of an alphabet's symbols at a path, with END by the value's `Ends`. */
export interface TextCoder {
  write(enc: Sink, syms: ArrayLike<number>, len: number, ends: Ends): void;
  read(dec: Source, ends: Ends): Int32Array;
}

/** The side a session lives on: an `Encoder` or a `Decoder`. */
export interface Side {
  state<S>(key: object, init: () => S): S;
  /** Active while the encoder tries a spelling it may take back. */
  readonly journal?: { readonly active: boolean };
}

interface Pair {
  readonly msg: Population;
  readonly msgF: Population;
}

/** Codes one integer at a path (spec §4.5): `Session.number`. */
export interface NumberAccess {
  write(enc: Encoder, x: number): void;
  read(dec: Decoder): number;
}

/** Codes one declared member at a path: `Session.step`. */
export interface MemberAccess {
  write(enc: Encoder, member: number): void;
  read(dec: Decoder): number;
}

/** A container end a structure step bounds: `end` is an entry only when `allow`. */
export interface Bound {
  readonly end: number;
  readonly allow: boolean;
}

/**
 * A choice node's declared weights as prior counts of the structure symbols it is coded by, each at
 * least 1, loaded once per (`key`, population) on first use, scaled up to the built-in's counts of
 * the same symbols where those are larger.
 */
export interface MarkerPrior {
  readonly key: object;
  readonly counts: readonly (readonly [sym: number, count: number])[];
}

/**
 * Codes a structure symbol (spec §6.5) through the innermost open container's structure
 * predictor, or the caller's own outside every container. `target` is the node the symbol is the
 * first structure symbol of, which then takes it with `Session.take`.
 */
export interface MarkerAccess {
  write(enc: Encoder, sym: number, target?: object, bound?: Bound, prior?: MarkerPrior): void;
  read(dec: Decoder, target?: object, bound?: Bound, prior?: MarkerPrior): number;
}

/** A container on the predictor: where its children's structure symbols are coded. */
interface Scope {
  readonly path: PathKey;
  readonly o: Resolved;
}

/** A path's number state and the coder bound to it. */
interface NumberPath {
  readonly state: NumberState;
  readonly coder: NumberCoder;
}

/** A path's restricted value step and its deltas over the value-step cells. */
interface MemberPath {
  readonly step: MemberStep;
  readonly delta: Float64Array;
}

/** Per-path state by `PathKey`: a node or key path directly, a node's derived paths under the node. */
class PathMap<T> {
  private readonly direct = new Map<unknown, T>();
  private readonly derived = new Map<object, Map<number, T>>();

  get(key: PathKey, make: () => T): T {
    let map: Map<unknown, T> = this.direct;
    let k: unknown = key;
    if (Array.isArray(key)) {
      const [node, sub] = key as unknown as readonly [object, number];
      let m = this.derived.get(node);
      if (m === undefined) {
        m = new Map();
        this.derived.set(node, m);
      }
      map = m;
      k = sub;
    }
    let v = map.get(k);
    if (v === undefined) {
      v = make();
      map.set(k, v);
    }
    return v;
  }
}

/** Prices the calls a coder makes, in bits · 2^RB (`log2Fix` of total over frequency). */
class CostSink implements Sink {
  bits = 0;

  composeWeighted(_cum: number, freq: number, total: number): void {
    this.bits += log2Fix(total) - log2Fix(freq);
  }

  compose(_integer: number, radix: number): void {
    this.bits += log2Fix(radix);
  }
}

/** The predictors of one prior in a message: its ids, populations, run prior and paths. */
export class Space implements MessageCore {
  seen = new Uint8Array(512);
  distinct = 0;
  b = 0;
  n = 0;
  valueId = -1;
  valuePop: Population | null = null;
  valuesStarted = false;
  readonly ids: Ids;
  readonly run: RunPrior;
  private readonly builtin: Frozen;
  private readonly pairs = new Map<string, Pair>();
  private readonly paths = new PathMap<PathState>();
  private readonly numbers = new PathMap<NumberPath>();
  private readonly members = new PathMap<MemberPath>();
  private readonly preds = new Map<PathState, Map<AlphabetKind, SymbolPredictor>>();

  constructor(
    prior: LoadedPrior,
    readonly features: Features,
    readonly valueFromSecond: boolean,
    carry: RunPrior | undefined,
    readonly trace: Trace | null
  ) {
    this.ids = new Ids(prior);
    this.run = carry ?? newRunPrior(prior);
    this.builtin = frozen(prior, this.ids);
  }

  /** The built-in population's order-0 count of symbol id `sym`. */
  builtinCount(sym: number): number {
    return this.builtin.tab.count(0, sym);
  }

  pathState(key: PathKey, o: Resolved): PathState {
    return this.paths.get(key, () => newPathState(o, this.features));
  }

  /** The number state of a path and its coder, made with the range and spelling of first use. */
  number(key: PathKey, o: Resolved, range: NumberRange, plain: PlainNumber): NumberPath {
    return this.numbers.get(key, () => {
      const state = new NumberState(o, this.run.loaded.numberStart);
      return { state, coder: new NumberCoder(state, this.run, o, range, plain) };
    });
  }

  /** The restricted value step of a path, made with the count and weights of first use. */
  member(
    key: PathKey,
    o: Resolved,
    count: number,
    weights: readonly number[] | undefined
  ): MemberPath {
    return this.members.get(key, () => ({
      step: new MemberStep(count, weights, o.history, o.quantisation),
      delta: new Float64Array(VSTEP_N),
    }));
  }

  /**
   * The population a member step's positions count in: the text alphabet's message population,
   * or under `separate` the path's own.
   */
  positions(key: PathKey, o: Resolved): Population {
    return o.separate ? this.pathState(key, o).pop : this.pair('text', o).msg;
  }

  private pair(alphabet: AlphabetKind, o: Resolved): Pair {
    const kind = alphabet === 'bytes' ? 'bytes' : 'text';
    let p = this.pairs.get(kind);
    if (p === undefined) {
      p = { msg: new Population(o), msgF: new Population(o) };
      this.pairs.set(kind, p);
    }
    return p;
  }

  /**
   * The symbol predictor of a path and alphabet, made on first use. `members` closes a text
   * alphabet to those code points; a path belongs to one node, so it is made with the same
   * members every time.
   */
  symbols(
    path: PathKey,
    o: Resolved,
    alphabet: AlphabetKind,
    members?: ArrayLike<number>
  ): SymbolPredictor {
    const ps = this.pathState(path, o);
    let byAlphabet = this.preds.get(ps);
    if (byAlphabet === undefined) {
      byAlphabet = new Map();
      this.preds.set(ps, byAlphabet);
    }
    let pred = byAlphabet.get(alphabet);
    if (pred === undefined) {
      const p = o.separate ? null : this.pair(alphabet, o);
      // A closed alphabet's members take their ids when its predictor is made, in their order,
      // which both sides reach at the same point of the message.
      const closed =
        members === undefined ? null : Int32Array.from(members, (cp) => this.ids.idOf(cp));
      pred = new SymbolPredictor(
        this,
        ps,
        o,
        alphabet,
        this.run,
        alphabet === 'bytes' ? null : this.builtin,
        p === null ? null : p.msg,
        p === null ? null : p.msgF,
        closed
      );
      byAlphabet.set(alphabet, pred);
    }
    return pred;
  }
}

/** One record's value-step pairs in coding order: the step and the id of each. */
interface RecordPairs {
  readonly steps: Occurrences[];
  readonly ids: number[];
}

export class Session implements RecordView {
  readonly features: Features;
  readonly valueFromSecond: boolean;
  /** The current item's index in the innermost list, −1 outside a list. */
  listIndex = -1;
  private readonly lists: number[] = [];
  /** The open records, innermost last: the numbers coded in each so far. */
  private readonly records: RecordEntry[][] = [];
  /** Every record's value-step pairs, by record id. */
  private readonly recordPairs: RecordPairs[] = [];
  /** The open records' ids and, per open record, its pairs by step, innermost last. */
  private readonly openRecords: number[] = [];
  private readonly openPairs: Map<Occurrences, Set<number>>[] = [];
  private readonly spaces = new Map<LoadedPrior, Space>();
  private first: Space | null = null;
  /** The open containers, innermost last; null for a container off the predictor. */
  private readonly scopes: (Scope | null)[] = [];
  /** The last structure symbol coded for a node, until that node takes it. */
  private pendingSym = -1;
  private pendingFor: object | null = null;
  /** The choice nodes whose weights each structure population holds. */
  private readonly loaded = new Map<Population, Set<object>>();
  private readonly carry: RunPrior | undefined;
  private readonly trace: Trace | null;

  constructor(
    options: SessionOptions = {},
    private readonly journal?: { readonly active: boolean }
  ) {
    this.features = { ...defaultFeatures(), ...options.features };
    this.valueFromSecond = options.valueFromSecond === true;
    this.carry = options.carry;
    this.trace = options.trace ?? null;
  }

  /** The space of `prior` (of `carry.loaded` when the session carries a run prior), made on first use. */
  space(prior: LoadedPrior): Space {
    const carry = this.carry;
    const p = carry === undefined ? prior : carry.loaded;
    let space = this.spaces.get(p);
    if (space === undefined) {
      space = new Space(p, this.features, this.valueFromSecond, carry, this.trace);
      this.spaces.set(p, space);
      this.first ??= space;
    }
    return space;
  }

  private firstSpace(): Space {
    if (this.first === null) {
      throw new TypeError('session: a space exists once a predictor is made');
    }
    return this.first;
  }

  /** The id table of the first prior the message used. */
  get ids(): Ids {
    return this.firstSpace().ids;
  }

  /** The run-time copy of the first prior the message used. */
  get run(): RunPrior {
    return this.firstSpace().run;
  }

  /** The symbol predictor of a path and alphabet in the space of its prior, made on first use. */
  symbols(
    path: PathKey,
    o: Resolved,
    alphabet: AlphabetKind,
    members?: ArrayLike<number>
  ): SymbolPredictor {
    return this.space(o.prior).symbols(path, o, alphabet, members);
  }

  /** A value's symbols and END at a path, without the value step (key text). */
  text(path: PathKey, o: Resolved, alphabet: AlphabetKind, members?: ArrayLike<number>): TextCoder {
    return this.coder(path, o, alphabet, members, false);
  }

  /** A string value at a path: the value step, then its symbols and END. */
  string(
    path: PathKey,
    o: Resolved,
    alphabet: AlphabetKind,
    members?: ArrayLike<number>
  ): TextCoder {
    return this.coder(path, o, alphabet, members, true);
  }

  private coder(
    path: PathKey,
    o: Resolved,
    alphabet: AlphabetKind,
    members: ArrayLike<number> | undefined,
    withStep: boolean
  ): TextCoder {
    const space = this.space(o.prior);
    const pred = space.symbols(path, o, alphabet, members);
    return new StringCoder(this, space, pred, space.pathState(path, o), withStep);
  }

  /**
   * Refuses to code inside a spelling the encoder tries: the predictor's state does not roll
   * back, so a try it learned from would be learned again by the spelling taken.
   */
  checkCommitted(): void {
    if (this.journal?.active === true) {
      throw new Error('the predictor cannot code inside a spelling the encoder tries');
    }
  }

  /**
   * Opens a record (an object): the numbers coded in it are the sibling references of the numbers
   * after them in it.
   */
  enterRecord(): void {
    this.records.push([]);
    this.openRecords.push(this.recordPairs.length);
    this.recordPairs.push({ steps: [], ids: [] });
    this.openPairs.push(new Map());
  }

  /** Closes the innermost record; its numbers join the enclosing record's. */
  leaveRecord(): void {
    this.openRecords.pop();
    this.openPairs.pop();
    const frame = this.records.pop();
    const outer = this.records[this.records.length - 1];
    if (frame !== undefined && outer !== undefined) {
      for (const e of frame) outer.push(e);
    }
  }

  /** The innermost open record's id, −1 outside every record. */
  get current(): number {
    const n = this.openRecords.length;
    return n === 0 ? -1 : this.openRecords[n - 1];
  }

  agreement(rec: number, ri: number): number {
    const held = this.openPairs[this.openPairs.length - 1];
    const { steps, ids } = this.recordPairs[rec];
    let a = 0;
    for (let i = 0; i < ri; i++) {
      if (held.get(steps[i])?.has(ids[i]) === true) a += steps[i].info(ids[i]);
    }
    return a;
  }

  pair(step: Occurrences, id: number): readonly [number, number] {
    const rec = this.current;
    if (rec < 0) {
      return OUTSIDE;
    }
    const { steps, ids } = this.recordPairs[rec];
    steps.push(step);
    ids.push(id);
    const held = this.openPairs[this.openPairs.length - 1];
    let set = held.get(step);
    if (set === undefined) {
      set = new Set();
      held.set(step, set);
    }
    set.add(id);
    return [rec, steps.length - 1];
  }

  /**
   * An integer at a path through the number predictor: `range` the node's declared bounds and
   * prior, `plain` its own spelling, which NOVELTY falls back on (spec §6.3).
   */
  number(path: PathKey, o: Resolved, range: NumberRange, plain: PlainNumber): NumberAccess {
    const np = this.space(o.prior).number(path, o, range, plain);
    return {
      write: (enc, x) => {
        this.checkCommitted();
        np.coder.write(enc, x, this.frame());
        this.enter(np.state, x);
      },
      read: (dec) => {
        const x = np.coder.read(dec, this.frame());
        this.enter(np.state, x);
        return x;
      },
    };
  }

  private frame(): readonly RecordEntry[] {
    const frame = this.records[this.records.length - 1];
    return frame === undefined ? NO_RECORD : frame;
  }

  /** The innermost record takes a coded number unless it lies past the safe integers. */
  private enter(state: NumberState, value: number): void {
    const frame = this.records[this.records.length - 1];
    if (frame !== undefined && Number.isSafeInteger(value)) frame.push({ state, value });
  }

  /**
   * A declared member 0..count − 1 at a path through the restricted value step, `weights` its
   * prior counts (spec §6.3); a member of weight 0 is refused.
   */
  step(path: PathKey, o: Resolved, count: number, weights?: readonly number[]): MemberAccess {
    const space = this.space(o.prior);
    const mp = space.member(path, o, count, weights);
    const run = space.run;
    const code = (member: (d: Distribution) => number): number => {
      const pop = space.positions(path, o);
      const t0 = pop.t;
      const delta = this.features.deltas ? mp.delta : null;
      const ms = mp.step;
      const d = ms.distribution(pop.seq, t0, this.listIndex, run.vstep, delta, this);
      const v = member(d);
      ms.learn(v, ms.n, run.vstep, delta, run.loaded.constants);
      ms.record(v, t0, this.listIndex, this);
      return v;
    };
    return {
      write: (enc, v) => {
        this.checkCommitted();
        if (!mp.step.has(v)) {
          throw new RangeError(`Member ${v} has zero weight`);
        }
        code((d) => {
          const i = d.indexOf(v);
          enc.composeWeighted(d.cum(i), d.freq(i), d.total);
          return v;
        });
      },
      read: (dec) => code((d) => d.idAt(dec.parseMember(d.total, d))),
    };
  }

  /** Opens a container on the predictor: its children's structure symbols code at `path`. */
  enterScope(path: PathKey, o: Resolved): void {
    this.scopes.push({ path, o });
  }

  /** Opens a container off the predictor: its children code no structure symbols for it. */
  enterPlain(): void {
    this.scopes.push(null);
  }

  leaveScope(): void {
    this.scopes.pop();
  }

  /** Whether a container on the predictor is the innermost open one. */
  inScope(): boolean {
    const top = this.scopes[this.scopes.length - 1];
    return top !== undefined && top !== null;
  }

  /** The structure symbol coded last for `node`, −1 when none waits for it. */
  take(node: object): number {
    if (this.pendingFor !== node) {
      return -1;
    }
    const sym = this.pendingSym;
    this.pendingFor = null;
    this.pendingSym = -1;
    return sym;
  }

  /** Hands `sym`, already coded, to `node`, as a structure symbol coded for it. */
  give(sym: number, node: object): void {
    this.pendingSym = sym;
    this.pendingFor = node;
  }

  /** The structure symbols at the innermost open container, or at `path` outside every one. */
  marker(path: PathKey, o: Resolved): MarkerAccess {
    const top = this.scopes[this.scopes.length - 1];
    const at = top === undefined || top === null ? { path, o } : top;
    const pred = this.symbols(at.path, at.o, 'structure');
    const before = (bound?: Bound, prior?: MarkerPrior): [boolean, number] => {
      if (prior !== undefined) {
        const space = this.space(at.o.prior);
        this.load(space.pathState(at.path, at.o).pop, prior, space);
      }
      return bound === undefined ? [false, END] : [bound.allow, bound.end];
    };
    const after = (sym: number, target: object | undefined, bound: Bound | undefined): void => {
      if (target === undefined || (bound !== undefined && sym === bound.end)) {
        this.pendingFor = null;
        this.pendingSym = -1;
      } else {
        this.give(sym, target);
      }
    };
    return {
      write: (enc, sym, target, bound, prior) => {
        this.checkCommitted();
        const [allow, end] = before(bound, prior);
        pred.code(enc, sym, allow, end);
        after(sym, target, bound);
      },
      read: (dec, target, bound, prior) => {
        const [allow, end] = before(bound, prior);
        const sym = pred.decode(dec, allow, end);
        after(sym, target, bound);
        return sym;
      },
    };
  }

  /** Loads `prior`'s counts into `pop`'s order-0 entry once. */
  private load(pop: Population, prior: MarkerPrior, space: Space): void {
    let keys = this.loaded.get(pop);
    if (keys === undefined) {
      keys = new Set();
      this.loaded.set(pop, keys);
    }
    if (keys.has(prior.key)) {
      return;
    }
    keys.add(prior.key);
    // The declared counts weigh at least what the built-in counts of the same symbols weigh.
    let total = 0;
    let builtin = 0;
    for (const [sym, c] of prior.counts) {
      total += c;
      builtin += space.builtinCount(sym);
    }
    const to = builtin > total ? builtin : total;
    // Every count is at least 1 and `to` at least `total`, so none scales to 0.
    for (const [sym, c] of prior.counts) pop.tab.load(0, sym, div(c * to, total));
  }

  enterList(): void {
    this.lists.push(this.listIndex);
    this.listIndex = -1;
  }

  nextItem(): void {
    this.listIndex++;
  }

  leaveList(): void {
    const prev = this.lists.pop();
    this.listIndex = prev === undefined ? -1 : prev;
  }

  /**
   * The cost of coding a string value at a path (value step, symbols, END) under the quantised
   * tables, in bits · 2^RB; the session learns from it as from a coded value.
   */
  cost(
    path: PathKey,
    o: Resolved,
    alphabet: AlphabetKind,
    syms: ArrayLike<number>,
    ends: Ends
  ): number {
    const sink = new CostSink();
    this.string(path, o, alphabet).write(sink, syms, syms.length, ends);
    return sink.bits;
  }
}

/** The key of a value in the value step: its symbols joined by ','. */
function keyOf(syms: ArrayLike<number>, len: number): string {
  let key = '';
  for (let i = 0; i < len; i++) {
    key += i === 0 ? `${syms[i]}` : `,${syms[i]}`;
  }
  return key;
}

/** The step of a value's units END comes after: 1 unless the ends say otherwise. */
const stepOf = (ends: Ends): number => ends.step ?? 1;

/** Whether a value of `ends` may end after `units` of them. */
const endable = (ends: Ends, units: number): boolean =>
  !ends.fixed && units >= ends.min && units % stepOf(ends) === 0;

/** The coder of one value at a path: `text()` (no value step) and `string()`. */
class StringCoder implements TextCoder {
  constructor(
    private readonly s: Session,
    private readonly space: Space,
    private readonly pred: SymbolPredictor,
    private readonly ps: PathState,
    private readonly withStep: boolean
  ) {}

  private idOf(sym: number): number {
    const alphabet = this.pred.alphabet;
    const ids = this.space.ids;
    return alphabet === 'text' ? ids.idOf(sym) : alphabet === 'bytes' ? ids.byteId(sym) : sym;
  }

  private symOf(id: number): number {
    return this.pred.alphabet === 'structure' ? id : this.space.ids.cpOf(id);
  }

  /** The units of a symbol: the UTF-16 code units of a code point, 1 for anything else. */
  private unitsOf(sym: number): number {
    return this.pred.alphabet === 'text' && sym > 0xffff ? 2 : 1;
  }

  private stepOn(): boolean {
    return this.withStep && this.s.features.valueStep;
  }

  /** The units of the value's first `len` symbols, refused unless the ends hold them. */
  private check(syms: ArrayLike<number>, len: number, ends: Ends): void {
    let units = 0;
    for (let k = 0; k < len; k++) {
      units += this.unitsOf(syms[k]);
    }
    const max = ends.max === undefined ? Infinity : ends.max;
    if (
      units < ends.min ||
      units > max ||
      (ends.fixed && units !== max) ||
      units % stepOf(ends) !== 0
    ) {
      throw new RangeError(`a value of ${units} units does not fit its length bounds`);
    }
  }

  /** The symbols of a value both sides know: every step learns, nothing is coded. */
  private replay(syms: ArrayLike<number>, ends: Ends): void {
    const pred = this.pred;
    let units = 0;
    for (let k = 0; k < syms.length; k++) {
      pred.implied(this.idOf(syms[k]), endable(ends, units));
      units += this.unitsOf(syms[k]);
    }
    if (!ends.fixed && units !== ends.max) {
      pred.implied(END);
    }
  }

  /** The value step's learning and record, after the value's symbols. */
  private finish(
    syms: ArrayLike<number>,
    stepped: boolean,
    choice: number,
    t0: number,
    n0: number
  ): void {
    const ps = this.ps;
    const run = this.space.run;
    const values = ps.values;
    const key = keyOf(syms, syms.length);
    if (stepped) {
      const delta = this.s.features.deltas ? ps.vsDelta : null;
      values.learn(
        choice === ESCAPE ? values.idOf(key) : choice,
        n0,
        run.vstep,
        delta,
        run.loaded.constants
      );
    }
    const id = values.record(key, t0, this.s.listIndex, this.s);
    if (id === ps.valueSyms.length) {
      ps.valueSyms.push(Int32Array.from(syms));
    }
  }

  write(enc: Sink, syms: ArrayLike<number>, len: number, ends: Ends): void {
    this.s.checkCommitted();
    this.check(syms, len, ends);
    const pred = this.pred;
    const ps = this.ps;
    pred.beginValue();
    let implied = false;
    let stepped = false;
    let choice = ESCAPE;
    let t0 = 0;
    const n0 = ps.n;
    const value = Int32Array.from({ length: len }, (_, i) => syms[i]);
    if (this.stepOn()) {
      const ctx = pred.context();
      t0 = ctx.t;
      const run = this.space.run;
      const delta = this.s.features.deltas ? ps.vsDelta : null;
      const d = ps.values.distribution(ctx.seq, t0, this.s.listIndex, run.vstep, delta, this.s);
      if (d !== null) {
        choice = ps.values.idOf(keyOf(value, len));
        let i = choice === ESCAPE ? -1 : d.indexOf(choice);
        implied = i >= 0;
        if (!implied) {
          i = d.n - 1;
        }
        enc.composeWeighted(d.cum(i), d.freq(i), d.total);
        stepped = true;
      }
    }
    if (implied) {
      this.replay(value, ends);
    } else {
      let units = 0;
      for (let k = 0; k < len; k++) {
        pred.distribution(endable(ends, units));
        const a = this.idOf(value[k]);
        pred.write(enc, a);
        pred.learn(a);
        units += this.unitsOf(value[k]);
      }
      if (!ends.fixed && units !== ends.max) {
        pred.code(enc, END);
      }
    }
    if (this.stepOn()) {
      this.finish(value, stepped, implied ? choice : ESCAPE, t0, n0);
    }
    pred.endValue();
  }

  read(dec: Source, ends: Ends): Int32Array {
    const pred = this.pred;
    const ps = this.ps;
    pred.beginValue();
    let stepped = false;
    let choice = ESCAPE;
    let t0 = 0;
    const n0 = ps.n;
    if (this.stepOn()) {
      const ctx = pred.context();
      t0 = ctx.t;
      const run = this.space.run;
      const delta = this.s.features.deltas ? ps.vsDelta : null;
      const d = ps.values.distribution(ctx.seq, t0, this.s.listIndex, run.vstep, delta, this.s);
      if (d !== null) {
        choice = d.idAt(dec.parseMember(d.total, d));
        stepped = true;
      }
    }
    let out: Int32Array;
    if (choice !== ESCAPE) {
      out = ps.valueSyms[choice].slice();
      this.replay(out, ends);
    } else {
      const buf: number[] = [];
      const max = ends.max === undefined ? Infinity : ends.max;
      let units = 0;
      while (units < max) {
        const a = pred.decode(dec, endable(ends, units));
        if (a === END) {
          break;
        }
        const sym = this.symOf(a);
        buf.push(sym);
        units += this.unitsOf(sym);
      }
      // A code point of two units read one unit before the max; no value encodes that way.
      if (units > max) {
        throw new CorruptInputError(`a value of ${units} units overruns its max ${max}`);
      }
      out = Int32Array.from(buf);
    }
    if (this.stepOn()) {
      this.finish(out, stepped, choice, t0, n0);
    }
    pred.endValue();
    return out;
  }
}

const NO_RECORD: readonly RecordEntry[] = [];

/** The record pair of a value coded outside every record. */
const OUTSIDE: readonly [number, number] = [-1, 0];

const SESSION = {};

/** The session of the message a side codes, made on first use. */
export function session(side: Side, options?: SessionOptions): Session {
  return side.state(SESSION, () => new Session(options, side.journal));
}
