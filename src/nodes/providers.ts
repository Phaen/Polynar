import { Encoder, Decoder, SlotCache } from '../packer';

/**
 * Providers: the learned knowledge nodes share within a message, such as
 * the gathered tables of a prior's kin.
 *
 * A provider's kind says how its message state is built and what keys it
 * from its configuration. A node holds a ref to each provider it reads; the
 * message's registry (`MessageState.provider`) holds one state per
 * `kind|key`, so nodes whose refs key alike share it. A config that keys
 * nothing, as under `separate`, makes the provider the ref's own, which
 * nothing else names. Keys come from the schema alone, and both sides walk
 * the schema in the same order, so they build and share the same
 * providers. A provider made inside an encoder's try is dropped again when
 * the try rolls back.
 *
 * What a provider holds per message lives in that state; what it is built
 * from (tables, rows, models) is immutable and may be memoized across
 * messages.
 */

/** A kind of learned knowledge: how its state is built per message on `Side`, and what keys it. */
export interface ProviderKind<Config, State, Side extends Encoder | Decoder = Encoder | Decoder> {
  /** The kind's name, the first part of every key. */
  readonly name: string;
  /**
   * What keys the provider among others of the kind: everything in `config`
   * that changes its state; undefined where nothing else may share it.
   */
  key(config: Config): string | undefined;
  /** The provider's state in a message on `side`, built on the message's first request. */
  init(config: Config, side: Side): State;
}

/** Which provider a node reads, configured how: shared by its key, else the ref's own. */
export class ProviderRef<
  Config,
  State,
  Side extends Encoder | Decoder = Encoder | Decoder,
> extends SlotCache<State, Side> {
  constructor(kind: ProviderKind<Config, State, Side>, config: Config) {
    const key = kind.key(config);
    super(key === undefined ? {} : `${kind.name}|${key}`, (side) => kind.init(config, side));
  }
}
