import { PNode } from './base';
import type { Kind } from './guards';

/** Null; zero bits. `p.null`. Mostly a `p.union` member; `p.nullable` covers the usual case. */
export class PNull extends PNode<null> {
  readonly _kinds: readonly Kind[] = ['null'];

  _write(): void {}

  _read(): null {
    return null;
  }
}
