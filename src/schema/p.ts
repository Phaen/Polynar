/**
 * The `p` factory: the public authoring surface.
 */
import { PAny, PBool, PDate, PEnum, PFloat, PInt, PNode, PObject, PString } from './nodes';

export const p = {
  /** Integer in `[min, max]` (truncated). Omit a bound for unbounded. */
  int(min?: number, max?: number): PInt {
    return new PInt(min ?? false, max ?? false);
  },
  /** Alias of `int`, integers by default. Safe to destructure (`const { number } = p`). */
  number(min?: number, max?: number): PInt {
    return new PInt(min ?? false, max ?? false);
  },
  /** Decimal (lossy ~1e-15, not dense). */
  float(precision?: number): PFloat {
    return new PFloat(precision);
  },
  /** UTF-16 string; chain `.max(n)` for a bounded (dense) length. */
  string(): PString {
    return new PString();
  },
  /** Boolean. */
  bool(): PBool {
    return new PBool();
  },
  /** Enum over a fixed list of string literals. */
  enum<const T extends readonly string[]>(list: T): PEnum<T[number]> {
    return new PEnum<T[number]>(list);
  },
  /** Date; chain `.interval()` to trade precision for density. */
  date(min?: number | Date, max?: number | Date): PDate {
    return new PDate(min, max);
  },
  /** Object with a fixed shape. */
  object<S extends Record<string, PNode<any>>>(shape: S): PObject<S> {
    return new PObject(shape);
  },
  /** Self-describing escape hatch. */
  any(): PAny {
    return new PAny();
  },
};
