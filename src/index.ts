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
  PBinary,
  PLazy,
  PBool,
  PEnum,
  PDate,
  PObject,
  PArray,
  PAny,
  PNull,
  PUnion,
  PTagged,
} from './nodes';
export { ProseModels, buildProseModel } from './nodes';
export type {
  Infer,
  InferShape,
  InferTagged,
  Cdf,
  DateUnit,
  Kind,
  ProseModel,
  ProseModelOptions,
  TypedArray,
  TypedArrayClass,
} from './nodes';

export { Encoder, Decoder, CorruptInputError, CharSets } from './packer';
export type { Charset, ByteRange } from './packer';
