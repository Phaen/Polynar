/**
 * Schema layer public surface. Importing this triggers codec module registration
 * (via ./nodes, which calls registerAllModules() at import time).
 */
export { p } from './p';
export type { Infer, InferShape, Simplify } from './infer';
export {
  PNode,
  POptional,
  PInt,
  PFloat,
  PString,
  PBool,
  PEnum,
  PDate,
  PObject,
  PAny,
} from './nodes';
