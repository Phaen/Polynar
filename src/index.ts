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
  PCollection,
  PAny,
  PNull,
  PUnion,
  PNullable,
  PTagged,
  PVersioned,
} from './nodes';
export { ProseModels, buildProseModel, members } from './nodes';
export type {
  AdaptiveOptions,
  AnyValue,
  Infer,
  InferShape,
  InferTagged,
  Cdf,
  DateUnit,
  FloatWeights,
  Kind,
  MemberPrior,
  Members,
  ProseModel,
  ProseModelOptions,
  TypedArray,
  TypedArrayClass,
} from './nodes';

export {
  Encoder,
  Decoder,
  MessageState,
  CorruptInputError,
  UnknownVersionError,
  CharSets,
} from './packer';
export type { Bucket, Charset, CodecOptions, OutputType } from './packer';
