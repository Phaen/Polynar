/**
 * The streaming coder: an exact rANS over base-`size` digits, with one state
 * carried across the whole message.
 *
 * Symbol i owns `freq` f_i of `total` T_i states and has a window
 * k_i (see `ransWindow`); A_i = k_i·T_i and B_i = k_i·f_i. The encoder folds
 * the symbols in reverse, starting from state 0. Before folding symbol i, it
 * emits the state's low digits until the state is below size·B_i; folding
 * then leaves it below size·A_i. A uniform slot folds as x·T + cum, a
 * weighted symbol as ⌊x/f⌋·T + cum + x mod f, or through the spread map
 * while x is below f, which only happens before the first emission, at the
 * message's end. The output is the final state, most significant digit
 * first, followed by the emitted digits in reverse.
 *
 * The decoder reads digits into its state while it is below A_i and input
 * remains, then unfolds the symbol. As A_i ≥ B_{i−1} (see `ransWindow`), it
 * reads exactly the digits the encoder emitted before folding that symbol,
 * so it holds the encoder's state at every symbol. Missing input reads as
 * nothing more, so reads past the last written symbol unfold state 0 and
 * return zeros.
 *
 * The state is a double while size·A_i is a safe integer, which keeps every
 * value a step computes a safe integer, and a BigInt otherwise: around a
 * total too large for the window, and for the symbols after it until the
 * window is back at ⌊L/T⌋. Whichever it is held in, the arithmetic is exact.
 * After unfolding symbol i the state is below size·B_i ≤ size·A_{i+1}, so a
 * step that starts on a BigInt state takes it as a double when its own
 * bound allows.
 */

import { ransWindow } from './constants';
import { rankOf, residualAt, spreadOf } from './spread';

/** A symbol's bucket as `locate` maps a residual to it: the symbol, its cum and its freq. */
export type Located<T> = readonly [symbol: T, cum: number, freq: number];

/** Where a `Locator` leaves the bucket `[cum, cum + freq)` it found. */
export class Span {
  cum = 0;
  freq = 0;
}

/**
 * Maps a residual to the symbol whose bucket holds it, the bucket left in
 * `span`. A locator keeps whatever it reads by between calls in its own
 * fields, so a read allocates nothing.
 */
export interface Locator<T> {
  locate(residual: number, span: Span): T;
}

/** A `Locator` over a function returning each bucket as a `Located` triple. */
export class TupleLocator<T> implements Locator<T> {
  /** `find` may be left out until the first read. */
  constructor(public find?: (residual: number) => Located<T>) {}

  locate(residual: number, span: Span): T {
    const located = (this.find as (residual: number) => Located<T>)(residual);
    span.cum = located[1];
    span.freq = located[2];
    return located[0];
  }
}

/**
 * ⌊a/b⌋ for a safe integer a ≥ 0 and an integer b ≥ 1. Rounding never takes
 * a/b below an integer it reaches, so the floor could only be off where a/b
 * lies g/b short of an integer m, g ≥ 1, and rounds up to it. That takes
 * g/b within half a unit in the last place of m, at most m·2^−53, so
 * m·b ≥ 2^53 and a = m·b − g ≥ m·b·(1 − 2^−53) ≥ 2^53 − 1. Then
 * a = 2^53 − 1 and m·b = 2^53, so b is a power of two and a/b is exact.
 */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/**
 * The windows of a message's symbols in message order, as both sides step
 * through them: `open` a symbol's total, then `close` it with its freq when
 * it was coded. k = max(1, ⌊L/T⌋, ⌈B/T⌉), B the last coded symbol's k·f, 0
 * before the first. k is a double while it is a safe integer, else `kBig`.
 */
class Windows {
  /** k of the opened symbol, NaN when it is past 2^53 and held in `kBig`. */
  k = 0;
  kBig = 0n;
  /** A = k·T of the opened symbol, when `small`. */
  A = 0;
  /** Whether size·A of the opened symbol is a safe integer. */
  small = false;
  /** B of the last coded symbol, NaN when it is past 2^53 and held in `carryBig`. */
  private carry = 0;
  private carryBig = 0n;
  /** The last total opened, and ⌊L/T⌋ and ⌊L/T⌋·T for it. */
  private total = 0;
  private kL = 0;
  private AL = 0;
  /** The largest A for which size·A is a safe integer. */
  private readonly limit: number;

  constructor(
    private readonly L: number,
    size: number
  ) {
    this.limit = floorDiv(Number.MAX_SAFE_INTEGER, size);
  }

