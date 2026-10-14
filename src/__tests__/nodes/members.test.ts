/**
 * The three spellings of a node's members: uniform, a static prior and an
 * adaptive one.
 */

import { Encoder, Decoder } from '../../packer';
import { members, type Members } from '../../nodes/members';
import { writeTable, readTable, buildWeights } from '../../nodes/weights';
import { mulberry32 } from '../support';

const roundTrip = (spelling: Members, positions: number[]): number[] => {
  const enc = new Encoder();
  for (const pos of positions) {
    spelling.write(enc, pos);
  }
  const dec = new Decoder(enc.output());
  const out = positions.map(() => spelling.read(dec));
  dec.finalize();
  return out;
};

const seeded = (seed: number, length: number, count: number): number[] => {
  const random = mulberry32(seed);
  return Array.from({ length }, () => (random() < 0.8 ? 1 : Math.floor(random() * count)));
};

const adaptation = { window: 1024 };

describe('members', () => {
  it.each([
    ['uniform', undefined],
    ['uniform, an empty prior', {}],
    ['static', { weights: [1, 5, 2, 2] }],
    ['adaptive', { adaptive: adaptation }],
    ['adaptive from weights', { weights: [1, 5, 2, 2], adaptive: adaptation }],
  ])('round-trips the %s spelling', (_name, prior) => {
    const spelling = members(4, prior, 'w');
    expect(spelling.count).toBe(4);
    const positions = seeded(4, 200, 4);
    expect(roundTrip(spelling, positions)).toEqual(positions);
  });

  it('spells uniformly as one digit, exposing the radix', () => {
    const spelling = members(5, undefined, 'w');
    expect(spelling.radix).toBe(5);
    const enc = new Encoder();
    spelling.write(enc, 3);
    const plain = new Encoder();
    plain.compose(3, 5);
    expect(enc.output()).toEqual(plain.output());
    expect(() => spelling.write(new Encoder(), 5)).toThrow(RangeError);
  });

  it('spells a static prior as its weight table, without a radix', () => {
    const spelling = members(3, { weights: [1, 2, 3] }, 'w');
    expect(spelling.radix).toBeUndefined();
    const enc = new Encoder();
    spelling.write(enc, 2);
    const plain = new Encoder();
    writeTable(plain, buildWeights([1, 2, 3], 3, 'w'), 2);
    expect(enc.output()).toEqual(plain.output());
  });

  it('spells an adaptive prior without a radix, picking its spelling per message', () => {
    const spelling = members(4, { adaptive: adaptation }, 'w');
    expect(spelling.radix).toBeUndefined();
    const enc = new Encoder();
    for (let i = 0; i < 500; i++) {
      spelling.write(enc, 2);
    }
    const bytes = enc.output();
    const dec = new Decoder(bytes);
    // The first value is static, the selector follows it.
    expect(readTable(dec, buildWeights([1, 1, 1, 1], 4, 'w'))).toBe(2);
    expect(dec.parse(2)).toBe(1);
    expect(bytes.length).toBeLessThan(20);
  });

  it.each([
    [1.5, TypeError, 'w weights need a whole number of values, got 1.5'],
    [NaN, TypeError, 'w weights need a whole number of values, got NaN'],
    [0, RangeError, 'w weights need at least one value, got 0'],
    [-3, RangeError, 'w weights need at least one value, got -3'],
  ])('refuses a count of %p under every prior', (count, kind, message) => {
    for (const prior of [undefined, { weights: [1] }, { adaptive: adaptation }]) {
      expect(() => members(count, prior, 'w')).toThrow(new kind(message));
    }
  });

  it('refuses weights of the wrong length or kind', () => {
    for (const extra of [{}, { adaptive: adaptation }]) {
      expect(() => members(3, { weights: [1, 2], ...extra }, 'w')).toThrow(
        new TypeError('w weights must list one weight per value: expected 3, got 2')
      );
      expect(() => members(2, { weights: [1, 0], ...extra }, 'w')).toThrow(
        new TypeError('w weights must be positive integers, got 0')
      );
    }
  });

  it('validates the adaptive options, an empty set taking the defaults', () => {
    expect(() => members(2, { adaptive: { window: 0 } }, 'w')).toThrow(
      new RangeError('w adaptive window must be a positive integer, got 0')
    );
    expect(() => members(2, { adaptive: { window: 1.5 } }, 'w')).toThrow(
      new TypeError('w adaptive window must be a positive integer, got 1.5')
    );
    const positions = seeded(5, 50, 2);
    expect(roundTrip(members(2, { adaptive: {} }, 'w'), positions)).toEqual(positions);
  });

  it('refuses an adaptive prior over too many members', () => {
    expect(() => members(2 ** 40, { adaptive: adaptation }, 'w')).toThrow(
      new RangeError(`w adaptive prior spans ${2 ** 40} values, above the limit 65536`)
    );
    expect(members(65536, { adaptive: {} }, 'w').count).toBe(65536);
  });

  it('refuses an adaptation that overflows with the weights', () => {
    expect(() => members(2, { weights: [2 ** 50, 1], adaptive: adaptation }, 'w')).toThrow(
      new RangeError(
        `w adaptive prior 4 and window 1024 overflow with weights totalling ${2 ** 50 + 1}`
      )
    );
  });
});
