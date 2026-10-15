/**
 * The replay decoder: reads an encoder's log back as a decoder reads its
 * output, and refuses a read the log does not hold.
 */

import { Encoder, ReplayDecoder } from '../packer';
import { p } from '../index';

/** A located bucket of `total` states split at `cut`: symbol 0 below, 1 from it. */
const halves =
  (cut: number, total: number) =>
  (residual: number): readonly [number, number, number] =>
    residual < cut ? [0, 0, cut] : [1, cut, total - cut];

describe('ReplayDecoder', () => {
  it('reads back uniform digits, terms, big radices and weighted symbols', () => {
    const enc = new Encoder();
    enc.compose(5, 7);
    enc.compose(0, 1);
    enc.composeTerm(123456);
    enc.composeBig(2n ** 70n + 5n, 2n ** 71n);
    enc.composeWeighted(3, 5, 8);
    enc.composeWeighted(0, 1, 1);
    const dec = new ReplayDecoder(enc);
    expect(dec.parse(7)).toBe(5);
    expect(dec.parse(1)).toBe(0);
    expect(dec.parseTerm()).toBe(123456);
    expect(dec.parseBig(2n ** 71n)).toBe(2n ** 70n + 5n);
    expect(dec.parseWeighted(8, halves(3, 8))).toBe(1);
    // A bucket holding every state was never logged.
    expect(dec.parseWeighted(4, () => [9, 0, 4])).toBe(9);
    expect(dec.parseWeighted(1, () => [7, 0, 1])).toBe(7);
    dec.finalize();
  });

  it('reads a value back as decoding its message would', () => {
    const node = p.array(p.string().adaptive());
    const value = ['alpha', 'alphabet', 'alpha', 'beta', 'alphabet'];
    const enc = new Encoder();
    node._write(enc, value);
    const dec = new ReplayDecoder(enc);
    expect(node._read(dec)).toEqual(value);
    dec.finalize();
  });

  it('charges nothing and bounds no repeat by digits', () => {
    const dec = new ReplayDecoder(new Encoder());
    expect(dec.digits).toBe(Infinity);
    expect(() => dec.charge()).not.toThrow();
    dec.finalize();
  });

  it('refuses a read the log does not hold', () => {
    const enc = new Encoder();
    enc.compose(2, 4);
    enc.composeWeighted(0, 3, 8);
    expect(() => new ReplayDecoder(enc).parse(5)).toThrow(
      new TypeError('Replay read event 0 as a symbol other than the one logged')
    );
    expect(() => new ReplayDecoder(enc).parseWeighted(4, halves(1, 4))).toThrow(
      new TypeError('Replay read event 0 as a symbol other than the one logged')
    );
    const off = new ReplayDecoder(enc);
    off.parse(4);
    expect(() => off.parseWeighted(8, halves(2, 8))).toThrow(
      new TypeError('Replay read event 1 as a bucket other than the one logged')
    );
    const short = new ReplayDecoder(enc);
    short.parse(4);
    expect(() => short.finalize()).toThrow(new TypeError('Replay read 1 of 2 events logged'));
    short.parseWeighted(8, halves(3, 8));
    expect(() => short.parse(2)).toThrow(new TypeError('Replay read past the last event logged'));
    expect(() => short.parseWeighted(0.5, halves(1, 2))).toThrow(TypeError);
  });
});
