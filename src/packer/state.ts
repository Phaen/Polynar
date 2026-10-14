/**
 * Per-message state for nodes whose coding depends on what the same node
 * wrote earlier in the message: an adaptive prior's counts, the strings a
 * message has seen.
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
 * Decoder that holds it, which is one message.
 */
export class MessageState {
  private readonly slots = new Map<object, unknown>();

  /**
   * The slot for `key`: created by `init` on the message's first request for
   * it, and returned as-is after.
   */
  get<S>(key: object, init: () => S): S {
    if (this.slots.has(key)) {
      return this.slots.get(key) as S;
    }
    checkKey(key, 'State key');
    const slot = init();
    this.slots.set(key, slot);
    return slot;
  }
}
