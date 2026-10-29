/**
 * How a node learns from the message: `.learn(options?)`, the fast count
 * learning of its members table or range, or `.adaptive(options?)`, the
 * similarity predictor. A node takes one of the two, once.
 */

import { checkAdaptation, type LearningOptions } from './adaptive';
import { PNode } from './base';
import { applyAdaptive, checkAdaptive } from '../predictor/options';
import { Priors } from '../predictor/prior';
import type { AdaptiveOptions } from '../predictor/types';

/** How a node learns, carried through every rebuild so a later `.min()` or `.weights()` keeps it. */
export interface MethodSet {
  /** The node's own priors learn from the message, under these options (`true`: the defaults). */
  readonly learn?: LearningOptions | true;
  /** The node codes through the predictor under these options. */
  readonly adaptive?: AdaptiveOptions;
}

/** A node that can learn: `.learn()` and `.adaptive()` each set once, and not both. */
export abstract class MethodNode<TOut> extends PNode<TOut> {
  /** How the node learns. */
  abstract readonly _methods: MethodSet;
  /** The node with `methods` in place of its own. */
  abstract _withMethods(methods: MethodSet): MethodNode<TOut>;

  /** The node learning under `options`; `who` names it in the errors. */
  protected _declare(method: 'learn', who: string, options?: LearningOptions): this {
    if (this._methods.adaptive !== undefined) {
      throw new TypeError(`${who} learn and adaptive cannot both be set`);
    }
    if (this._methods[method] !== undefined) {
      throw new TypeError(`${who} ${method} is already set`);
    }
    if (options !== undefined) {
      checkAdaptation(options, who);
    }
    const learn = options === undefined ? true : { ...options };
    return this._withMethods({ ...this._methods, learn }) as this;
  }

  /** The node coding through the predictor under `options`; `who` names it in the errors. */
  protected _adapt(options: AdaptiveOptions | undefined, who: string): this {
    if (this._methods.adaptive !== undefined) {
      throw new TypeError(`${who} adaptive is already set`);
    }
    if (learns(this._methods)) {
      throw new TypeError(`${who} learn and adaptive cannot both be set`);
    }
    return this._withMethods({ ...this._methods, adaptive: checkAdaptive(options, who) }) as this;
  }

  /**
   * `.adaptive(options)` on a node with nodes below it: the node and every node below it that
   * neither learns nor adapts already code through the predictor under `options`.
   */
  protected _sugar(options: AdaptiveOptions | undefined, who: string): this {
    if (this._methods.adaptive !== undefined) {
      throw new TypeError(`${who} adaptive is already set`);
    }
    if (learns(this._methods)) {
      throw new TypeError(`${who} learn and adaptive cannot both be set`);
    }
    // The default prior of every node that is not a string or a binary.
    return applyAdaptive(this, checkAdaptive(options, who), Priors.text.source);
  }

  /**
   * The node coding through the predictor under `options`, checked already, as a container's
   * `.adaptive()` reaches it; as it is when it learns or adapts already.
   */
  protected _adaptedTo(options: AdaptiveOptions): this {
    return this._keeps()
      ? this
      : (this._withMethods({ ...this._methods, adaptive: options }) as this);
  }

  /** Whether a container's `.adaptive()` leaves the node as it is: it learns or adapts already. */
  protected _keeps(): boolean {
    return this._methods.learn !== undefined || this._methods.adaptive !== undefined;
  }
}

/** Whether the node's own priors learn. */
export function learns(methods: MethodSet): boolean {
  return methods.learn !== undefined;
}

/** What the node's own priors learn under: none unless they learn. */
export function learningOf(methods: MethodSet): LearningOptions | undefined {
  const { learn } = methods;
  return learn === undefined ? undefined : learn === true ? {} : learn;
}
