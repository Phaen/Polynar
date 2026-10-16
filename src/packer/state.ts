import type { Journal } from './journal';

/**
 * Per-message state for nodes whose coding depends on what the same node
 * wrote earlier in the message: an adaptive prior's counts, the strings a
 * message has seen. It also holds the message's registry of providers
 * (`../nodes/providers`), learned knowledge that nodes share by a string key.
 */

/** Rejects a `key` that cannot key a node's slot: anything but an object or a function. */
export function checkKey(key: unknown, name: string): void {
  if (key === null || (typeof key !== 'object' && typeof key !== 'function')) {
    throw new TypeError(`${name} must be an object, got ${key === null ? 'null' : typeof key}`);
  }
}

/**
 * The slots of one message, keyed by node identity, so every occurrence of a
 * node in the message shares one slot. It lives as long as the Encoder or
 * Decoder that holds it, which is one message. A slot made while the
 * encoder's `journal` has a mark open is dropped again when the mark rolls
 * back; a decoder's state has no journal.
 */
export class MessageState {
  private readonly slots = new Map<object, unknown>();
  /** The providers' slots, by `kind|key`. */
  private readonly providers = new Map<string, unknown>();
  /** How many slots were dropped so far: a `SlotCache` holds a slot only while this stands. */
  private drops = 0;

  constructor(private readonly journal?: Journal) {}

  /** How many slots were dropped so far. */
  get epoch(): number {
    return this.drops;
  }

  /** Drops the slot of `key`, a node's or a provider's, as a rollback does. */
  delete(key: object | string): boolean {
    this.drops++;
    return typeof key === 'string' ? this.providers.delete(key) : this.slots.delete(key);
  }

  /**
   * The slot for `key`: created by `init` on the message's first request for
   * it, and returned as-is after.
   */
  get<S>(key: object, init: () => S): S {
    const found = this.slots.get(key);
    if (found !== undefined || this.slots.has(key)) {
      return found as S;
    }
    checkKey(key, 'State key');
    const slot = init();
    this.slots.set(key, slot);
    if (this.journal?.active === true) {
      this.journal.drop(this, key);
    }
    return slot;
  }

  /**
   * The provider slot under `key`: created by `init` on the message's first
   * request for it, and returned as-is after, like a node's slot.
   */
  provider<S>(key: string, init: () => S): S {
    const found = this.providers.get(key);
    if (found !== undefined || this.providers.has(key)) {
      return found as S;
    }
    const slot = init();
    this.providers.set(key, slot);
    if (this.journal?.active === true) {
      this.journal.drop(this, key);
    }
    return slot;
  }
}

/** A side as a `SlotCache` reads it: its message state and that state's drops. */
export interface StateSide {
  state<S>(key: object, init: () => S): S;
  provider<S>(key: string, init: () => S): S;
  readonly stateEpoch: number;
}

/**
 * One key's slot on the side it was last read on, so a node that reads its
 * slot many times per value looks it up once: kept while the side is the
 * same and its message state has dropped no slot, as a dropped slot is
 * built afresh on the next read.
 */
export class SlotCache<S, Side extends StateSide> {
  private side: Side | undefined = undefined;
  private epoch = -1;
  private slot: S | undefined = undefined;

  /** The slot of `key`, built by `init` for a side whose message has none. */
  constructor(
    private readonly key: object | string,
    private readonly init: (side: Side) => S
  ) {}

  get(side: Side): S {
    if (side === this.side && side.stateEpoch === this.epoch) {
      return this.slot as S;
    }
    const { key } = this;
    const slot =
      typeof key === 'string'
        ? side.provider(key, () => this.init(side))
        : side.state(key, () => this.init(side));
    this.side = side;
    this.epoch = side.stateEpoch;
    this.slot = slot;
    return slot;
  }
}
