/**
 * The streaming coder: an exact rANS over base-`size` digits, with one state
 * carried across the whole message.
 *
 * The encoder folds the symbols in reverse, starting from state 0. Before
 * folding a symbol that owns `freq` of `total` states, it emits the state's
 * low digits until the state is below size·⌊L/total⌋·freq; folding then
 * leaves it below size·⌊L/total⌋·total. A uniform slot folds as x·total +
 * cum, a weighted symbol as ⌊x/freq⌋·total + cum + x mod freq, or through
 * the spread map while x is below freq, which only happens before the first
 * emission, at the message's end. The output is the final state, most
 * significant digit first, followed by the emitted digits in reverse.
 *
 * The decoder reads digits into its state while it is below ⌊L/total⌋·total
 * and input remains, then unfolds the symbol. Under the window condition on
 * `L` (see `RANS_L`) it reads exactly the digits the encoder emitted before
 * folding that symbol, so it holds the encoder's state at every symbol.
 * Missing input reads as nothing more, so reads past the last written
 * symbol unfold state 0 and return zeros.
 *
 * Every step is exact BigInt arithmetic; totals and frequencies are safe
 * integers, and the state stays below size·L.
 */

import { RANS_L } from './constants';
import { rankOf, residualAt, spreadOf } from './spread';

/** A symbol's bucket as `locate` maps a residual to it: the symbol, its cum and its freq. */
export type Located<T> = readonly [symbol: T, cum: number, freq: number];

/**
 * The window of the last total a side switched to, kept since runs of one
 * total repeat it: `scale` = ⌊L/total⌋ and the decoder's `floor` =
 * scale·total.
 */
class Window {
  private total = 0;
  big = 0n;
  scale = 0n;
  floor = 0n;

  constructor(private readonly L: bigint) {}

  /** Switch to `total`, a safe integer of at least 2. */
  use(total: number): void {
    if (total !== this.total) {
      this.total = total;
      this.big = BigInt(total);
      this.scale = this.L / this.big;
      this.floor = this.scale * this.big;
    }
  }
}

/** The write side: symbols pushed last to first, then `digits`. */
export class StreamWriter {
  private x = 0n;
  /** The emitted digits, in the order emitted: the reverse of the order they are read in. */
  private readonly emitted: number[] = [];
  private readonly base: bigint;
  private readonly window: Window;

  /** `size` is the digit base, at least 2; `L` is the window, `RANS_L` unless a test narrows it. */
  constructor(size: number, L: bigint = RANS_L) {
    this.base = BigInt(size);
    this.window = new Window(L);
  }

  /** The state, before the next symbol is pushed. */
  get state(): bigint {
    return this.x;
  }

  /** How many digits the pushes so far emitted. */
  get count(): number {
    return this.emitted.length;
  }

  /** The `i`-th emitted digit in read order, `i` in [0, count). */
  emittedAt(i: number): number {
    return this.emitted[this.emitted.length - 1 - i];
  }

  /**
   * Emit low digits until a symbol owning `freq` of `total` states can fold
   * onto the state without leaving the window. Pushing that symbol next
   * emits nothing more, so the state here is the one it folds onto.
   */
  renormalise(freq: number, total: number): void {
    const window = this.window;
    window.use(total);
    const base = this.base;
    const top = freq === 1 ? base * window.scale : base * window.scale * BigInt(freq);
    let x = this.x;
    if (x < top) {
      return;
    }
    const emitted = this.emitted;
    do {
      const q = x / base;
      emitted.push(Number(x - q * base));
      x = q;
    } while (x >= top);
    this.x = x;
  }

  /**
   * Fold one symbol: the bucket `[cum, cum + freq)` of `total` states, a
   * uniform slot (`freq` 1, read by `StreamReader.uniform`) or a weighted
   * symbol (read by `StreamReader.weighted`). The bucket is not all of
   * `total`: such a symbol carries nothing and is never pushed.
   */
  push(cum: number, freq: number, total: number, weighted: boolean): void {
    this.renormalise(freq, total);
    const x = this.x;
    const bigTotal = this.window.big;
    if (!weighted) {
      this.x = x * bigTotal + BigInt(cum);
      return;
    }
    const bigFreq = BigInt(freq);
    if (x < bigFreq) {
      // Below `freq`, so below 2^53: a double holds it exactly.
      this.x = BigInt(spreadOf(cum, freq, total, Number(x)));
      return;
    }
    const q = x / bigFreq;
    this.x = q * bigTotal + BigInt(cum) + (x - q * bigFreq);
  }

