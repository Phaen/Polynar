/**
 * Methods: the rules a node spells one value by, given what the same node
 * already wrote in the message (nothing, the previous value, the distinct
 * values so far), and what it learns from them. A declared method runs on
 * every value; under `.adaptive()` a learned mode picks, value by value,
 * among the methods the user left open. Which method a value takes is the
 * encoder's choice alone: it tries each spelling, keeps the cheapest, and
 * the decoder reads the mode back without checking it.
 *
 * A method that is on learns on its own: it builds the tables it reads,
 * and those learn from every value of the node, under the node's learning
 * options. `learn` is the node's own priors learning, what its weights,
 * model or charset set, or its defaults.
 *
 * A method only codes. What a node knows of its values (its previous
 * value, a difference scale, the learned odds of its range) lives in value
 * providers, which methods code through without teaching them: once a
 * value is coded, the node teaches it to every provider of its method set,
 * in their order, whichever method spelled it or recalled it.
 */

import type { Encoder, Decoder } from '../packer';
import {
  AdaptivePrior,
  checkAdaptation,
  lineageOf,
  type Learning,
  type LearningOptions,
} from './adaptive';
import { PNode } from './base';
import { Exclusion } from './excluded';
import { Recall } from './recall';

/**
 * How a node has a method: declared, so it spells every value it can, or
 * open, as `.adaptive()` leaves each method the node does not declare,
 * offered to the node's per-value choice where it has one.
 */
export type MethodFlag = 'declared' | 'open';

/**
 * The methods a node has, carried through every rebuild so a later
 * `.min()`, `.weights()` or `.adaptive()` keeps them; a method left out is
 * off. Each is declared once.
 */
export interface MethodSet {
  /** The node's own priors learn from the message: those its weights, model or charset set, or its defaults. */
  readonly learn?: MethodFlag;
  /** Each item priced by the items before it, over learned odds of the items alone (`./contexts`). */
  readonly contexts?: MethodFlag;
  /** A run of letters the message already spelled as one token of its vocabulary (`./words`). */
  readonly words?: MethodFlag;
  /** An item spelled with a tail a symbol of its own once the message has it (`./grown`). */
  readonly codepoints?: MethodFlag;
  /** Each value after the first as its difference from the node's previous one. */
  readonly delta?: MethodFlag;
  /** Each value as its place among the distinct values the node already wrote, or as new. */
  readonly recall?: MethodFlag;
  /** Stretches the node already wrote in the message copied instead of spelled again. */
  readonly repeats?: MethodFlag;
  /** Each run of digits as an integer of its width, the text around the runs a frame (`./fields`). */
  readonly digits?: MethodFlag;
  /** A value of a length the node met before by the items seen at each of its places (`./fields`). */
  readonly positional?: MethodFlag;
  /** No length prefix: the end of the value is one more symbol after its items. */
  readonly terminated?: MethodFlag;
  /** What the tables of the node's methods learn under, as `.learning()` sets it. */
  readonly learning?: Learning;
}

/** The name of a method a node may have. */
export type MethodName = Exclude<keyof MethodSet, 'learning'>;

/** The methods of a node whose one method is its prior learning, which `.adaptive()` opens. */
export const PRIOR_METHODS: readonly MethodName[] = ['learn'];

/** The methods of an array, a collection or an object, which `.adaptive()` opens. */
export const CONTAINER_METHODS: readonly MethodName[] = ['learn', 'recall'];

/** A node with methods: `.adaptive()` opens those it does not declare, and each declaration adds one. */
export abstract class MethodNode<TOut> extends PNode<TOut> {
  /** The methods the node has, declared or open. */
  abstract readonly _methods: MethodSet;
  /** The node's own methods, which `.adaptive()` opens. */
  abstract readonly _methodNames: readonly MethodName[];
  /** The node with `methods` in place of its own. */
  abstract _withMethods(methods: MethodSet): MethodNode<TOut>;

  /**
   * The node with each of its methods not named in `except` open unless
   * declared, learning under `learning` in place of its own options where
   * given.
   */
  _open(learning?: Learning, except: readonly MethodName[] = []): this {
    const names = this._methodNames.filter((name) => !except.includes(name));
    return this._withMethods(opened(this._methods, names, learning)) as this;
  }

