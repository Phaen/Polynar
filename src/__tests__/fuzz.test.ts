/**
 * Property fuzz over randomly generated schemas and values: round-trip
 * identity (decode(encode(v)) equals v), canonical closure (bytes that decode
 * at all re-encode to exactly themselves, so no value has a second wire
 * spelling), and agreement of the block bound's fast regimes with its exact
 * one (the same bytes when every block is bounded with exact arithmetic from
 * its first symbol). Checked over bytes and text in charsets of unusual
 * sizes and at several block sizes, and against corrupted inputs (truncation,
 * padding, a replaced code, a code outside the charset). The cases come from
 * ./random-schemas under a fixed seed, so every run exercises the same cases
 * and a failure is reproducible. FUZZ scales the iteration counts.
 */

import * as lib from '../index';
import type { CodecOptions, PNode } from '../index';
import { setExactOnly } from '../packer/bound';
import { mulberry32 } from './support';
import { corruptions, rand, randOpts, randomCase, useRng } from './random-schemas';
import type { Opts } from './random-schemas';

const SCALE = Math.max(0, Number(process.env.FUZZ ?? 1));
const runs = (n: number): number => Math.max(1, Math.round(n * SCALE));

useRng(mulberry32(0x5eed));

/** A random schema built against the working tree, with values for it. */
const randomNode = (): { node: PNode<unknown>; gen: () => unknown; migrates: boolean } => {
  const c = randomCase(2);
  return { node: c.build(lib), gen: c.gen, migrates: c.migrates ?? false };
};

const encodeWith = (node: PNode<unknown>, value: unknown, o: Opts): Uint8Array | string =>
  o.type === 'text'
    ? node.encode(value, o as CodecOptions<'text'>)
    : node.encode(value, o as CodecOptions<'binary'>);

const decodeWith = (node: PNode<unknown>, input: Uint8Array | string, o: Opts): unknown =>
  typeof input === 'string'
    ? node.decode(input, o as CodecOptions<'text'>)
    : node.decode(input, o as CodecOptions<'binary'>);

/** Runs `fn` with every block bounded by exact arithmetic from its first symbol. */
const exactly = <T>(fn: () => T): T => {
  setExactOnly(true);
  try {
    return fn();
  } finally {
    setExactOnly(false);
  }
};

/**
 * Corrupted input either throws or decodes to a value whose canonical
 * encoding it is; under a migration only the first half holds.
 */
const expectRejectedOrOwned = (
  { node, migrates }: { node: PNode<unknown>; migrates: boolean },
  encoded: Uint8Array | string,
  o: Opts
) => {
  for (const { input } of corruptions(encoded, o)) {
    let decoded: unknown;
    try {
      decoded = decodeWith(node, input, o);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      continue;
    }
    if (!migrates) {
      expect(encodeWith(node, decoded, o)).toEqual(input);
    }
  }
};

describe('Property fuzz', () => {
  it('round-trips and re-encodes canonically over random schemas', () => {
    for (let i = 0; i < runs(1000); i++) {
      const { node, gen } = randomNode();
      const value = gen();
      const bytes = node.encode(value as never);
      const decoded = node.decode(bytes);
      expect(decoded).toEqual(value);
      // Canonical closure: our own output re-encodes to itself, byte for byte.
      expect(node.encode(decoded as never)).toEqual(bytes);
    }
  });

  it('writes the bytes of the exact block bound, over every transport and block size', () => {
    for (let i = 0; i < runs(600); i++) {
      const { node, gen } = randomNode();
      const value = gen();
      const o = randOpts();
      const output = encodeWith(node, value, o);
      expect(exactly(() => encodeWith(node, value, o))).toEqual(output);
      expect(decodeWith(node, output, o)).toEqual(value);
      expect(exactly(() => decodeWith(node, output, o))).toEqual(value);
    }
  });

  it('corrupted bytes either throw or decode to something that owns those bytes', () => {
    for (let i = 0; i < runs(1000); i++) {
      const c = randomNode();
      const o: Opts = { type: 'binary' };
      expectRejectedOrOwned(c, encodeWith(c.node, c.gen(), o), o);
    }
  });

  it('round-trips through the text transport and rejects corrupted text', () => {
    for (let i = 0; i < runs(500); i++) {
      const c = randomNode();
      const { node } = c;
      const o = randOpts('text');
      const value = c.gen();
      const str = encodeWith(node, value, o);
      const decoded = decodeWith(node, str, o);
      expect(decoded).toEqual(value);
      expect(encodeWith(node, decoded, o)).toBe(str);
      expectRejectedOrOwned(c, str, o);
    }
  });

  it('checksummed messages round-trip, re-encode canonically and reject or own corrupted input', () => {
    for (let i = 0; i < runs(400); i++) {
      const c = randomNode();
      const o = { ...randOpts(), checksum: 1 + Math.floor(rand() * 32) };
      const value = c.gen();
      const output = encodeWith(c.node, value, o);
      const decoded = decodeWith(c.node, output, o);
      expect(decoded).toEqual(value);
      expect(encodeWith(c.node, decoded, o)).toEqual(output);
      expectRejectedOrOwned(c, output, o);
    }
  });

  it('lets a corrupted message past a 16-bit checksum well under one time in a hundred', () => {
    const node = lib.p.array(lib.p.int().min(0).max(255)).max(64);
    const o: Opts = { type: 'binary' };
    const withSum = { ...o, checksum: 16 };
    let corrupted = 0;
    let missed = 0;
    for (let i = 0; i < runs(300); i++) {
      const value = Array.from({ length: Math.floor(rand() * 65) }, () => Math.floor(rand() * 256));
      const encoded = encodeWith(node as PNode<unknown>, value, withSum);
      for (const { input } of corruptions(encoded, o)) {
        corrupted++;
        try {
          decodeWith(node as PNode<unknown>, input, withSum);
          missed++;
        } catch {
          // rejected
        }
      }
    }
    expect(missed / corrupted).toBeLessThan(0.01);
  });
});
