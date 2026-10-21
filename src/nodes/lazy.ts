import { Encoder, Decoder, CorruptInputError } from '../packer';
import { PNode } from './base';
import { MAX_DEPTH } from './any';
import { unlocated } from './path';

/** The message's slot for how many lazy references deep the coding is, shared by every `p.lazy`. */
export const DEPTH = {};

/**
 * A node resolved on first use, so a schema can refer to itself or to a node
 * defined further down. `p.lazy`. The function runs once, on the first
 * encode or decode, and the node it returns does all the work: a lazy
 * reference costs nothing on the wire. Its kinds stay unknown until then, so
 * it cannot be a `p.union` member. Values nesting more than `MAX_DEPTH`
 * lazy references deep throw, which also stops a value that contains itself.
 */
export class PLazy<T> extends PNode<T> {
  private readonly _resolve: () => PNode<T>;
  private _node?: PNode<T>;
  private _resolving = false;

  constructor(resolve: () => PNode<T>) {
    super();
    this._resolve = resolve;
  }

  /** The node `resolve` returns, resolved on first use. */
  get _target(): PNode<T> {
    return this._resolveOnce();
  }

  private _resolveOnce(): PNode<T> {
    if (this._node === undefined) {
      // A chain of lazy references that comes back here never reaches a node.
      if (this._resolving) {
        throw new TypeError('p.lazy resolves to itself');
      }
      this._resolving = true;
      try {
        const node = this._resolve();
        if (node instanceof PLazy) {
          node._resolveOnce();
        }
        this._node = node;
      } finally {
        this._resolving = false;
      }
    }
    return this._node;
  }

  _takesUndefined(): boolean {
    return this._target._takesUndefined();
  }

  _write(enc: Encoder, value: T): void {
    this._nest(enc, () => this._target._write(enc, value));
  }

  _read(dec: Decoder): T {
    return this._nest(dec, () => this._target._read(dec));
  }

  /** Runs `code` one lazy reference deeper, refusing past `MAX_DEPTH`. */
  private _nest<R>(side: Encoder | Decoder, code: () => R): R {
    const message = side.state(DEPTH, () => ({ depth: 0 }));
    if (message.depth === MAX_DEPTH) {
      if (side instanceof Encoder) {
        // Every level would add a segment to the path, so the message leaves it out.
        throw unlocated(new RangeError(`p.lazy nests deeper than ${MAX_DEPTH} levels`));
      }
      // The encoder never nests deeper, and deeper input could overflow the stack.
      throw unlocated(new CorruptInputError(`p.lazy input nests deeper than ${MAX_DEPTH} levels`));
    }
    message.depth++;
    try {
      return code();
    } finally {
      message.depth--;
    }
  }
}
