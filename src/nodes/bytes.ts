import { Encoder, Decoder } from '../packer';
import { PNode } from './base';
import type { Kind } from './guards';
import { LengthPrefix, type LengthBounds } from './lattice';

/**
 * Raw bytes: a length prefix, then eight bits per byte. Decodes to a fresh
 * `Uint8Array`; `.min`/`.max`/`.length` bound the count like a string's.
 * `p.bytes`.
 */
export class PBytes extends PNode<Uint8Array> {
  readonly _kinds: readonly Kind[] = ['bytes'];

  private readonly _length: LengthPrefix;

  constructor(bounds: LengthBounds = {}) {
    super();
    this._length = new LengthPrefix(bounds, 'p.bytes');
  }

  /** A floor on the count; the prefix then counts up from it. */
  min(n: number): PBytes {
    return new PBytes({ ...this._length.bounds, min: n });
  }

  max(n: number): PBytes {
    return new PBytes({ ...this._length.bounds, max: n });
  }

  /** Fix the exact count. The prefix then costs zero bits on the wire. */
  length(n: number): PBytes {
    return new PBytes({ ...this._length.bounds, length: n });
  }

  _write(enc: Encoder, value: Uint8Array): void {
    this._length.write(enc, value.length, () => `${value.length} bytes`);
    for (let i = 0; i < value.length; i++) {
      enc.compose(value[i], 256);
    }
  }

  _read(dec: Decoder): Uint8Array {
    const value = new Uint8Array(this._length.read(dec));
    for (let i = 0; i < value.length; i++) {
      value[i] = dec.parse(256);
    }
    return value;
  }
}