  /** The message: the state's digits, most significant first, then the emitted digits in read order. */
  digits(): number[] {
    const base = this.base;
    const digits: number[] = [];
    for (let x = this.x; x > 0n; ) {
      const q = x / base;
      digits.push(Number(x - q * base));
      x = q;
    }
    digits.reverse();
    for (let i = this.emitted.length - 1; i >= 0; i--) {
      digits.push(this.emitted[i]);
    }
    return digits;
  }
}

/** The read side: symbols read first to last, mirroring `StreamWriter`. */
export class StreamReader {
  private x = 0n;
  /** The next digit to read. */
  private at = 0;
  private readonly base: bigint;
  private readonly window: Window;

  /**
   * Reads the `length` digits `digitAt` returns, each in [0, size); `size`
   * and `L` match the writer's.
   */
  constructor(
    private readonly digitAt: (i: number) => number,
    private readonly length: number,
    size: number,
    L: bigint = RANS_L
  ) {
    this.base = BigInt(size);
    this.window = new Window(L);
  }

  /** The state, before the next symbol is read. */
  get state(): bigint {
    return this.x;
  }

  /**
   * Whether the input has run out and the state is back at 0: every symbol
   * read from here on is a zero that no input backs.
   */
  get drained(): boolean {
    return this.at >= this.length && this.x === 0n;
  }

  /** The position of the next digit to read: the digits before it are read. */
  get position(): number {
    return this.at;
  }

  /**
   * Switch the window to `total` and tell whether reading a symbol of it
   * reads digits first: the state is below the window and input remains.
   */
  private wouldRead(total: number): boolean {
    this.window.use(total);
    return this.at < this.length && this.x < this.window.floor;
  }

  /** Read digits while the state is below the window `wouldRead` switched to and input remains. */
  private fill(): void {
    const floor = this.window.floor;
    const base = this.base;
    let x = this.x;
    do {
      x = x * base + BigInt(this.digitAt(this.at++));
    } while (x < floor && this.at < this.length);
    this.x = x;
  }

  /** Read one uniform slot of `radix` states, at least 2. */
  uniform(radix: number): number {
    if (this.wouldRead(radix)) {
      this.fill();
    }
    const bigRadix = this.window.big;
    const x = this.x;
    const q = x / bigRadix;
    this.x = q;
    return Number(x - q * bigRadix);
  }

  /**
   * Read one weighted symbol of `total` states, at least 2. `locate` maps a
   * residual in [0, total) to its symbol's bucket.
   *
   * A bucket holding all `total` states was never pushed, so nothing is read
   * for it and the state stays. Before a read of digits it is recognised by
   * both ends of the residual range landing on its symbol: a cdf that goes
   * down somewhere can hand a full-width bucket to one end only, and then a
   * symbol was written and must be read. Without a read, the bucket the
   * state's own residual lands in tells it apart.
   */
  weighted<T>(total: number, locate: (residual: number) => Located<T>): T {
    if (this.wouldRead(total)) {
      const only = locate(0);
      if (only[2] === total && locate(total - 1)[0] === only[0]) {
        return only[0];
      }
      this.fill();
    }
    const x = this.x;
    const bigTotal = this.window.big;
    if (x < bigTotal) {
      // Below `total`, so below 2^53: a double holds it exactly.
      const { residual, visit } = residualAt(Number(x), total);
      const [symbol, cum, freq] = checkLocated(locate(residual), residual, total);
      if (freq !== total) {
        this.x = BigInt(rankOf(visit, cum, freq, total));
      }
      return symbol;
    }
    const q = x / bigTotal;
    const residual = Number(x - q * bigTotal);
    const [symbol, cum, freq] = checkLocated(locate(residual), residual, total);
    if (freq !== total) {
      this.x = BigInt(freq) * q + BigInt(residual - cum);
    }
    return symbol;
  }
}

/**
 * The bucket `locate` returned for `residual`, refused when it does not
 * contain the residual: that is a model bug on the reading side, not
 * corrupt input.
 */
function checkLocated<T>(located: Located<T>, residual: number, total: number): Located<T> {
  const [, cum, freq] = located;
  if (
    !Number.isInteger(cum) ||
    !Number.isInteger(freq) ||
    freq < 1 ||
    cum < 0 ||
    cum > residual ||
    residual >= cum + freq ||
    cum + freq > total
  ) {
    throw new TypeError(
      `locate returned a bucket that does not contain the residual: [${cum}, ${cum + freq}) for ${residual}`
    );
  }
  return located;
}