  /** The node with `method` declared; `who` names it in the error a second declaration throws. */
  protected _declare(method: MethodName, who: string): this {
    return this._withMethods(withMethod(this._methods, method, who)) as this;
  }

  /** The node learning under `options`, set once; `who` names it in the error a second setting throws. */
  protected _learning(options: LearningOptions, who: string): this {
    if (this._methods.learning !== undefined) {
      throw new TypeError(`${who} learning is already set`);
    }
    checkAdaptation(options, who);
    return this._withMethods({ ...this._methods, learning: { ...options } }) as this;
  }

  /** `.adaptive(options)`: the node learning under `options` where given, its methods open. */
  protected _adapt(options: LearningOptions | undefined, who: string): this {
    return (options === undefined ? this : this._learning(options, who))._open();
  }
}

/** `methods` with `method` declared; `who` names the node in the error a second declaration throws. */
export function withMethod<S extends MethodSet>(methods: S, method: MethodName, who: string): S {
  if (methods[method] === 'declared') {
    throw new TypeError(`${who} ${method} is already set`);
  }
  return { ...methods, [method]: 'declared' };
}

/**
 * `methods` as `.adaptive()` leaves them: each of `names`, the node's own
 * methods, open unless declared, learning under `learning` where given.
 */
export function opened<S extends MethodSet>(
  methods: S,
  names: readonly MethodName[],
  learning?: Learning
): S {
  const open: { [M in MethodName]?: MethodFlag } = {};
  for (const name of names) {
    open[name] = methods[name] ?? 'open';
  }
  return { ...methods, ...open, learning: learning ?? methods.learning };
}

/** Whether the node's own priors learn. */
export function learns(methods: MethodSet): boolean {
  return methods.learn !== undefined;
}

/**
 * Whether the odds of the node's items learn: under `learn`, and for the
 * contexts and the grown alphabet, which build on them.
 */
export function itemsLearn(methods: MethodSet): boolean {
  return learns(methods) || methods.contexts !== undefined || methods.codepoints !== undefined;
}

/** What the tables of the node's methods learn under: the defaults unless set. */
export function optionsOf(methods: MethodSet): Learning {
  return methods.learning ?? {};
}

/** What the node's own priors learn under: none unless they learn. */
export function learningOf(methods: MethodSet): Learning | undefined {
  return learns(methods) ? optionsOf(methods) : undefined;
}

/** Whether the node has no method at all, declared or open. */
export function bare(methods: MethodSet): boolean {
  return Object.keys(methods).every((key) => key === 'learning');
}

/** Whether the node declares any of `names`. */
export function declaresAny(methods: MethodSet, names: readonly MethodName[]): boolean {
  return names.some((name) => methods[name] === 'declared');
}

/**
 * Whether the node picks, value by value, between its plain spelling and
 * `names`: one of them open and none declared, which would pin the spelling.
 */
export function chooses(methods: MethodSet, names: readonly MethodName[]): boolean {
  return !declaresAny(methods, names) && names.some((name) => methods[name] === 'open');
}

/**
 * The recall of a node, which learns: declared, pinned; open, one of the
 * node's methods; none otherwise. `copy` is the recall's.
 */
export function recallOf<T>(methods: MethodSet, copy?: (value: T) => T): Recall<T> | undefined {
  if (methods.recall === undefined) {
    return undefined;
  }
  return new Recall<T>({ open: methods.recall === 'open', copy });
}

/**
 * Learned knowledge of a node's values: a scale, learned odds, the node's
 * previous value. Methods code through providers without teaching them;
 * once a value is coded, the node teaches it to every provider of its
 * method set, in their order, whichever method coded it. A provider that
 * codes several symbols within one value, as the contexts and digit fields
 * do, learns each as it codes it, so the value's later symbols are priced
 * after its earlier ones; its `learn` then absorbs only a value another
 * method coded.
 */
export interface ValueProvider<T> {
  /** Learns `value`, just coded by any of the node's methods. */
  learn(side: Encoder | Decoder, value: T): void;
}

/** One way of spelling a node's value, which learns nothing. */
export interface Method<T> {
  /**
   * Whether the method can take the node's next value, from what both sides
   * know before it: a difference needs a previous value. A method that is
   * not available is left out of the mode.
   */
  available(side: Encoder | Decoder): boolean;
  /** Spells `value`, throwing when it cannot. Called only when available. */
  write(enc: Encoder, value: T): void;
  /** Reads a value `write` spelled. Called only when available. */
  read(dec: Decoder): T;
}

