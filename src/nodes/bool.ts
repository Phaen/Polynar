import { Encoder, Decoder } from '../packer';
import type { Kind } from './guards';
import type { LearningOptions } from './adaptive';
import { members, type MemberPrior, type Members } from './members';
import { MethodNode, PRIOR_METHODS, learningOf, type MethodSet } from './methods';

/** Boolean. `p.bool`. */
export class PBool extends MethodNode<boolean> {
  readonly _kinds: readonly Kind[] = ['boolean'];

  /** The prior as declared, `[true, false]`, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  readonly _methodNames = PRIOR_METHODS;
  /** Member 0 is true, as the weights list it first. */
  private readonly _members: Members;
  declare readonly _radix?: number;

  constructor(
    prior?: MemberPrior,
    readonly _methods: MethodSet = {}
  ) {
    super();
    this._prior = prior;
    this._members = members(2, { ...prior, learn: learningOf(_methods) }, 'p.bool');
    this._radix = this._members.radix;
  }

  /**
   * Declare how likely each value is, as `[true, false]`. A prior, not a
   * constraint, and part of the wire format.
   */
  weights(w: readonly number[]): PBool {
    return new PBool({ ...this._prior, weights: w }, this._methods);
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are where it starts, and each value coded counts as one
   * observation, so a value that keeps recurring gets cheaper as the message
   * goes on. From its second value on, the node spends one bit to stay static,
   * or a few to name the learning rate that paid off. Part of the wire format,
   * like the weights.
   */
  learn(): PBool {
    return this._declare('learn', 'p.bool');
  }

  /**
   * What the node's learning goes by: `window` is how many observations the
   * counts hold before they halve, so the newest weigh most (1024 when left
   * out, and raised to the number of values counted when smaller), and
   * `separate` keeps it from starting where other nodes of its kind and window
   * got to. Set once; it applies once something learns.
   */
  learning(options: LearningOptions): PBool {
    return this._learning(options, 'p.bool');
  }

  /** Learn with every method the node has, here `.learn()`, under `options` as `.learning()` takes them. */
  adaptive(options?: LearningOptions): PBool {
    return this._adapt(options, 'p.bool');
  }

  _withMethods(methods: MethodSet): PBool {
    return new PBool(this._prior, methods);
  }

  get _exact(): boolean {
    return true;
  }

  _write(enc: Encoder, value: boolean): void {
    this._members.write(enc, this._toDigit(value));
  }

  _read(dec: Decoder): boolean {
    return this._members.read(dec) === 0;
  }

  /** `digit` lies in `[0, _radix)`, as a digit read in `_radix` does. */
  _fromDigit(digit: number): boolean {
    return digit === 0;
  }

  /** True is member 0, as the weights list it first. */
  _toDigit(value: boolean): number {
    return value ? 0 : 1;
  }
}
