/**
 * Schema nodes, one per file. `base` holds the PNode contract every node
 * implements; `lattice` is the shared integer wire for int, decimal and
 * date.
 */
export { PNode, POptional } from './base';
export { PInt } from './int';
export { PDecimal } from './decimal';
export { PFloat } from './float';
export { PString } from './string';
export { PBool } from './bool';
export { PEnum } from './enum';
export { PDate } from './date';
export { PArray } from './array';
export { PObject } from './object';
export { PAny } from './any';

export { p } from './p';
export type { Infer, InferShape } from './infer';
