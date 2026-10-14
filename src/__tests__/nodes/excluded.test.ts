/**
 * Exclusion: the set of ruled-out members, a table's buckets with them
 * taken out, and the weighted symbols written and read under it.
 */

import { Encoder, Decoder, CorruptInputError } from '../../packer';
import { AdaptiveTable, writeLive } from '../../nodes/adaptive';
import {
  Exclusion,
  excludedBucket,
  readExcluded,
  staticTable,
  writeExcluded,
  type Table,
} from '../../nodes/excluded';
import { Fenwick } from '../../nodes/fenwick';
import { buildWeights } from '../../nodes/weights';
import { mulberry32 } from '../support';

const empty = (): Uint8Array => new Encoder().output();

describe('Exclusion', () => {
  it('refuses a size that is not a non-negative integer', () => {
    expect(() => new Exclusion(1.5)).toThrow(
      new TypeError('Exclusion size must be an integer, got 1.5')
    );
    expect(() => new Exclusion(NaN)).toThrow(TypeError);
    expect(() => new Exclusion(-1)).toThrow(new RangeError('Exclusion size -1 is negative'));
    expect(new Exclusion(0).size).toBe(0);
  });

  it('adds members once each, in order, and clears them all', () => {
    const exclusion = new Exclusion(5);
    expect(exclusion.size).toBe(5);
    expect(exclusion.count).toBe(0);
    exclusion.add(3);
    exclusion.add(0);
    exclusion.add(3);
    expect(exclusion.count).toBe(2);
    expect(exclusion.members).toEqual([3, 0]);
    expect([0, 1, 2, 3, 4].map((pos) => exclusion.has(pos))).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
    exclusion.clear();
    expect(exclusion.count).toBe(0);
    expect(exclusion.members).toEqual([]);
    expect(exclusion.has(3)).toBe(false);
    exclusion.add(4);
    expect(exclusion.members).toEqual([4]);
  });

  it('holds no member outside its range', () => {
    const exclusion = new Exclusion(2);
    for (const pos of [-1, 2, 0.5, NaN]) {
      expect(exclusion.has(pos)).toBe(false);
    }
  });

  it.each([-1, 3, 0.5, NaN, Infinity])('refuses to add %p', (pos) => {
    expect(() => new Exclusion(3).add(pos)).toThrow(
      new RangeError(`Excluded member ${pos} is outside [0, 3)`)
    );
  });
});

describe('staticTable', () => {
  it('shows a weight table as a table, refusing positions outside it', () => {
    const table = staticTable(buildWeights([2, 1, 5], 3, 'w'));
    expect(table.size).toBe(3);
    expect(table.total).toBe(8);
    expect([0, 1, 2].map((pos) => [table.cum(pos), table.freq(pos)])).toEqual([
      [0, 2],
      [2, 1],
      [3, 5],
    ]);
    for (const pos of [3, -1, 0.5]) {
      const message = `Position ${pos} is not one of the table's 3 entries`;
      expect(() => table.cum(pos)).toThrow(new RangeError(message));
      expect(() => table.freq(pos)).toThrow(new RangeError(message));
    }
  });
});

describe('excludedBucket', () => {
  it('takes the excluded widths out of a Fenwick', () => {
    // Counts 3, 0, 1, 0, 5: starts 0, 3, 3, 4, 4 of 9.
    const table = new Fenwick([3, 0, 1, 0, 5]);
    expect(excludedBucket(table, undefined, 4)).toEqual([4, 5, 9]);
    const exclusion = new Exclusion(5);
    expect(excludedBucket(table, exclusion, 4)).toEqual([4, 5, 9]);
    exclusion.add(0);
    expect(excludedBucket(table, exclusion, 0)).toEqual([0, 0, 6]);
    expect(excludedBucket(table, exclusion, 2)).toEqual([0, 1, 6]);
    expect(excludedBucket(table, exclusion, 4)).toEqual([1, 5, 6]);
    exclusion.add(1);
    exclusion.add(4);
    expect(excludedBucket(table, exclusion, 2)).toEqual([0, 1, 1]);
    expect(excludedBucket(table, exclusion, 4)).toEqual([1, 0, 1]);
  });

  it('takes the excluded widths out of a static table', () => {
    const table = staticTable(buildWeights([2, 1, 5], 3, 'w'));
    const exclusion = new Exclusion(3);
    exclusion.add(1);
    expect(excludedBucket(table, exclusion, 0)).toEqual([0, 2, 7]);
    expect(excludedBucket(table, exclusion, 1)).toEqual([2, 0, 7]);
    expect(excludedBucket(table, exclusion, 2)).toEqual([2, 5, 7]);
  });
});

