/**
 * Structure symbols of declared schemas: the first symbol of a value's spelling and declared
 * weights as prior counts of those symbols.
 */

import { p, Encoder, Decoder } from '../../index';
import {
  kindMarker,
  markerOfKind,
  markerPrior,
  ownMarker,
  readOwnMarker,
  unionOf,
} from '../../nodes/markers';
import { kindMarker as anyKindMarker } from '../../nodes/any';
import { resolve } from '../../predictor/options';
import { loadedPriors } from '../../predictor/prior';
import { STRUCT } from '../../predictor/types';

describe('kindMarker', () => {
  it('tells numbers that travel as integers from the rest', () => {
    expect(kindMarker(0)).toBe(STRUCT.INT);
    expect(kindMarker(-42)).toBe(STRUCT.INT);
    expect(kindMarker(Number.MAX_SAFE_INTEGER)).toBe(STRUCT.INT);
    expect(kindMarker(-0)).toBe(STRUCT.NUM);
    expect(kindMarker(1.5)).toBe(STRUCT.NUM);
    expect(kindMarker(2 ** 60)).toBe(STRUCT.NUM);
    expect(kindMarker(NaN)).toBe(STRUCT.NUM);
    expect(kindMarker(Infinity)).toBe(STRUCT.NUM);
  });

  it('tells booleans apart by value', () => {
    expect(kindMarker(true)).toBe(STRUCT.TRUE);
    expect(kindMarker(false)).toBe(STRUCT.FALSE);
  });

  it('names every other kind', () => {
    expect(kindMarker('x')).toBe(STRUCT.STR);
    expect(kindMarker(null)).toBe(STRUCT.NULL);
    expect(kindMarker(undefined)).toBe(STRUCT.UNDEFINED);
    expect(kindMarker(new Date(0))).toBe(STRUCT.DATE);
    expect(kindMarker(1n)).toBe(STRUCT.BIGINT);
    expect(kindMarker(/a/)).toBe(STRUCT.REGEXP);
    expect(kindMarker(new Map())).toBe(STRUCT.MAP_START);
    expect(kindMarker(new Set())).toBe(STRUCT.SET_START);
    expect(kindMarker([])).toBe(STRUCT.ARR_START);
    expect(kindMarker({})).toBe(STRUCT.OBJ_START);
    expect(kindMarker(new ArrayBuffer(1))).toBe(STRUCT.BUFFER);
    expect(kindMarker(new DataView(new ArrayBuffer(1)))).toBe(STRUCT.DATAVIEW);
  });

  it('numbers the typed arrays in p.any tag order, Buffer as a Uint8Array', () => {
    const arrays = [
      new Int8Array(1),
      new Uint8Array(1),
      new Uint8ClampedArray(1),
      new Int16Array(1),
      new Uint16Array(1),
      new Int32Array(1),
      new Uint32Array(1),
      new Float32Array(1),
      new Float64Array(1),
      new BigInt64Array(1),
      new BigUint64Array(1),
    ];
    arrays.forEach((array, i) => expect(kindMarker(array)).toBe(STRUCT.TYPED_0 + i));
    expect(kindMarker(Buffer.from([1]))).toBe(STRUCT.TYPED_0 + 1);
    const Float16 = (globalThis as { Float16Array?: new (n: number) => ArrayBufferView })
      .Float16Array;
    if (Float16 !== undefined) {
      expect(kindMarker(new Float16(1))).toBe(STRUCT.TYPED_0 + 11);
    }
  });

  it('gives kinds no other symbol takes the object start', () => {
    expect(kindMarker(() => 1)).toBe(STRUCT.OBJ_START);
    expect(kindMarker(Symbol('s'))).toBe(STRUCT.OBJ_START);
  });
});

describe('p.any', () => {
  it('classifies values by the structure symbols its tags stand for', () => {
    expect(anyKindMarker).toBe(kindMarker);
  });
});

describe('markerOfKind', () => {
  it('names a kind by its symbol, the object start for any other', () => {
    expect(markerOfKind('string')).toBe(STRUCT.STR);
    expect(markerOfKind('array')).toBe(STRUCT.ARR_START);
    expect(markerOfKind('Float64Array')).toBe(STRUCT.TYPED_0 + 8);
    expect(markerOfKind('object')).toBe(STRUCT.OBJ_START);
    expect(markerOfKind('function')).toBe(STRUCT.OBJ_START);
  });
});

describe('unionOf', () => {
  it('joins the members’ symbols', () => {
    expect(unionOf([p.bool(), p.optional(p.int())])).toEqual(
      new Set([STRUCT.TRUE, STRUCT.FALSE, STRUCT.KEY, STRUCT.NOKEY])
    );
    expect(unionOf([])).toEqual(new Set());
  });

  it('is unknown when one member may spell any', () => {
    expect(unionOf([p.bool(), p.any()])).toBeUndefined();
  });
});

describe('markerPrior', () => {
  const key = {};
  const sum = (counts: readonly (readonly [number, number])[]) =>
    counts.reduce((total, [, count]) => total + count, 0);

  it('is undefined without weights', () => {
    expect(markerPrior(key, undefined, [new Set([STRUCT.STR])])).toBeUndefined();
  });

  it('scales the weights to about 16 per symbol, ascending by symbol', () => {
    const prior = markerPrior(key, [3, 1], [new Set([STRUCT.FALSE]), new Set([STRUCT.TRUE])]);
    expect(prior?.key).toBe(key);
    expect(prior?.counts).toEqual([
      [STRUCT.TRUE, 8],
      [STRUCT.FALSE, 24],
    ]);
  });

  it('spreads a weight evenly over the symbols its member spells', () => {
    const prior = markerPrior(
      key,
      [2, 2],
      [new Set([STRUCT.INT, STRUCT.NUM]), new Set([STRUCT.STR])]
    );
    expect(prior?.counts).toEqual([
      [STRUCT.STR, 24],
      [STRUCT.INT, 12],
      [STRUCT.NUM, 12],
    ]);
    expect(sum(prior?.counts ?? [])).toBe(48);
  });

  it('skips members of unknown or no symbols', () => {
    const prior = markerPrior(key, [5, 5, 5], [undefined, new Set(), new Set([STRUCT.STR])]);
    expect(prior?.counts).toEqual([[STRUCT.STR, 16]]);
  });

  it('keeps every positive weight at a count of at least 1 and drops zero weights', () => {
    const prior = markerPrior(
      key,
      [1e9, 1, 0],
      [new Set([STRUCT.STR]), new Set([STRUCT.INT]), new Set([STRUCT.NULL])]
    );
    expect(prior?.counts).toEqual([
      [STRUCT.STR, 47],
      [STRUCT.INT, 1],
    ]);
  });
});

describe('ownMarker', () => {
  const o = resolve({}, loadedPriors.text, 'test');

  it('codes the symbol at the node when no parent coded one, and reads it back', () => {
    const node = p.bool();
    const enc = new Encoder();
    expect(ownMarker(enc, node, o, STRUCT.FALSE)).toBe(STRUCT.FALSE);
    expect(readOwnMarker(new Decoder(enc.output()), node, o)).toBe(STRUCT.FALSE);
  });

  it('takes the symbol a parent coded for the node', () => {
    const Schema = p.object({ on: p.bool(), off: p.bool() }).compress();
    const value = { on: true, off: false };
    expect(Schema.decode(Schema.encode(value))).toEqual(value);
  });
});
