/**
 * A decoder that reads an encoder's log instead of digits: a uniform read
 * returns the logged value and a weighted read locates the logged bucket,
 * with no fold and no digits in between. It reads back what a node just
 * wrote, to see the value the decoder would get.
 */

import { Decoder } from './decoder';
import type { Encoder, EventLog } from './encoder';
import type { Radix } from './types';
import type { Locator } from './stream';

/**
 * Reads `encoder`'s log as a decoder reads its output, each read checked
 * against the event logged. An alternatives group reads as coding 0, which
 * its symbols hold until the encoder's `output`; any coding reads back the
 * same values.
 */
export class ReplayDecoder extends Decoder<string> {
  private readonly log: EventLog;
  /** The next event to read. */
  private at = 0;

  constructor(encoder: Encoder) {
    super('');
    this.log = encoder.events();
  }

  /** No digits limit what a replay's repeats may copy. */
  get digits(): number {
    return Infinity;
  }

  /** A log does not run dry, so no count is charged against a limit. */
  charge(): void {}

  protected parseRadix(radix: Radix): number {
    // The encoder logs nothing for a radix-1 digit.
    if (radix === 1) {
      return 0;
    }
    return this.log.cums[this.next(radix, false)];
  }

  protected parseLocator<T>(total: number, locator: Locator<T>): T {
    const span = this.span;
    // The encoder logs nothing for a bucket holding every state, which both
    // ends of the residual range landing on its symbol tell, as the stream
    // reader tells it.
    const only = locator.locate(0, span);
    if (span.freq === total && locator.locate(total - 1, span) === only) {
      return only;
    }
    const { cums, freqs } = this.log;
    const i = this.next(total, true);
    const symbol = locator.locate(cums[i], span);
    if (span.cum !== cums[i] || span.freq !== freqs[i]) {
      throw new TypeError(`Replay read event ${i} as a bucket other than the one logged`);
    }
    return symbol;
  }

  /** The next event, refused unless it is of `total` states and weighted as `weighted`. */
  private next(total: number, weighted: boolean): number {
    const { totals } = this.log;
    const i = this.at;
    if (i >= totals.length) {
      throw new TypeError('Replay read past the last event logged');
    }
    if (totals[i] !== total || this.log.weighted[i] !== weighted) {
      throw new TypeError(`Replay read event ${i} as a symbol other than the one logged`);
    }
    this.at++;
    return i;
  }

  /** Asserts the reads took every event logged. */
  finalize(): void {
    const count = this.log.totals.length;
    if (this.at !== count) {
      throw new TypeError(`Replay read ${this.at} of ${count} events logged`);
    }
  }
}
