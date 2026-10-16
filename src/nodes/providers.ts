import { Encoder, Decoder, SlotCache } from '../packer';

/**
 * Providers: the learned knowledge nodes share within a message, such as a
 * string engine's items and contexts, the gathered tables of a prior's kin,
 * or the fields companions are predicted from.
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

/**
 * The sequences a learned spelling is shared by: those whose alphabets name
 * `pool`, compared by identity, under `window`, and, for what is learned per
 * kind of value, of `kind`.
 */
export interface Pool {
  readonly pool: string | object;
  readonly window: number;
  readonly kind?: number;
}

/** The ids `poolKey` gives object pools, in order of first use. */
const ids = new WeakMap<object, number>();
let nextId = 0;

/**
 * The key of what `pool` shares, `parts` following it; undefined for no
 * pool. A string pool keys as itself, an object by an id of its own, which
 * no string pool takes, as those never start with `#`.
 */
export function poolKey(pool: Pool | undefined, ...parts: number[]): string | undefined {
  if (pool === undefined) {
    return undefined;
  }
  let name: string;
  if (typeof pool.pool === 'string') {
    name = pool.pool;
  } else {
    let id = ids.get(pool.pool);
    if (id === undefined) {
      id = nextId++;
      ids.set(pool.pool, id);
    }
    name = `#${id}`;
  }
  return [name, pool.window, pool.kind ?? '', ...parts].join('|');
}