describe('writeExcluded and readExcluded', () => {
  it('write what writeLive writes without an exclusion', () => {
    const adaptive = new AdaptiveTable([4, 1, 2, 7], 4, 3, 64, 'w');
    const positions = [3, 0, 3, 1, 2, 3, 3, 0];
    const live = adaptive.live(new Encoder());
    const a = new Encoder();
    const b = new Encoder();
    for (const pos of positions) {
      writeLive(a, live, pos);
      writeExcluded(b, live, undefined, pos);
      live.learn(pos);
    }
    expect(b.output()).toEqual(a.output());
    const fenwick = new Fenwick([3, 0, 1, 0, 5]);
    const c = new Encoder();
    const d = new Encoder();
    for (const pos of [4, 0, 2, 4]) {
      writeLive(c, fenwick, pos);
      writeExcluded(d, fenwick, undefined, pos);
    }
    expect(d.output()).toEqual(c.output());
  });

  it.each([
    ['a Fenwick with empty buckets', () => new Fenwick([3, 0, 1, 0, 5, 2, 0, 9])],
    ['a static table', () => staticTable(buildWeights([2, 1, 5, 1, 1, 3, 8, 2], 8, 'w'))],
  ])('round-trip members of %s with members excluded', (_name, build) => {
    const table: Table = build();
    const random = mulberry32(table.total);
    const live = [...Array(table.size).keys()].filter((pos) => table.freq(pos) > 0);
    const cases = Array.from({ length: 300 }, () => {
      const pos = live[Math.floor(random() * live.length)];
      const excluded = live.filter((other) => other !== pos && random() < 0.4);
      return { pos, excluded };
    });
    const exclusion = new Exclusion(table.size);
    const enc = new Encoder();
    for (const { pos, excluded } of cases) {
      exclusion.clear();
      excluded.forEach((other) => exclusion.add(other));
      writeExcluded(enc, table, exclusion, pos);
    }
    const dec = new Decoder(enc.output());
    const read = cases.map(({ excluded }) => {
      exclusion.clear();
      excluded.forEach((other) => exclusion.add(other));
      return readExcluded(dec, table, exclusion);
    });
    dec.finalize();
    expect(read).toEqual(cases.map(({ pos }) => pos));
  });

  it('write nothing for a bucket holding every state, and read its member back', () => {
    const lone = new Fenwick([0, 4, 0]);
    const enc = new Encoder();
    writeExcluded(enc, lone, undefined, 1);
    const table = staticTable(buildWeights([2, 1, 5], 3, 'w'));
    const exclusion = new Exclusion(3);
    exclusion.add(0);
    exclusion.add(2);
    writeExcluded(enc, table, exclusion, 1);
    expect(enc.output()).toEqual(empty());
    const dec = new Decoder(empty());
    expect(readExcluded(dec, lone, undefined)).toBe(1);
    expect(readExcluded(dec, table, exclusion)).toBe(1);
    dec.finalize();
  });

  it('refuses to write an excluded member', () => {
    const table = staticTable(buildWeights([2, 1, 5], 3, 'w'));
    const exclusion = new Exclusion(3);
    exclusion.add(1);
    expect(() => writeExcluded(new Encoder(), table, exclusion, 1)).toThrow(RangeError);
  });

  it('refuses the index of an excluded member as corrupt', () => {
    // A total past one byte as a bucket: a lone value goes out as its index.
    const table = staticTable(buildWeights([500, 1, 1], 3, 'w'));
    const enc = new Encoder();
    writeExcluded(enc, table, undefined, 1);
    const bytes = enc.output();
    expect(bytes).toEqual(Uint8Array.of(1));
    expect(readExcluded(new Decoder(bytes), table, undefined)).toBe(1);
    const exclusion = new Exclusion(3);
    exclusion.add(1);
    expect(() => readExcluded(new Decoder(enc.output()), table, exclusion)).toThrow(
      new CorruptInputError('Index of a value with no weight')
    );
  });
});
