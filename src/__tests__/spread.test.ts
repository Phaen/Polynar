/**
 * The spread map's integer walks for `bits` up to 31 against the general
 * walks, over random arguments and the edges of every width. Seeded, so
 * failures reproduce.
 */

import {
  firstReaching,
  reverse,
  reverseNarrow,
  reverseWide,
  visitsBelow,
  visitsBelowNarrow,
  visitsBelowWide,
} from '../packer/spread';
import { mulberry32 } from './support';

const rand = mulberry32(0x5b4ead);
const below = (n: number): number => Math.floor(rand() * n);

/** Values in [0, 2^bits): the edges and random ones. */
function samples(bits: number): number[] {
  const top = 2 ** bits;
  const out = [0, 1, top - 1, top - 2, Math.floor(top / 2), Math.floor(top / 2) - 1];
  for (let i = 0; i < 12; i++) out.push(below(top));
  return out.filter((v) => v >= 0 && v < top);
}

describe('spread walks', () => {
  it('reverses the same under integer operations for bits 1..31', () => {
    for (let bits = 1; bits <= 31; bits++) {
      for (const n of samples(bits)) {
        expect(reverseNarrow(n, bits)).toBe(reverseWide(n, bits));
      }
    }
  });

  it('counts visits the same under integer operations for bits 1..31', () => {
    for (let bits = 1; bits <= 31; bits++) {
      const values = samples(bits);
      for (const end of values) {
        for (const limit of values) {
          expect(visitsBelowNarrow(end, limit, bits)).toBe(visitsBelowWide(end, limit, bits));
        }
      }
    }
  });

  it('dispatches by width and counts every n below a limit past the residuals', () => {
    expect(reverse(6, 3)).toBe(3);
    expect(reverse(2 ** 40 + 1, 41)).toBe(2 ** 40 + 1);
    expect(reverse(2 ** 31, 32)).toBe(1);
    expect(visitsBelow(5, 8, 3)).toBe(5);
    expect(visitsBelow(5, 4, 3)).toBe(visitsBelowNarrow(5, 4, 3));
    expect(visitsBelow(2 ** 40 + 3, 2 ** 39, 41)).toBe(visitsBelowWide(2 ** 40 + 3, 2 ** 39, 41));
  });

  it('finds the first n reaching a target across gaps on both sides of 2^32', () => {
    for (const hi of [1, 2, 7, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 40, 2 ** 53]) {
      for (const target of [0, 1, Math.floor(hi / 3), hi - 1, hi]) {
        expect(firstReaching(0, hi, target, (n) => n)).toBe(Math.min(target, hi));
      }
    }
  });
});