  /** Open a symbol of `total` states, a safe integer of at least 2. */
  open(total: number): void {
    if (total !== this.total) {
      this.total = total;
      this.kL = floorDiv(this.L, total);
      this.AL = this.kL * total;
    }
    const carry = this.carry;
    if (carry <= this.AL && this.kL >= 1) {
      // ⌈B/T⌉ is at most ⌊L/T⌋; A = ⌊L/T⌋·T ≤ L keeps size·A safe.
      this.k = this.kL;
      this.A = this.AL;
      this.small = true;
      return;
    }
    if (carry === carry) {
      const up = floorDiv(carry, total);
      const k = Math.max(1, this.kL, up * total < carry ? up + 1 : up);
      // A product rounded to at most `limit` is exact.
      const A = k * total;
      this.k = k;
      this.A = A;
      this.small = A <= this.limit;
      return;
    }
    // B is past 2^53 > L, so ⌈B/T⌉ is above ⌊L/T⌋ and 1, and A past 2^53.
    const big = BigInt(total);
    const k = (this.carryBig + big - 1n) / big;
    if (k <= BigInt(Number.MAX_SAFE_INTEGER)) {
      this.k = Number(k);
    } else {
      this.k = NaN;
      this.kBig = k;
    }
    this.small = false;
  }

  /** k of the opened symbol, as a BigInt. */
  get bigK(): bigint {
    return this.k === this.k ? BigInt(this.k) : this.kBig;
  }

  /** Close the opened symbol, coded with `freq`: B = k·f. */
  close(freq: number): void {
    const B = this.k * freq;
    if (B <= Number.MAX_SAFE_INTEGER) {
      this.carry = B;
    } else {
      this.carry = NaN;
      this.carryBig = this.bigK * BigInt(freq);
    }
  }
}

/** The write side: symbols pushed last to first, then `digits`. */
export class StreamWriter {
  /** The state, a double unless `big`. */
  private x = 0;
  private xb = 0n;
  private big = false;
  /** The emitted digits, in the order emitted: the reverse of the order they are read in. */
  private readonly emitted: number[] = [];
  /** Each symbol's k in message order, NaN where it is in `bigKs`. */
  private readonly ks: number[];
  private readonly bigKs = new Map<number, bigint>();
  /** The message position of the last symbol pushed. */
  private next: number;
  /** The largest A for which size·A is a safe integer. */
  private readonly limit: number;

  /**
   * A writer for the symbols of `totals` and `freqs` in message order,
   * after a uniform `head` slot of that many states when it is not 0.
   * `size` is the digit base, from 2 to 65536; `L` is the window,
   * `ransWindow(size)` unless a test narrows it.
   */
  constructor(
    private readonly size: number,
    totals: ArrayLike<number>,
    freqs: ArrayLike<number>,
    head: number,
    L: number = ransWindow(size)
  ) {
    this.limit = floorDiv(Number.MAX_SAFE_INTEGER, size);
    const windows = new Windows(L, size);
    const ks: number[] = [];
    const step = (total: number, freq: number): void => {
      windows.open(total);
      if (windows.k !== windows.k) {
        this.bigKs.set(ks.length, windows.kBig);
      }
      ks.push(windows.k);
      windows.close(freq);
    };
    if (head !== 0) {
      step(head, 1);
    }
    for (let i = 0; i < totals.length; i++) {
      step(totals[i], freqs[i]);
    }
    this.ks = ks;
    this.next = ks.length;
  }