/** The node's previous value in the message on each side: none before its first. */
export class Previous<T> implements ValueProvider<T> {
  /** The previous value on `side`. */
  get(side: Encoder | Decoder): T | undefined {
    return side.state<{ value?: T }>(this, () => ({})).value;
  }

  learn(side: Encoder | Decoder, value: T): void {
    this.swap(side, value);
  }

  /** Learns `value` on `side`, and returns the previous value it replaces. */
  swap(side: Encoder | Decoder, value: T): T | undefined {
    const state = side.state<{ value?: T }>(this, () => ({}));
    const before = state.value;
    state.value = value;
    if (side.journal?.active === true) {
      side.journal.call(() => {
        state.value = before;
      });
    }
    return before;
  }
}

/** A set of a node's available methods: their indices, in order, and the others ruled out. */
interface Available {
  readonly open: readonly number[];
  readonly exclusion: Exclusion;
}

/**
 * The per-value mode among a node's methods: each value is spelled by one
 * of them, named by a mode symbol over the methods available for it. The
 * symbol is written only when at least two are available, so a node's
 * first value, when only plain applies, costs its plain spelling and
 * nothing more. The modes start even, under an adaptive prior with the
 * methods not available ruled out, which learns each mode written.
 *
 * The encoder decides among the available methods by trying each, the
 * mode symbol and the method's spelling written as a real write would,
 * and keeps the cheapest, a tie going to the lower index, so method 0, the
 * plain spelling, wins every tie.
 */
export class ModeChoice<T> {
  /** The learned mode table. */
  private readonly prior: AdaptivePrior;
  /** Each set of available methods, by the bit of each, built on first use. */
  private readonly sets: (Available | undefined)[] = [];
  /** The method the encoder last picked, which only orders its next tries. */
  private last = 0;

  constructor(
    readonly methods: readonly Method<T>[],
    learning: Learning,
    readonly who: string
  ) {
    if (methods.length === 0) {
      throw new TypeError(`${who} needs at least one method`);
    }
    const { window } = checkAdaptation(learning, who);
    const n = methods.length;
    this.prior = new AdaptivePrior(
      [new Array<number>(n).fill(1)],
      n,
      window,
      who,
      lineageOf(learning)
    );
  }

  /** The methods available for the next value on `side`. */
  private available(side: Encoder | Decoder): Available {
    const { methods } = this;
    let bits = 0;
    for (let i = 0; i < methods.length; i++) {
      if (methods[i].available(side)) {
        bits |= 1 << i;
      }
    }
    if (bits === 0) {
      throw new RangeError(`${this.who} has no method available for the value`);
    }
    return (this.sets[bits] ??= this.set(bits));
  }

  /** The set of the methods whose bits `bits` holds. */
  private set(bits: number): Available {
    const open: number[] = [];
    const exclusion = new Exclusion(this.methods.length);
    for (let i = 0; i < this.methods.length; i++) {
      if ((bits & (1 << i)) === 0) {
        exclusion.add(i);
      } else {
        open.push(i);
      }
    }
    return { open, exclusion };
  }

  /** Spells `value` by the method the encoder picks. */
  write(enc: Encoder, value: T): void {
    const { open, exclusion } = this.available(enc);
    if (open.length === 1) {
      this.methods[open[0]].write(enc, value);
      return;
    }
    // The method that won last is tried first, so the others' tries run
    // under its cost and stop as soon as they pass it.
    const order = open.includes(this.last)
      ? [this.last, ...open.filter((i) => i !== this.last)]
      : open;
    const mode = enc.decide(open, order, (i) => {
      this.prior.write(enc, i, 0, exclusion);
      this.methods[i].write(enc, value);
    });
    this.last = mode;
    this.prior.learn(enc, mode);
  }

  /** Reads a value `write` spelled. */
  read(dec: Decoder): T {
    const { open, exclusion } = this.available(dec);
    if (open.length === 1) {
      return this.methods[open[0]].read(dec);
    }
    // An excluded mode owns no states, so the mode read is always one of
    // the available methods.
    const mode = this.prior.read(dec, 0, exclusion);
    const value = this.methods[mode].read(dec);
    this.prior.learn(dec, mode);
    return value;
  }
}
