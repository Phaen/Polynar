import { Encoder, Decoder } from '../packer';
import type { Kind } from './guards';
import type { InferTagged } from './infer';
import type { PObject } from './object';
import { atPath, oneOf, describe } from './path';
import type { LearningOptions } from './adaptive';
import { checkUnset } from './lattice';
import { members, type MemberPrior, type Members } from './members';
import { MethodNode, learningOf, type MethodSet } from './methods';
import { adapt, type PNode } from './base';
import { ownMarker, readOwnMarker } from './markers';
import { resolve } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import { session } from '../predictor/session';
import { STRUCT, type CompressOptions, type Resolved } from '../predictor/types';

const OBJECT_MARKERS: ReadonlySet<number> = new Set([STRUCT.OBJ_START]);

/**
 * Tagged union: object shapes picked by the value's tag field. `p.tagged`.
 *
 * The tag is written as an index into the members (log2(members) bits, or
 * whatever the weights say), never as text, and the tag key belongs to no
 * member shape: the union carries it. The node is of kind 'object', so it
 * combines with members of other kinds in `p.union`.
 */
export class PTagged<K extends string, M extends Record<string, PObject<any>>> extends MethodNode<
  InferTagged<K, M>
> {
  readonly _kinds: readonly Kind[] = ['object'];
  private readonly _key: K;
  private readonly _members: M;
  private readonly _tags: readonly string[];
  private readonly _index = new Map<string, number>();
  /** The prior as declared, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  /** How the tag is spelled. */
  private readonly _pick: Members;
  readonly _compress?: CompressOptions;
  /** Under `.compress()`: the options the tag step codes under. */
  private readonly _resolved?: Resolved;

  constructor(
    key: K,
    shapes: M,
    prior?: MemberPrior,
    readonly _methods: MethodSet = {}
  ) {
    super();
    this._key = key;
    this._members = { ...shapes }; // copy so later caller mutation can't change the node
    this._tags = Object.keys(this._members);
    if (this._tags.length === 0) {
      throw new TypeError('p.tagged requires at least one member');
    }
    this._tags.forEach((tag, i) => {
      // JS lists keys like '2' before all others, in numeric order, so the
      // member order (and with it the weights and the wire) would not be the
      // order the members were written in.
      if (/^(0|[1-9]\d{0,9})$/.test(tag) && Number(tag) < 2 ** 32 - 1) {
        throw new TypeError(
          `p.tagged tag ${describe(tag)} is an array index, which JS lists before other keys; a non-digit like "v${tag}" keeps the order`
        );
      }
      if (this._members[tag]._has(key)) {
        throw new TypeError(
          `p.tagged member ${describe(tag)} cannot have a ${describe(key)} field; the tag carries it`
        );
      }
      this._index.set(tag, i);
    });
    this._prior = prior;
    this._pick = members(this._tags.length, { ...prior, learn: learningOf(_methods) }, 'p.tagged');
    this._compress = _methods.compress;
    if (this._compress !== undefined) {
      this._resolved = resolve(this._compress, loadedPriors.json, 'p.tagged');
    }
  }

  /**
   * Declare how likely each member is, in key order. A prior, not a
   * constraint: rare members still encode, just dearer. The weights are part
   * of the wire format.
   */
  weights(w: readonly number[]): PTagged<K, M> {
    checkUnset(this._prior?.weights, 'p.tagged', 'weights');
    return new PTagged<K, M>(
      this._key,
      this._members,
      { ...this._prior, weights: w },
      this._methods
    );
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are where it starts, and each tag coded counts as one
   * observation, so a tag that keeps recurring gets cheaper as the message
   * goes on. From its second value on, the node spends one bit to stay static,
   * or a few to name the learning rate that paid off. `window` is how many
   * observations the counts hold before they halve, so the newest weigh most
   * (1024 when left out, and raised to the number of values counted when
   * smaller), and `separate` keeps it from starting where other nodes of its
   * kind and window got to. Part of the wire format, like the weights. Not
   * with `.compress()`.
   */
  learn(options?: LearningOptions): PTagged<K, M> {
    return this._declare('learn', 'p.tagged', options);
  }

  /**
   * Code the tags through the similarity predictor: each is predicted from
   * the tags the node coded before, how recently and in what company, with
   * the weights as their prior counts; the members as under their own
   * `.compress(options)`. Not with `.learn()`. Set once.
   */
  compress(options?: CompressOptions): PTagged<K, M> {
    return this._sugar(options, 'p.tagged');
  }

  _adapted(options: CompressOptions, memo: Map<PNode<any>, PNode<any>>): PTagged<K, M> {
    if (this._keeps()) {
      return this;
    }
    // fromEntries defines own properties, so a '__proto__' tag stays a member.
    const shapes = Object.fromEntries(
      this._tags.map((tag) => [tag, adapt(this._members[tag], options, memo)])
    );
    return new PTagged<K, M>(this._key, shapes as M, this._prior, {
      ...this._methods,
      compress: options,
    });
  }

  get _holdsCompress(): boolean {
    return (
      this._compress !== undefined || this._tags.some((tag) => this._members[tag]._holdsCompress)
    );
  }

  _marker(): number {
    return STRUCT.OBJ_START;
  }

  _markers(): ReadonlySet<number> {
    return OBJECT_MARKERS;
  }

  _withMethods(methods: MethodSet): PTagged<K, M> {
    return new PTagged<K, M>(this._key, this._members, this._prior, methods);
  }

  _write(enc: Encoder, value: InferTagged<K, M>): void {
    const tag = (value as Record<string, unknown>)[this._key];
    const pos = this._index.get(tag as string);
    if (tag === undefined) {
      throw atPath(new TypeError('Required field is missing'), this._key);
    }
    if (pos === undefined) {
      throw atPath(new RangeError(`Value ${describe(tag)} is not ${oneOf(this._tags)}`), this._key);
    }
    const member = this._members[this._tags[pos]];
    const o = this._resolved;
    if (o === undefined) {
      this._pick.write(enc, pos);
    } else {
      const sym = ownMarker(enc, this, o, STRUCT.OBJ_START);
      this._step(enc).write(enc, pos);
      // The member's object starts with the symbol the tag was coded after.
      session(enc).give(sym, member);
    }
    // The member ignores the tag key as it ignores any key outside its shape.
    member._write(enc, value);
  }

  _read(dec: Decoder): InferTagged<K, M> {
    const o = this._resolved;
    let pos: number;
    if (o === undefined) {
      pos = this._pick.read(dec);
    } else {
      const sym = readOwnMarker(dec, this, o);
      pos = this._step(dec).read(dec);
      session(dec).give(sym, this._members[this._tags[pos]]);
    }
    const tag = this._tags[pos];
    return { [this._key]: tag, ...this._members[tag]._read(dec) } as InferTagged<K, M>;
  }

  /** The tag step of the node on the session of `side`. */
  private _step(side: Encoder | Decoder) {
    const o = this._resolved as Resolved;
    return session(side).step(this, o, this._tags.length, this._prior?.weights);
  }
}
