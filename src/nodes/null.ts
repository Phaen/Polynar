import { PNode } from './base';
import type { Kind } from './guards';

/** Null; zero bits. `p.null`. Pairs with p.union for nullable fields. */
export class PNull extends PNode<null> {
  readonly _kinds: readonly Kind[] = ['null'];

  _write(): void {}

  _read(): null {
    return null;
  }
}
