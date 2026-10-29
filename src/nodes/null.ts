import { STRUCT } from '../predictor/types';
import { PNode } from './base';
import type { Kind } from './guards';

const NULL_MARKERS: ReadonlySet<number> = new Set([STRUCT.NULL]);

/** Null; zero bits. `p.null`. Mostly a `p.union` member; `p.nullable` covers the usual case. */
export class PNull extends PNode<null> {
  readonly _kinds: readonly Kind[] = ['null'];

  _markers(): ReadonlySet<number> {
    return NULL_MARKERS;
  }

  _write(): void {}

  _read(): null {
    return null;
  }
}
