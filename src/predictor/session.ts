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

import { CorruptInputError } from '../packer/errors';
import { log2Fix } from './arith';
import { Ids } from './alphabet';
import { SymbolPredictor, defaultFeatures, newPathState } from './symbols';
import type { Features, MessageCore, PathState, Sink, Source } from './symbols';
import { Population, frozen } from './tables';
import type { Frozen } from './tables';
import { END, ESCAPE } from './types';
import type { AlphabetKind, Ends, LoadedPrior, PathKey, Resolved, RunPrior } from './types';
import { newRunPrior } from './weights';

export type { Features, Sink, Source, Table } from './symbols';

export interface SessionOptions {
  /** Switches of the engine's parts, for measurement; every part is on by default. */
  readonly features?: Partial<Features>;
  /** D2's fallback: the value population exists only from the message's second value on. */
  readonly valueFromSecond?: boolean;
}

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
  private readonly paths = new Map<unknown, PathState>();
  private readonly derived = new Map<object, Map<number, PathState>>();
  private readonly preds = new Map<PathState, Map<AlphabetKind, SymbolPredictor>>();

  constructor(
    prior: LoadedPrior,
    readonly features: Features,
    readonly valueFromSecond: boolean
  ) {
    this.ids = new Ids(prior);
    this.run = newRunPrior(prior);
    this.builtin = frozen(prior, this.ids);
  }

  pathState(key: PathKey, o: Resolved): PathState {
    let map: Map<unknown, PathState> = this.paths;
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
    let ps = map.get(k);
    if (ps === undefined) {
      ps = newPathState(o, this.features);
      map.set(k, ps);
    }
    return ps;
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

export class Session {
  readonly features: Features;
  readonly valueFromSecond: boolean;
  /** The current item's index in the innermost list, −1 outside a list. */
  listIndex = -1;
  private readonly lists: number[] = [];
  private readonly spaces = new Map<LoadedPrior, Space>();
  private first: Space | null = null;

  constructor(
    options: SessionOptions = {},
    private readonly journal?: { readonly active: boolean }
  ) {
    this.features = { ...defaultFeatures(), ...options.features };
    this.valueFromSecond = options.valueFromSecond === true;
  }

  /** The space of `prior`, made on first use. */
  space(prior: LoadedPrior): Space {
    let space = this.spaces.get(prior);
    if (space === undefined) {
      space = new Space(prior, this.features, this.valueFromSecond);
      this.spaces.set(prior, space);
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
    const id = values.record(key, t0, this.s.listIndex);
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
      const d = ps.values.distribution(ctx.seq, t0, this.s.listIndex, run.vstep, delta);
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
      const d = ps.values.distribution(ctx.seq, t0, this.s.listIndex, run.vstep, delta);
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

const SESSION = {};

/** The session of the message a side codes, made on first use. */
export function session(side: Side, options?: SessionOptions): Session {
  return side.state(SESSION, () => new Session(options, side.journal));
}
