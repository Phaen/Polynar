import { Encoder, Decoder } from '../packer';
import { resolve } from '../predictor/options';
import { Priors } from '../predictor/prior';
import { session, type MarkerPrior } from '../predictor/session';
import { STRUCT, type AdaptiveOptions, type Resolved } from '../predictor/types';
import { PNode, adapt } from './base';
import type { Kind } from './guards';
import type { LearningOptions } from './adaptive';
import { checkUnset } from './lattice';
import { markerPrior, ownMarker, readOwnMarker } from './markers';
import { members, type MemberPrior, type Members } from './members';
import { MethodNode, learningOf, type MethodSet } from './methods';

const NULL_MARKERS: ReadonlySet<number> = new Set([STRUCT.NULL]);

/**
 * A value or `null`. `p.nullable`. Writes the same bits as
 * `p.union([node, p.null()])`, but tells `null` apart by value instead of by
 * kind, so the inner node needs no kinds and can be `p.lazy`.
 */
export class PNullable<T> extends MethodNode<T | null> {
  /**
   * The inner node's kinds plus `'null'`, or undeclared when the inner node's
   * are, so a nullable node is a union member whenever its inner node is.
   */
  declare readonly _kinds?: readonly Kind[];

  /** The prior as declared, `[value, null]`, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  /** Member 0 is a value, member 1 null. */
  private readonly _members: Members;
  readonly _adaptive?: AdaptiveOptions;
  /** Under `.adaptive()`: the options the null symbol codes under. */
  private readonly _resolved?: Resolved;

  constructor(
    readonly inner: PNode<T>,
    prior?: MemberPrior,
    readonly _methods: MethodSet = {}
  ) {
    super();
    if (inner._kinds !== undefined) {
      this._kinds = [...new Set<Kind>([...inner._kinds, 'null'])];
    }
    this._prior = prior;
    this._members = members(2, { ...prior, learn: learningOf(_methods) }, 'p.nullable');
    this._adaptive = _methods.adaptive;
    if (this._adaptive !== undefined) {
      this._resolved = resolve(this._adaptive, Priors.json, 'p.nullable');
    }
  }

  _takesUndefined(): boolean {
    return this.inner._takesUndefined();
  }

  get _holdsAdaptive(): boolean {
    return this._adaptive !== undefined || this.inner._holdsAdaptive;
  }

  /**
   * Declare how likely each side is, as `[value, null]`. A prior, not a
   * constraint, and part of the wire format.
   */
  weights(w: readonly [number, number]): PNullable<T> {
    checkUnset(this._prior?.weights, 'p.nullable', 'weights');
    return new PNullable<T>(this.inner, { ...this._prior, weights: w }, this._methods);
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are where it starts, and each side coded counts as one
   * observation, so a side that keeps recurring gets cheaper as the message
   * goes on. From its second value on, the node spends one bit to stay static,
   * or a few to name the learning rate that paid off. `window` is how many
   * observations the counts hold before they halve, so the newest weigh most
   * (1024 when left out, and raised to the number of values counted when
   * smaller), and `separate` keeps it from starting where other nodes of its
   * kind and window got to. Part of the wire format, like the weights. Not
   * with `.adaptive()`.
   */
  learn(options?: LearningOptions): PNullable<T> {
    return this._declare('learn', 'p.nullable', options);
  }

  /**
   * Code whether the value is null through the similarity predictor, as the
   * null symbol against the value's own first symbol in the structure around
   * it, with the weights as their prior counts, and the inner node as under
   * its own `.adaptive(options)` unless it has `.adaptive()` or `.learn()`
   * already. Not with `.learn()`. Set once.
   */
  adaptive(options?: AdaptiveOptions): PNullable<T> {
    return this._sugar(options, 'p.nullable');
  }

  _adapted(options: AdaptiveOptions, memo: Map<PNode<any>, PNode<any>>): PNullable<T> {
    if (this._keeps()) {
      return this;
    }
    const inner = adapt(this.inner, options, memo);
    return new PNullable<T>(inner, this._prior, { ...this._methods, adaptive: options });
  }

  _withMethods(methods: MethodSet): PNullable<T> {
    return new PNullable<T>(this.inner, this._prior, methods);
  }

  _marker(value: unknown): number {
    return value === null ? STRUCT.NULL : this.inner._marker(value);
  }

  _markers(): ReadonlySet<number> | undefined {
    const inner = this.inner._markers();
    return inner === undefined ? undefined : new Set([STRUCT.NULL, ...inner]);
  }

  _markerPrior(): MarkerPrior | undefined {
    return this._adaptive === undefined
      ? undefined
      : markerPrior(this, this._prior?.weights, [this.inner._markers(), NULL_MARKERS]);
  }

  /** Whether the inner node may spell NULL first too, so a NULL names its side. */
  private _shared(): boolean {
    return this.inner._markers()?.has(STRUCT.NULL) !== false;
  }

  _write(enc: Encoder, value: T | null): void {
    const o = this._resolved;
    if (o === undefined) {
      this._members.write(enc, value === null ? 1 : 0);
      if (value !== null) {
        this.inner._write(enc, value);
      }
      return;
    }
    const sym = ownMarker(enc, this, o, this._marker(value));
    if (sym === STRUCT.NULL && this._shared()) {
      this._side(enc).write(enc, value === null ? 1 : 0);
    }
    if (value !== null) {
      session(enc).give(sym, this.inner);
      this.inner._write(enc, value);
    }
  }

  _read(dec: Decoder): T | null {
    const o = this._resolved;
    if (o === undefined) {
      if (this._members.read(dec) === 1) {
        return null;
      }
      return this.inner._read(dec);
    }
    const sym = readOwnMarker(dec, this, o);
    if (sym === STRUCT.NULL && (!this._shared() || this._side(dec).read(dec) === 1)) {
      return null;
    }
    session(dec).give(sym, this.inner);
    return this.inner._read(dec);
  }

  /** The step naming the side of a NULL the inner node may spell too. */
  private _side(side: Encoder | Decoder) {
    return session(side).step(this, this._resolved as Resolved, 2, this._prior?.weights);
  }
}
