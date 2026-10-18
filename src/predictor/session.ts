/**
 * The predictor state of one message (spec §4.3, §4.6): the id table, the message populations of
 * each alphabet, the run-time copy of the prior, the paths' state and the list scope, with the
 * string coders that drive the symbol predictor and the value step (spec §4.5, §6.5).
 *
 * Phase 1 binds a session to the prior of its first predictor: the id table is seeded from it, and
 * a predictor with another prior is a TypeError. The message population of an alphabet and the
 * state of a path are built with the options of the first predictor that uses them.
 *
 * The coders take and return the alphabet's own symbols (code points for text, byte values for
 * bytes, structure ids for structure), never code-point ids: an id is assigned on first
 * reference, and both sides must reference a new code point at the same moment, after the
 * step's table, which only the coder can arrange.
 */

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

export class Session implements MessageCore {
  readonly features: Features;
  readonly valueFromSecond: boolean;
  seen = new Uint8Array(512);
  distinct = 0;
  b = 0;
  n = 0;
  valueId = -1;
  valuePop: Population | null = null;
  valuesStarted = false;
  /** The current item's index in the innermost list, −1 outside a list. */
  listIndex = -1;
  private readonly lists: number[] = [];
  private idTable: Ids | null = null;
  private prior: LoadedPrior | null = null;
  private runPrior: RunPrior | null = null;
  private builtin: Frozen | null = null;
  private readonly pairs = new Map<string, Pair>();
  private readonly paths = new Map<unknown, PathState>();
  private readonly derived = new Map<object, Map<number, PathState>>();
  private readonly preds = new Map<PathState, Map<AlphabetKind, SymbolPredictor>>();

  constructor(options: SessionOptions = {}) {
    this.features = { ...defaultFeatures(), ...options.features };
    this.valueFromSecond = options.valueFromSecond === true;
  }

  /** The message's id table, seeded from the prior of the first predictor. */
  get ids(): Ids {
    if (this.idTable === null) {
      throw new TypeError('session: the id table exists once a predictor is made');
    }
    return this.idTable;
  }

  /** The run-time copy of the session's prior. */
  get run(): RunPrior {
    if (this.runPrior === null) {
      throw new TypeError('session: the prior is bound by the first predictor');
    }
    return this.runPrior;
  }

  private bind(prior: LoadedPrior): RunPrior {
    if (this.runPrior === null) {
      this.prior = prior;
      this.idTable = new Ids(prior);
      this.runPrior = newRunPrior(prior);
      this.builtin = frozen(prior, this.idTable);
      return this.runPrior;
    }
    if (prior !== this.prior) {
      throw new TypeError('session: every predictor of a message uses one prior (phase 1)');
    }
    return this.runPrior;
  }

  private pathState(key: PathKey, o: Resolved): PathState {
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

  /** The symbol predictor of a path and alphabet, made on first use. */
  symbols(path: PathKey, o: Resolved, alphabet: AlphabetKind): SymbolPredictor {
    const run = this.bind(o.prior);
    const ps = this.pathState(path, o);
    let byAlphabet = this.preds.get(ps);
    if (byAlphabet === undefined) {
      byAlphabet = new Map();
      this.preds.set(ps, byAlphabet);
    }
    let pred = byAlphabet.get(alphabet);
    if (pred === undefined) {
      const p = o.separate ? null : this.pair(alphabet, o);
      pred = new SymbolPredictor(
        this,
        ps,
        o,
        alphabet,
        run,
        alphabet === 'bytes' ? null : this.builtin,
        p === null ? null : p.msg,
        p === null ? null : p.msgF
      );
      byAlphabet.set(alphabet, pred);
    }
    return pred;
  }

  /** A value's symbols and END at a path, without the value step (key text). */
  text(path: PathKey, o: Resolved, alphabet: AlphabetKind): TextCoder {
    const pred = this.symbols(path, o, alphabet);
    return new StringCoder(this, pred, this.pathState(path, o), false);
  }

  /** A string value at a path: the value step, then its symbols and END. */
  string(path: PathKey, o: Resolved, alphabet: AlphabetKind): TextCoder {
    const pred = this.symbols(path, o, alphabet);
    return new StringCoder(this, pred, this.pathState(path, o), true);
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

function checkEnds(len: number, ends: Ends): void {
  const max = ends.max === undefined ? Infinity : ends.max;
  if (len < ends.min || len > max || (ends.fixed && len !== max)) {
    throw new RangeError(`a value of ${len} symbols does not fit its length bounds`);
  }
}

/** The coder of one value at a path: `text()` (no value step) and `string()`. */
class StringCoder implements TextCoder {
  constructor(
    private readonly s: Session,
    private readonly pred: SymbolPredictor,
    private readonly ps: PathState,
    private readonly withStep: boolean
  ) {}

  private idOf(sym: number): number {
    const alphabet = this.pred.alphabet;
    const ids = this.s.ids;
    return alphabet === 'text' ? ids.idOf(sym) : alphabet === 'bytes' ? ids.byteId(sym) : sym;
  }

  private symOf(id: number): number {
    return this.pred.alphabet === 'structure' ? id : this.s.ids.cpOf(id);
  }

  private stepOn(): boolean {
    return this.withStep && this.s.features.valueStep;
  }

  /** The symbols of a value both sides know: every step learns, nothing is coded. */
  private replay(syms: ArrayLike<number>, ends: Ends): void {
    const pred = this.pred;
    for (let k = 0; k < syms.length; k++) {
      pred.implied(this.idOf(syms[k]), !ends.fixed && k >= ends.min);
    }
    if (!ends.fixed && syms.length !== ends.max) {
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
    const run = this.s.run;
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
    checkEnds(len, ends);
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
      const run = this.s.run;
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
      for (let k = 0; k < len; k++) {
        pred.distribution(!ends.fixed && k >= ends.min);
        const a = this.idOf(value[k]);
        pred.write(enc, a);
        pred.learn(a);
      }
      if (!ends.fixed && len !== ends.max) {
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
      const run = this.s.run;
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
      while (buf.length < max) {
        const a = pred.decode(dec, !ends.fixed && buf.length >= ends.min);
        if (a === END) {
          break;
        }
        buf.push(this.symOf(a));
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
  return side.state(SESSION, () => new Session(options));
}