  /** The state, before the next symbol is pushed. */
  get state(): bigint {
    return this.big ? this.xb : BigInt(this.x);
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
   * Emit low digits until the next symbol, owning `freq` of `total` states,
   * can fold onto the state without leaving its window: below size·k·f.
   * Pushing that symbol next emits nothing more, so the state here is the
   * one it folds onto. Whether the fold keeps a double state.
   */
  renormalise(freq: number, total: number): boolean {
    const at = this.next - 1;
    const k = this.ks[at];
    const size = this.size;
    if (k * total <= this.limit) {
      const top = size * k * freq;
      if (this.big) {
        this.emitBig(BigInt(top));
        // Below size·B, a safe integer, now: a double holds it.
        this.x = Number(this.xb);
        this.big = false;
      }
      let x = this.x;
      if (x >= top) {
        const emitted = this.emitted;
        do {
          const q = floorDiv(x, size);
          emitted.push(x - q * size);
          x = q;
        } while (x >= top);
        this.x = x;
      }
      return true;
    }
    if (!this.big) {
      this.xb = BigInt(this.x);
      this.big = true;
    }
    const bigK = k === k ? BigInt(k) : (this.bigKs.get(at) as bigint);
    this.emitBig(BigInt(size) * bigK * BigInt(freq));
    return false;
  }

  /** Emit low digits of the BigInt state until it is below `top`. */
  private emitBig(top: bigint): void {
    let x = this.xb;
    if (x < top) {
      return;
    }
    const base = BigInt(this.size);
    const emitted = this.emitted;
    do {
      const q = x / base;
      emitted.push(Number(x - q * base));
      x = q;
    } while (x >= top);
    this.xb = x;
  }

  /**
   * Fold the next symbol back from the message's end: the bucket
   * `[cum, cum + freq)` of `total` states, a uniform slot (`freq` 1, read by
   * `StreamReader.uniform`) or a weighted symbol (read by
   * `StreamReader.weighted`), as the constructor was given it. The bucket is
   * not all of `total`: such a symbol carries nothing and is never pushed.
   */
  push(cum: number, freq: number, total: number, weighted: boolean): void {
    if (this.renormalise(freq, total)) {
      // Below size·A, a safe integer, after the fold, and so is every step to it.
      const x = this.x;
      if (!weighted) {
        this.x = x * total + cum;
      } else if (x < freq) {
        this.x = spreadOf(cum, freq, total, x);
      } else {
        const q = floorDiv(x, freq);
        this.x = q * total + cum + (x - q * freq);
      }
    } else {
      const x = this.xb;
      const bigTotal = BigInt(total);
      if (!weighted) {
        this.xb = x * bigTotal + BigInt(cum);
      } else {
        const bigFreq = BigInt(freq);
        if (x < bigFreq) {
          // Below `freq`, so below 2^53: a double holds it exactly.
          this.xb = BigInt(spreadOf(cum, freq, total, Number(x)));
        } else {
          const q = x / bigFreq;
          this.xb = q * bigTotal + BigInt(cum) + (x - q * bigFreq);
        }
      }
    }
    this.next--;
  }

  /** The message: the state's digits, most significant first, then the emitted digits in read order. */
  digits(): number[] {
    const size = this.size;
    const digits: number[] = [];
    if (this.big) {
      const base = BigInt(size);
      for (let x = this.xb; x > 0n; ) {
        const q = x / base;
        digits.push(Number(x - q * base));
        x = q;
      }
    } else {
      for (let x = this.x; x > 0; ) {
        const q = floorDiv(x, size);
        digits.push(x - q * size);
        x = q;
      }
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
  /** The state, a double unless `big`. */
  private x = 0;
  private xb = 0n;
  private big = false;
  /** The next digit to read. */
  private at = 0;
  private readonly windows: Windows;
  /** Where `weighted` has its locator leave a bucket. */
  private readonly span = new Span();

  /**
   * Reads the `length` digits `digitAt` returns, each in [0, size); `size`
   * and `L` match the writer's.
   */
  constructor(
    private readonly digitAt: (i: number) => number,
    private readonly length: number,
    private readonly size: number,
    L: number = ransWindow(size)
  ) {
    this.windows = new Windows(L, size);
  }

  /** The state, before the next symbol is read. */
  get state(): bigint {
    return this.big ? this.xb : BigInt(this.x);
  }

  /**
   * Whether the input has run out and the state is back at 0: every symbol
   * read from here on is a zero that no input backs.
   */
  get drained(): boolean {
    return this.at >= this.length && (this.big ? this.xb === 0n : this.x === 0);
  }

  /** The position of the next digit to read: the digits before it are read. */
  get position(): number {
    return this.at;
  }

  /**
   * The state as a double, for a symbol whose window `small` holds: it is
   * below size·B of the last coded symbol, which is at most this one's A.
   */
  private small(): number {
    if (this.big) {
      this.x = Number(this.xb);
      this.big = false;
    }
    return this.x;
  }

  /** The state as a BigInt, for a symbol whose window is not `small`. */
  private large(): bigint {
    if (!this.big) {
      this.xb = BigInt(this.x);
      this.big = true;
    }
    return this.xb;
  }

  /** `x` with digits read into it while it is below `A` and input remains. */
  private fill(x: number, A: number): number {
    const size = this.size;
    do {
      x = x * size + this.digitAt(this.at++);
    } while (x < A && this.at < this.length);
    return x;
  }

  /** `fill` on a BigInt state. */
  private fillBig(x: bigint, A: bigint): bigint {
    const base = BigInt(this.size);
    do {
      x = x * base + BigInt(this.digitAt(this.at++));
    } while (x < A && this.at < this.length);
    return x;
  }

  /** Read one uniform slot of `radix` states, at least 2. */
  uniform(radix: number): number {
    const windows = this.windows;
    windows.open(radix);
    let digit: number;
    if (windows.small) {
      let x = this.small();
      if (this.at < this.length && x < windows.A) {
        x = this.fill(x, windows.A);
      }
      const q = floorDiv(x, radix);
      this.x = q;
      digit = x - q * radix;
    } else {
      let x = this.large();
      const bigRadix = BigInt(radix);
      const A = windows.bigK * bigRadix;
      if (this.at < this.length && x < A) {
        x = this.fillBig(x, A);
      }
      const q = x / bigRadix;
      this.xb = q;
      digit = Number(x - q * bigRadix);
    }
    windows.close(1);
    return digit;
  }

  /**
   * Read one weighted symbol of `total` states, at least 2. `locator` maps a
   * residual in [0, total) to its symbol, leaving the symbol's bucket in
   * `span`. With `checked`, a bucket that does not contain the residual is
   * refused: that is a bug in the locator, not corrupt input.
   *
   * A bucket holding all `total` states was never pushed, so nothing is read
   * for it and the state and windows stay. Before a read of digits it is
   * recognised by both ends of the residual range landing on its symbol: a
   * cdf that goes down somewhere can hand a full-width bucket to one end
   * only, and then a symbol was written and must be read. Without a read,
   * the bucket the state's own residual lands in tells it apart.
   */
  weighted<T>(total: number, locator: Locator<T>, checked: boolean): T {
    const windows = this.windows;
    const span = this.span;
    windows.open(total);
    let symbol: T;
    if (windows.small) {
      let x = this.small();
      if (this.at < this.length && x < windows.A) {
        const only = locator.locate(0, span);
        if (span.freq === total && locator.locate(total - 1, span) === only) {
          return only;
        }
        x = this.fill(x, windows.A);
        this.x = x;
      }
      if (x < total) {
        const { residual, visit } = residualAt(x, total);
        symbol = locator.locate(residual, span);
        const { cum, freq } = span;
        if (checked) {
          checkSpan(cum, freq, residual, total);
        }
        if (freq !== total) {
          this.x = rankOf(visit, cum, freq, total);
          windows.close(freq);
        }
        return symbol;
      }
      const q = floorDiv(x, total);
      const residual = x - q * total;
      symbol = locator.locate(residual, span);
      const { cum, freq } = span;
      if (checked) {
        checkSpan(cum, freq, residual, total);
      }
      if (freq !== total) {
        // Below size·B ≤ size·A, a safe integer.
        this.x = freq * q + (residual - cum);
        windows.close(freq);
      }
      return symbol;
    }
    let x = this.large();
    const bigTotal = BigInt(total);
    const A = windows.bigK * bigTotal;
    if (this.at < this.length && x < A) {
      const only = locator.locate(0, span);
      if (span.freq === total && locator.locate(total - 1, span) === only) {
        return only;
      }
      x = this.fillBig(x, A);
      this.xb = x;
    }
    if (x < bigTotal) {
      // Below `total`, so below 2^53: a double holds it exactly.
      const { residual, visit } = residualAt(Number(x), total);
      symbol = locator.locate(residual, span);
      const { cum, freq } = span;
      if (checked) {
        checkSpan(cum, freq, residual, total);
      }
      if (freq !== total) {
        this.xb = BigInt(rankOf(visit, cum, freq, total));
        windows.close(freq);
      }
      return symbol;
    }
    const q = x / bigTotal;
    const residual = Number(x - q * bigTotal);
    symbol = locator.locate(residual, span);
    const { cum, freq } = span;
    if (checked) {
      checkSpan(cum, freq, residual, total);
    }
    if (freq !== total) {
      this.xb = BigInt(freq) * q + BigInt(residual - cum);
      windows.close(freq);
    }
    return symbol;
  }
}

/**
 * Refuses the bucket `[cum, cum + freq)` a locator found for `residual`
 * when it does not contain the residual: that is a model bug on the
 * reading side, not corrupt input.
 */
function checkSpan(cum: number, freq: number, residual: number, total: number): void {
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
}
