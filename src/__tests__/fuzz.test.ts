/**
 * Property fuzz over randomly generated schemas and values: round-trip
 * identity (decode(encode(v)) equals v) and canonical closure (bytes that
 * decode at all re-encode to exactly themselves, but for a migration or an
 * adaptive prior's selector, which re-encode to bytes of the same value).
 * Checked over bytes and text in charsets of unusual sizes. The decoder
 * does not verify its input, so corrupted inputs (truncation, padding, a
 * replaced code, a code outside the charset) are checked under a checksum,
 * which rejects them. The cases come from
 * ./random-schemas under a fixed seed, so every run exercises the same cases
 * and a failure is reproducible. FUZZ scales the iteration counts.
 */

import * as lib from '../index';
import type { CodecOptions, PNode } from '../index';
import { mulberry32 } from './support';
import { corruptions, rand, randOpts, randomCase, useRng } from './random-schemas';
import type { Opts } from './random-schemas';

const SCALE = Math.max(0, Number(process.env.FUZZ ?? 1));
const runs = (n: number): number => Math.max(1, Math.round(n * SCALE));

useRng(mulberry32(0x5eed));

interface Fuzzed {
  node: PNode<unknown>;
  gen: () => unknown;
}

/** A random schema built against the working tree, with values for it. */
const randomNode = (): Fuzzed => {
  const c = randomCase(2);
  return { node: c.build(lib), gen: c.gen };
};

const encodeWith = (node: PNode<unknown>, value: unknown, o: Opts): Uint8Array | string =>
  o.type === 'text'
    ? node.encode(value, o as CodecOptions<'text'>)
    : node.encode(value, o as CodecOptions<'binary'>);

const decodeWith = (node: PNode<unknown>, input: Uint8Array | string, o: Opts): unknown =>
  typeof input === 'string'
    ? node.decode(input, o as CodecOptions<'text'>)
    : node.decode(input, o as CodecOptions<'binary'>);

/** Every corruption of `encoded` throws a CorruptInputError. */
const expectRejected = ({ node }: Fuzzed, encoded: Uint8Array | string, o: Opts) => {
  for (const { input } of corruptions(encoded, o)) {
    expect(() => decodeWith(node, input, o)).toThrow(lib.CorruptInputError);
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

  it('migrates data of an older version to what the newest decodes, or throws as encoding would', () => {
    for (let i = 0; i < runs(300); i++) {
      const first = randomCase(1);
      const newest = randomCase(1);
      const fixed = newest.gen();
      const firstNode = first.build(lib) as PNode<unknown>;
      const old = lib.p.versioned(firstNode).encode(first.gen());
      const New = lib.p.versioned(firstNode, [newest.build(lib) as PNode<unknown>, () => fixed]);
      const decoded = New.decode(old);
      expect(decoded).toEqual(fixed);
      expect(New.encode(decoded)).toEqual(New.encode(fixed));

      const Bad = lib.p.versioned(firstNode, [lib.p.int().min(0).max(9), () => 10]);
      let error: unknown;
      try {
        Bad.decode(old);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RangeError);
      expect(error).not.toBeInstanceOf(lib.CorruptInputError);
      expect((error as Error).message).toBe(
        'Value 10 is above the maximum 9, in data migrated from version 1 to 2'
      );
    }
  });

  it('round-trips over every transport', () => {
    for (let i = 0; i < runs(600); i++) {
      const { node, gen } = randomNode();
      const value = gen();
      const o = randOpts();
      const output = encodeWith(node, value, o);
      expect(decodeWith(node, output, o)).toEqual(value);
      expect(encodeWith(node, value, o)).toEqual(output);
    }
  });

  it('round-trips through the text transport and re-encodes canonically', () => {
    for (let i = 0; i < runs(500); i++) {
      const c = randomNode();
      const { node } = c;
      const o = randOpts('text');
      const value = c.gen();
      const str = encodeWith(node, value, o);
      const decoded = decodeWith(node, str, o);
      expect(decoded).toEqual(value);
      expect(encodeWith(node, decoded, o)).toBe(str);
    }
  });

  it('checksummed messages round-trip and re-encode canonically', () => {
    for (let i = 0; i < runs(400); i++) {
      const c = randomNode();
      const o = { ...randOpts(), checksum: 1 + Math.floor(rand() * 32) };
      const value = c.gen();
      const output = encodeWith(c.node, value, o);
      const decoded = decodeWith(c.node, output, o);
      expect(decoded).toEqual(value);
      expect(encodeWith(c.node, decoded, o)).toEqual(output);
    }
  });

  it('rejects corrupted bytes and text under a 32-bit checksum', () => {
    for (let i = 0; i < runs(1000); i++) {
      const c = randomNode();
      const o = { ...randOpts(), checksum: 32 };
      expectRejected(c, encodeWith(c.node, c.gen(), o), o);
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
