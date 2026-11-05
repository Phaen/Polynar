import { Encoder, Decoder } from '../packer';
import { resolve } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import { session, type MarkerPrior } from '../predictor/session';
import type { CompressOptions, Resolved } from '../predictor/types';
import { PNode, adapt } from './base';
import { kindOf, type Kind } from './guards';
import { describe, oneOf } from './path';
import type { AdaptOptions } from './adaptive';
import { checkUnset } from './lattice';
import { members, type MemberPrior, type Members } from './members';
import { kindMarker, markerPrior, ownMarker, readOwnMarker, unionOf } from './markers';
import { MethodNode, learningOf, type MethodSet } from './methods';

/**
 * Union: one of several member nodes, picked by the value's JS kind
 * (`typeof`, with null, arrays and dates told apart). `p.union`.
 *
 * Each kind belongs to one member, so the encoder never guesses and every
 * value has exactly one encoding. Two array or two object members are
 * therefore rejected; object shapes go in `p.tagged`.
 */
export class PUnion<T> extends MethodNode<T> {
  readonly _kinds: readonly Kind[];
  private readonly _members: readonly PNode<any>[];
  private readonly _byKind = new Map<Kind, number>();
  /** The prior as declared, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  /** How the member a value goes to is spelled. */
  private readonly _pick: Members;
  readonly _compress?: CompressOptions;
  /** Under `.compress()`: the options the member's symbol codes under. */
  private readonly _resolved?: Resolved;

  constructor(
    nodes: readonly PNode<any>[],
    prior?: MemberPrior,
    readonly _methods: MethodSet = {}
  ) {
    super();
    if (nodes.length === 0) {
      throw new TypeError('p.union requires at least one member');
    }
    this._members = [...nodes]; // copy so later caller mutation can't change the node
    this._members.forEach((member, i) => {
      if (member._kinds === undefined) {
        throw new TypeError(
          'p.union members must declare their kinds; p.lazy and custom nodes without _kinds cannot be members'
        );
      }
      for (const kind of member._kinds) {
        if (this._byKind.has(kind)) {
          throw new TypeError(
            `p.union members overlap on kind ${describe(kind)}; only one member per kind`
          );
        }
        this._byKind.set(kind, i);
      }
    });
    this._kinds = [...this._byKind.keys()];
    this._prior = prior;
    this._pick = members(
      this._members.length,
      { ...prior, adapt: learningOf(_methods) },
      'p.union'
    );
    this._compress = _methods.compress;
    if (this._compress !== undefined) {
      this._resolved = resolve(this._compress, loadedPriors.json, 'p.union');
    }
  }

  /**
   * Declare how likely each member is, in list order. A prior, not a
   * constraint: rare members still encode, just dearer. The weights are part
   * of the wire format.
   */
  weights(w: readonly number[]): PUnion<T> {
    checkUnset(this._prior?.weights, 'p.union', 'weights');
    return new PUnion<T>(this._members, { ...this._prior, weights: w }, this._methods);
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are where it starts, and each member coded counts as one
   * observation, so a member that keeps recurring gets cheaper as the message
   * goes on. From its second value on, the node spends one bit to stay static,
   * or a few to name the learning rate that paid off. `window` is how many
   * observations the counts hold before they halve, so the newest weigh most
   * (1024 when left out, and raised to the number of values counted when
   * smaller), and `separate` keeps it from starting where other nodes of its
   * kind and window got to. Part of the wire format, like the weights. Not
   * with `.compress()`.
   */
  adapt(options?: AdaptOptions): PUnion<T> {
    return this._declare('adapt', 'p.union', options);
  }

  /**
   * Code which member takes the value through the similarity predictor, as
   * the value's first symbol in the structure around it (its kind), with the
   * weights as prior counts, and each member as under its own
   * `.compress(options)` unless it has `.compress()` or `.adapt()` already.
   * Not with `.adapt()`. Set once.
   */
  compress(options?: CompressOptions): PUnion<T> {
    return this._sugar(options, 'p.union');
  }

  _adapted(options: CompressOptions, memo: Map<PNode<any>, PNode<any>>): PUnion<T> {
    if (this._keeps()) {
      return this;
    }
    const nodes = this._members.map((member) => adapt(member, options, memo));
    return new PUnion<T>(nodes, this._prior, { ...this._methods, compress: options });
  }

  get _holdsCompress(): boolean {
    return this._compress !== undefined || this._members.some((member) => member._holdsCompress);
  }

  _marker(value: unknown): number {
    const pos = this._byKind.get(kindOf(value));
    return pos === undefined ? kindMarker(value) : this._members[pos]._marker(value);
  }

  _markers(): ReadonlySet<number> | undefined {
    return unionOf(this._members);
  }

  _markerPrior(): MarkerPrior | undefined {
    return this._compress === undefined
      ? undefined
      : markerPrior(
          this,
          this._prior?.weights,
          this._members.map((member) => member._markers())
        );
  }

  /** The members that may spell `sym` first, in list order. */
  private _matching(sym: number): number[] {
    const out: number[] = [];
    this._members.forEach((member, i) => {
      if (member._markers()?.has(sym) !== false) out.push(i);
    });
    return out;
  }

  /** The step naming one of `matched`, the members that may spell `sym` first. */
  private _among(side: Encoder | Decoder, sym: number, matched: readonly number[]) {
    const weights = this._prior?.weights;
    return session(side).step(
      [this, sym],
      this._resolved as Resolved,
      matched.length,
      weights === undefined ? undefined : matched.map((i) => weights[i])
    );
  }

  _withMethods(methods: MethodSet): PUnion<T> {
    return new PUnion<T>(this._members, this._prior, methods);
  }

  _write(enc: Encoder, value: T): void {
    const kind = kindOf(value);
    const pos = this._byKind.get(kind);
    if (pos === undefined) {
      throw new TypeError(`Kind ${describe(kind)} is not ${oneOf(this._kinds)}`);
    }
    const member = this._members[pos];
    if (this._resolved === undefined) {
      this._pick.write(enc, pos);
      member._write(enc, value);
      return;
    }
    const sym = ownMarker(enc, this, this._resolved, member._marker(value));
    const matched = this._matching(sym);
    if (matched.length > 1) {
      this._among(enc, sym, matched).write(enc, matched.indexOf(pos));
    }
    session(enc).give(sym, member);
    member._write(enc, value);
  }

  _read(dec: Decoder): T {
    if (this._resolved === undefined) {
      return this._members[this._pick.read(dec)]._read(dec);
    }
    // The symbol was read among the union's own symbols, or among any where a member spells any,
    // so some member matches it.
    const sym = readOwnMarker(dec, this, this._resolved);
    const matched = this._matching(sym);
    const pos =
      matched.length === 1 ? matched[0] : matched[this._among(dec, sym, matched).read(dec)];
    const member = this._members[pos];
    session(dec).give(sym, member);
    return member._read(dec);
  }
}
