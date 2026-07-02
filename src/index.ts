/**
 * Polynar - Efficient data encoding library
 *
 * @packageDocumentation
 */

export { CharSets, Encoder, Decoder, modules, registerModule } from './polynar';
export type * from './types';

// Schema layer
export {
  p,
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
} from './schema';
export type { Infer, InferShape, Simplify } from './schema';
