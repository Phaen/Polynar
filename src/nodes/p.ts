/**
 * The `p` factory: the public authoring surface.
 */
import {
  PAny,
  PArray,
  PBool,
  PDate,
  PDecimal,
  PEnum,
  PFloat,
  PInt,
  PNode,
  PNull,
  PObject,
  PString,
  PBytes,
  PLazy,
  PUnion,
  PTagged,
} from './';
import type { Infer } from './infer';

/**
 * One rule across every node: the factory takes what the type IS (a step, an
 * item type, a list, a shape); chained refinements say what values are
 * ALLOWED (`.min`, `.max`, `.precision`, `.charset`). Constraints never hide
 * in positional arguments.
 */
export const p = {
  /** Integer (strict); chain `.min(n)`/`.max(n)` — bounds pack denser. */
  int(): PInt {
    return new PInt();
  },
  /** Any finite double, bit-exact; simple values pack as fractions in a few bytes at any magnitude. */
  float(): PFloat {
    return new PFloat();
  },
  /**
   * Number on a fixed decimal step, e.g. `p.decimal(0.01)` for cents; chain
   * `.min(n)`/`.max(n)` — bounds pack denser. Exact scaled-integer
   * arithmetic: on-grid values round-trip bit-exact, off-grid values throw.
   */
  decimal(step: number): PDecimal {
    return new PDecimal(step);
  },
  /** UTF-16 string; chain `.max(n)` for a bounded (dense) length. */
  string(): PString {
    return new PString();
  },
  /** Boolean. */
  bool(): PBool {
    return new PBool();
  },
  /** Enum over a fixed list of values, matched by identity (`===`). */
  enum<const T extends readonly unknown[]>(list: T): PEnum<T[number]> {
    return new PEnum<T[number]>(list);
  },
  /**
   * One of several members, picked by the value's JS kind; one member per
   * kind. `p.union([p.string(), p.null()])` is a nullable string.
   */
  union<T extends readonly (PNode<any> & { _optional?: never })[]>(
    members: T
  ): PUnion<Infer<T[number]>> {
    return new PUnion<Infer<T[number]>>(members);
  },
  /** Object shapes picked by a tag field: `p.tagged('type', { a: p.object(...), b: p.object(...) })`. */
  tagged<K extends string, M extends Record<string, PObject<any>>>(
    key: K,
    members: M
  ): PTagged<K, M> {
    return new PTagged<K, M>(key, members);
  },
  /** Null; zero bits. Pairs with `p.union` for nullable fields. */
  /** Raw bytes as a `Uint8Array`; chain `.max(n)`/`.length(n)` like a string. */
  bytes(): PBytes {
    return new PBytes();
  },
  null(): PNull {
    return new PNull();
  },
  /** Date; chain `.min()`/`.max()` to bound, `.precision(unit, step?)` to coarsen to UTC calendar buckets. */
  date(): PDate {
    return new PDate();
  },
  /** Object with a fixed shape. */
  object<S extends Record<string, PNode<any>>>(shape: S): PObject<S> {
    return new PObject(shape);
  },
  /**
   * Array of one item type; chain `.min(n)`/`.max(n)` to bound the count
   * (bounds pack denser) or `.length(n)` to fix it — a fixed count costs
   * zero bits on the wire. The item cannot be `.optional()` (rejected at the
   * type level via the `_optional` phantom): an array slot is always occupied.
   */
  array<T>(item: PNode<T> & { _optional?: never }): PArray<T> {
    return new PArray<T>(item);
  },
  /**
   * A node looked up on first use, for schemas that refer to themselves:
   * `items: p.array(p.lazy(() => Block))`. TypeScript can't infer a type
   * that refers to itself, so the recursive const needs it written out:
   * `const Block: PNode<Block> = …`.
   */
  lazy<T>(resolve: () => PNode<T> & { _optional?: never }): PLazy<T> {
    return new PLazy<T>(resolve);
  },
  /** Self-describing escape hatch. */
  any(): PAny {
    return new PAny();
  },
};
