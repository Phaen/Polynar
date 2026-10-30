/**
 * How a node learns from the message: `.adapt(options?)`, the fast count
 * learning of its members table or range, or `.compress(options?)`, the
 * similarity predictor. A node takes one of the two, once.
 */

import { checkAdaptation, type AdaptOptions } from './adaptive';
import { PNode } from './base';
import { applyCompress, checkCompress } from '../predictor/options';
import { loadedPriors } from '../predictor/prior';
import type { CompressOptions } from '../predictor/types';

/** How a node learns, carried through every rebuild so a later `.min()` or `.weights()` keeps it. */
export interface MethodSet {
  /** The node's own priors learn from the message, under these options (`true`: the defaults). */
  readonly adapt?: AdaptOptions | true;
  /** The node codes through the predictor under these options. */
  readonly compress?: CompressOptions;
}

/** A node that can learn: `.adapt()` and `.compress()` each set once, and not both. */
export abstract class MethodNode<TOut> extends PNode<TOut> {
  /** How the node learns. */
  abstract readonly _methods: MethodSet;
  /** The node with `methods` in place of its own. */
  abstract _withMethods(methods: MethodSet): MethodNode<TOut>;

  /** The node learning under `options`; `who` names it in the errors. */
  protected _declare(method: 'adapt', who: string, options?: AdaptOptions): this {
    if (this._methods.compress !== undefined) {
      throw new TypeError(`${who} adapt and compress cannot both be set`);
    }
    if (this._methods[method] !== undefined) {
      throw new TypeError(`${who} ${method} is already set`);
    }
    if (options !== undefined) {
      checkAdaptation(options, who);
    }
    const adapt = options === undefined ? true : { ...options };
    return this._withMethods({ ...this._methods, adapt }) as this;
  }

  /** The node coding through the predictor under `options`; `who` names it in the errors. */
  protected _adapt(options: CompressOptions | undefined, who: string): this {
    if (this._methods.compress !== undefined) {
      throw new TypeError(`${who} compress is already set`);
    }
    if (learns(this._methods)) {
      throw new TypeError(`${who} adapt and compress cannot both be set`);
    }
    return this._withMethods({ ...this._methods, compress: checkCompress(options, who) }) as this;
  }

  /**
   * `.compress(options)` on a node with nodes below it: the node and every node below it that
   * neither learns nor adapts already code through the predictor under `options`.
   */
  protected _sugar(options: CompressOptions | undefined, who: string): this {
    if (this._methods.compress !== undefined) {
      throw new TypeError(`${who} compress is already set`);
    }
    if (learns(this._methods)) {
      throw new TypeError(`${who} adapt and compress cannot both be set`);
    }
    // The default prior of every node that is not a string or a binary.
    return applyCompress(this, checkCompress(options, who), loadedPriors.json.source);
  }

  /**
   * The node coding through the predictor under `options`, checked already, as a container's
   * `.compress()` reaches it; as it is when it learns or adapts already.
   */
  protected _adaptedTo(options: CompressOptions): this {
    return this._keeps()
      ? this
      : (this._withMethods({ ...this._methods, compress: options }) as this);
  }

  /** Whether a container's `.compress()` leaves the node as it is: it learns or adapts already. */
  protected _keeps(): boolean {
    return this._methods.adapt !== undefined || this._methods.compress !== undefined;
  }
}

/** Whether the node's own priors learn. */
export function learns(methods: MethodSet): boolean {
  return methods.adapt !== undefined;
}

/** What the node's own priors learn under: none unless they learn. */
export function learningOf(methods: MethodSet): AdaptOptions | undefined {
  const { adapt } = methods;
  return adapt === undefined ? undefined : adapt === true ? {} : adapt;
}
