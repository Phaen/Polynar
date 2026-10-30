import { Encoder, Decoder } from '../packer';
import { resolve } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import type { MarkerPrior } from '../predictor/session';
import { STRUCT, type CompressOptions, type Resolved } from '../predictor/types';
import type { Kind } from './guards';
import type { AdaptOptions } from './adaptive';
import { checkUnset } from './lattice';
import { markerPrior, ownMarker, readOwnMarker } from './markers';
import { members, type MemberPrior, type Members } from './members';
import { MethodNode, learningOf, type MethodSet } from './methods';

const BOOL_MARKERS: ReadonlySet<number> = new Set([STRUCT.TRUE, STRUCT.FALSE]);

/** Boolean. `p.bool`. */
export class PBool extends MethodNode<boolean> {
  readonly _kinds: readonly Kind[] = ['boolean'];

  /** The prior as declared, `[true, false]`, for the rebuilds. */
  private readonly _prior?: MemberPrior;
  /** Member 0 is true, as the weights list it first. */
  private readonly _members: Members;
  declare readonly _radix?: number;
  readonly _compress?: CompressOptions;
  /** Under `.compress()`: the options the value's symbol codes under. */
  private readonly _resolved?: Resolved;

  constructor(
    prior?: MemberPrior,
    readonly _methods: MethodSet = {}
  ) {
    super();
    this._prior = prior;
    this._members = members(2, { ...prior, adapt: learningOf(_methods) }, 'p.bool');
    this._compress = _methods.compress;
    if (this._compress === undefined) {
      this._radix = this._members.radix;
    } else {
      this._resolved = resolve(this._compress, loadedPriors.json, 'p.bool');
    }
  }

  /**
   * Declare how likely each value is, as `[true, false]`. A prior, not a
   * constraint, and part of the wire format.
   */
  weights(w: readonly [number, number]): PBool {
    checkUnset(this._prior?.weights, 'p.bool', 'weights');
    return new PBool({ ...this._prior, weights: w }, this._methods);
  }

  /**
   * Let the prior learn from the message: the declared weights, or even ones
   * when none are, are where it starts, and each value coded counts as one
   * observation, so a value that keeps recurring gets cheaper as the message
   * goes on. From its second value on, the node spends one bit to stay static,
   * or a few to name the learning rate that paid off. `window` is how many
   * observations the counts hold before they halve, so the newest weigh most
   * (1024 when left out, and raised to the number of values counted when
   * smaller), and `separate` keeps it from starting where other nodes of its
   * kind and window got to. Part of the wire format, like the weights. Not
   * with `.compress()`.
   */
  adapt(options?: AdaptOptions): PBool {
    return this._declare('adapt', 'p.bool', options);
  }

  /**
   * Code the values through the similarity predictor, as the symbols true
   * and false of the structure around them, with the weights as their prior
   * counts. Not with `.adapt()`. Set once.
   */
  compress(options?: CompressOptions): PBool {
    return this._adapt(options, 'p.bool');
  }

  _adapted(options: CompressOptions): PBool {
    return this._adaptedTo(options);
  }

  _withMethods(methods: MethodSet): PBool {
    return new PBool(this._prior, methods);
  }

  _marker(value: unknown): number {
    return value ? STRUCT.TRUE : STRUCT.FALSE;
  }

  _markers(): ReadonlySet<number> {
    return BOOL_MARKERS;
  }

  _markerPrior(): MarkerPrior | undefined {
    return this._compress === undefined
      ? undefined
      : markerPrior(this, this._prior?.weights, [new Set([STRUCT.TRUE]), new Set([STRUCT.FALSE])]);
  }

  _write(enc: Encoder, value: boolean): void {
    if (this._resolved === undefined) {
      this._members.write(enc, this._toDigit(value));
    } else {
      ownMarker(enc, this, this._resolved, this._marker(value));
    }
  }

  _read(dec: Decoder): boolean {
    if (this._resolved === undefined) {
      return this._members.read(dec) === 0;
    }
    return readOwnMarker(dec, this, this._resolved) === STRUCT.TRUE;
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
