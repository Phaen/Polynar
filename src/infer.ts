/**
 * Type-level inference for schema nodes.
 *
 * A schema node carries a phantom output type on `_t`. `Infer` extracts it.
 * Object shapes split required vs `.optional()` keys (detected via the `_optional`
 * phantom marker), then flatten the intersection so the result is identity-equal
 * to a hand-written object type.
 */
import type { PNode } from './nodes';

/** Extract the output type a node decodes to. */
export type Infer<N> = N extends PNode<infer T> ? T : never;

/** Flatten an intersection (`A & B`) into a single object type. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type OptionalKeys<S> = {
  [K in keyof S]: S[K] extends { readonly _optional: true } ? K : never;
}[keyof S];
type RequiredKeys<S> = Exclude<keyof S, OptionalKeys<S>>;

/** Infer the object type for a `p.object({...})` shape. */
export type InferShape<S> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;
