/**
 * Recall: values spelled by their place among the distinct values a message
 * has already coded, or in full the first time.
 */

import { p, Encoder, Decoder } from '../../index';
import { PRecall } from '../../nodes/recall';
import { mulberry32 } from '../support';

const strings = () => new PRecall<string>(p.string(), (s) => s, 'test string');
const keyLists = () =>
  new PRecall<string[]>(p.array(p.string()), (keys) => JSON.stringify(keys), 'test shape');

/** Writes every value through `node` into one message and reads them back. */
const tripAll = <T>(node: PRecall<T>, values: readonly T[]): { bytes: Uint8Array; back: T[] } => {
  const enc = new Encoder();
  for (const value of values) node._write(enc, value);
  const bytes = enc.output();
  const dec = new Decoder(bytes);
  const back = values.map(() => node._read(dec));
  dec.finalize();
  return { bytes, back };
};

/**
 * The message a recall should write, from a plain list of counts: member 0
 * is "new", every later member a value in order of first appearance.
 */
const model = (values: readonly string[]): Uint8Array => {
  const enc = new Encoder();
  const counts = [1];
  const seen: string[] = [];
  const symbol = (member: number) => {
    const total = counts.reduce((a, b) => a + b, 0);
    if (counts.length > 1) {
      const cum = counts.slice(0, member).reduce((a, b) => a + b, 0);
      enc.composeWeighted(cum, counts[member], total, { index: member, count: counts.length });
    }
    counts[member]++;
  };
  for (const value of values) {
    const at = seen.indexOf(value);
    if (at >= 0) {
      symbol(at + 1);
    } else {
      symbol(0);
      p.string()._write(enc, value);
      counts.push(1);
      seen.push(value);
    }
  }
  return enc.output();
};

describe('PRecall', () => {
  it('takes its kinds from the inner node', () => {
    expect(strings()._kinds).toEqual(['string']);
    expect(keyLists()._kinds).toEqual(['array']);
  });

  it.each([
    ['one new value', ['a']],
    ['a repeat', ['a', 'a', 'a']],
    ['many distinct values', Array.from({ length: 50 }, (_, i) => `v${i}`)],
    ['interleaved values', ['a', 'b', 'a', 'c', 'b', 'b', 'd', 'a', '']],
  ])('round-trips %s', (_name, values) => {
    expect(tripAll(strings(), values).back).toEqual(values);
  });

  it('round-trips key lists, matched by their JSON', () => {
    const values = [['a', 'b'], [], ['a', 'b'], ['b', 'a'], [], ['a,b'], ['b', 'a']];
    const { back } = tripAll(keyLists(), values);
    expect(back).toEqual(values);
    // A recalled value is the one first decoded, not a copy.
    expect(back[2]).toBe(back[0]);
  });

  it('writes nothing for the first value beyond its spelling', () => {
    const enc = new Encoder();
    p.string()._write(enc, 'hello');
    expect(tripAll(strings(), ['hello']).bytes).toEqual(enc.output());
  });

  it('spells a repeat in fewer bits than a new value', () => {
    const repeat = tripAll(strings(), ['hello', 'hello', 'hello', 'hello']).bytes;
    const fresh = tripAll(strings(), ['hello', 'world', 'there', 'again']).bytes;
    expect(repeat.length).toBeLessThan(fresh.length);
    expect(repeat.length).toBeLessThanOrEqual(tripAll(strings(), ['hello']).bytes.length + 1);
  });

  it('counts each member as a plain list of counts does, over a seeded sequence', () => {
    const rand = mulberry32(7);
    const pool = ['ok', 'warn', 'error', 'down', 'up', 'idle'];
    const values = Array.from({ length: 300 }, () => pool[Math.floor(rand() ** 2 * pool.length)]);
    const { bytes, back } = tripAll(strings(), values);
    expect(back).toEqual(values);
    expect(bytes).toEqual(model(values));
  });

  it('reads a value spelled as new when it is already recalled, as a new member', () => {
    const enc = new Encoder();
    // Member 0 with the table at one member writes nothing.
    p.string()._write(enc, 'a');
    // Member 0 again, now out of [1, 1], then the same text.
    enc.composeWeighted(0, 2, 3, { index: 0, count: 2 });
    p.string()._write(enc, 'a');
    // Member 2, the second copy, out of [new 3, a 1, a 1].
    enc.composeWeighted(4, 1, 5, { index: 2, count: 3 });
    const node = strings();
    const dec = new Decoder(enc.output());
    expect(node._read(dec)).toBe('a');
    expect(node._read(dec)).toBe('a');
    expect(node._read(dec)).toBe('a');
  });

  it('keeps a separate pool per node in one message', () => {
    const first = strings();
    const second = strings();
    const enc = new Encoder();
    first._write(enc, 'a');
    second._write(enc, 'b');
    first._write(enc, 'a');
    second._write(enc, 'a');
    const dec = new Decoder(enc.output());
    expect([first._read(dec), second._read(dec), first._read(dec), second._read(dec)]).toEqual([
      'a',
      'b',
      'a',
      'a',
    ]);
    dec.finalize();
  });

  it('starts every message empty', () => {
    const node = strings();
    const once = tripAll(node, ['a', 'b', 'a']).bytes;
    expect(tripAll(node, ['a', 'b', 'a']).bytes).toEqual(once);
    const enc = new Encoder();
    p.string()._write(enc, 'b');
    expect(tripAll(node, ['b']).bytes).toEqual(enc.output());
  });
});
