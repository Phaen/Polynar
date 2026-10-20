/**
 * Digit fields as companions code them: a run of digits inside a string, or
 * a number, coded as its distance from a learned origin on a scale of its
 * own (`FieldScale`).
 */

import type { Encoder, Decoder } from '../packer';
import { Fenwick } from './fenwick';
import { MAX_CLASS, classOf, type Magnitude } from './magnitude';

/** The most digits one field holds: its value stays a safe integer. A longer run splits into fields of this width from its start. */
export const FIELD_DIGITS = 15;

/** The members of a field scale: the origin, then each class above it, then each below. */
const SCALE_MEMBERS = 1 + 2 * MAX_CLASS;

/** What a field scale starts each member at: the origin and small classes likelier. */
const SCALE_START: readonly number[] = Array.from({ length: SCALE_MEMBERS }, (_, member) => {
  const cls = member === 0 ? 0 : member <= MAX_CLASS ? member : member - MAX_CLASS;
  return Math.max(1, 16 >> cls);
});

/** What a field scale adds to a member per value, and the total past which it halves. */
const SCALE_GAIN = 16;
const SCALE_WINDOW = 1024;

/**
 * A learned magnitude scale with no static start to choose: the side and
 * bit-length class of the distance from the origin as one member of
 * learned counts, the classes the interval does not reach owning no
 * states, then the distance within its class, every one alike.
 */
export class FieldScale implements Magnitude {
  private table(side: Encoder | Decoder): Fenwick {
    return side.state(this, () => new Fenwick(SCALE_START, side.journal));
  }

  /** The states the reached members own: the origin and the classes above it, and those below it. */
  private static reach(table: Fenwick, origin: number, lo: number, hi: number): [number, number] {
    const ups = table.prefix(classOf(hi - origin) + 1);
    const downs = table.prefix(MAX_CLASS + 1 + classOf(origin - lo)) - table.prefix(MAX_CLASS + 1);
    return [ups, downs];
  }

  write(enc: Encoder, value: number, origin: number, lo: number, hi: number): void {
    const table = this.table(enc);
    const up = value >= origin;
    const distance = up ? value - origin : origin - value;
    const cls = classOf(distance);
    const member = cls === 0 ? 0 : up ? cls : MAX_CLASS + cls;
    const [ups, downs] = FieldScale.reach(table, origin, lo, hi);
    const cum = up ? table.cum(member) : ups + table.cum(member) - table.prefix(MAX_CLASS + 1);
    enc.composeWeighted(cum, table.freq(member), ups + downs);
    if (cls > 0) {
      const start = 2 ** (cls - 1);
      const end = Math.min(2 * start - 1, up ? hi - origin : origin - lo);
      enc.compose(distance - start, end - start + 1);
    }
  }

  read(dec: Decoder, origin: number, lo: number, hi: number): number {
    const table = this.table(dec);
    const [ups, downs] = FieldScale.reach(table, origin, lo, hi);
    const below = table.prefix(MAX_CLASS + 1);
    const member = dec.parseWeighted(ups + downs, (residual) => {
      const at = table.locate(residual < ups ? residual : residual - ups + below);
      const cum = residual < ups ? table.cum(at) : ups + table.cum(at) - below;
      return [at, cum, table.freq(at)] as const;
    });
    if (member === 0) {
      return origin;
    }
    const up = member <= MAX_CLASS;
    const cls = up ? member : member - MAX_CLASS;
    const start = 2 ** (cls - 1);
    const end = Math.min(2 * start - 1, up ? hi - origin : origin - lo);
    const distance = start + dec.parse(end - start + 1);
    return up ? origin + distance : origin - distance;
  }

  learn(side: Encoder | Decoder, value: number, origin: number): void {
    const up = value >= origin;
    const cls = classOf(up ? value - origin : origin - value);
    const table = this.table(side);
    table.add(cls === 0 ? 0 : up ? cls : MAX_CLASS + cls, SCALE_GAIN);
    if (table.total > SCALE_WINDOW) {
      table.halve(true);
    }
  }
}
