/**
 * The delta and recall methods of the lattice nodes, which keep no public
 * method since `.adaptive()` hands their values to the predictor: declared
 * through the internals they still run on.
 */

import type { Learning } from '../../nodes/adaptive';
import { withMethod, type MethodName, type MethodSet } from '../../nodes/methods';

/** A node with methods. */
interface Methods {
  readonly _methods: MethodSet;
  _withMethods(methods: MethodSet): unknown;
}

/** `p.int`, `p.decimal` or `p.date`, as the node's errors name it. */
const who = (node: object): string => `p.${node.constructor.name.slice(1).toLowerCase()}`;

/** `node` with each of `names` declared, as `.delta()` and `.recall()` declared them. */
export function declare<N extends Methods>(node: N, ...names: MethodName[]): N {
  let methods = node._methods;
  for (const name of names) {
    methods = withMethod(methods, name, who(node));
  }
  return node._withMethods(methods) as N;
}

/** `node` with its methods' tables learning under `learning`. */
export function learning<N extends Methods>(node: N, options: Learning): N {
  return node._withMethods({ ...node._methods, learning: options }) as N;
}
