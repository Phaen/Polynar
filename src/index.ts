/**
 * Polynar - Efficient data encoding library
 *
 * The schema layer (`p` and the node classes) is the API. `Encoder` and
 * `Decoder` are the mixed-radix packer primitives underneath — exported for
 * custom nodes, which subclass `PNode` and write digits through them.
 *
 * @packageDocumentation
 */

export { p } from './nodes';
export {
  PNode,
  POptional,
  PInt,
  PFloat,
  PDecimal,
  PString,
  PBool,
  PEnum,
  PDate,
  PObject,
  PArray,
  PAny,
} from './nodes';
export type { Infer, InferShape } from './nodes';

export { Encoder, Decoder, CorruptInputError, CharSets } from './packer';
export type { Charset } from './packer';
