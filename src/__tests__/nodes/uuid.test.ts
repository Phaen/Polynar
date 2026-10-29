/**
 * `p.uuid()`: lowercase 8-4-4-4-12 hex UUID strings.
 */

import { webcrypto } from 'node:crypto';
import { p, type AnyValue } from '../../index';
import { STRUCT } from '../../predictor/types';
import { mulberry32, trip } from '../support';

const random = mulberry32(7);

/** A random UUID of `version` with the RFC 4122 variant. */
function uuidOf(version: number): string {
  const bytes = Uint8Array.from({ length: 16 }, () => Math.floor(random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | (version << 4);
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const v4s = Array.from({ length: 64 }, () => webcrypto.randomUUID());

describe('p.uuid', () => {
  it.each([
    ['v4', webcrypto.randomUUID()],
    ['v1', uuidOf(1)],
    ['v7', uuidOf(7)],
    ['v0', uuidOf(0)],
    ['vf', uuidOf(15)],
    ['nil', '00000000-0000-0000-0000-000000000000'],
    ['max', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
    ['other variant', '123e4567-e89b-12d3-c456-426614174000'],
    ['NCS variant', '123e4567-e89b-12d3-3456-426614174000'],
  ])('round-trips a %s UUID', (_name, value) => {
    expect(trip(p.uuid(), value)).toBe(value);
  });

  it('round-trips every version and variant nibble', () => {
    for (let v = 0; v < 16; v++) {
      for (let n = 0; n < 16; n++) {
        const value = `0123abcd-ef01-${v.toString(16)}234-${n.toString(16)}678-9abcdef01234`;
        expect(trip(p.uuid(), value)).toBe(value);
      }
    }
  });

  it('round-trips a run of random v4 UUIDs', () => {
    expect(trip(p.array(p.uuid()), v4s)).toEqual(v4s);
  });

  it.each<[string, unknown, string]>([
    ['uppercase', 'F47AC10B-58CC-4372-A567-0E02B2C3D479', '"F47AC10B-58CC-4372-A567-0E02B2C3D479"'],
    ['too short', 'f47ac10b-58cc-4372-a567-0e02b2c3d47', '"f47ac10b-58cc-4372-a567-0e02b2c3d47"'],
    ['without dashes', 'f47ac10b58cc4372a5670e02b2c3d479', '"f47ac10b58cc4372a5670e02b2c3d479"'],
    ['non-hex', 'g47ac10b-58cc-4372-a567-0e02b2c3d479', '"g47ac10b-58cc-4372-a567-0e02b2c3d479"'],
    ['a number', 42, '42'],
  ])('refuses %s', (_name, value, shown) => {
    expect(() => p.uuid().encode(value as string)).toThrow(
      new RangeError(`Value ${shown} is not a lowercase UUID`)
    );
  });

  it('codes a run of v4 UUIDs in fewer bytes under .learn()', () => {
    const learned = p.array(p.uuid().learn());
    expect(trip(learned, v4s)).toEqual(v4s);
    expect(learned.encode(v4s).length).toBeLessThan(p.array(p.uuid()).encode(v4s).length);
  });

  it('takes the learning options', () => {
    const node = p.array(p.uuid().learn({ window: 4, separate: true }));
    expect(trip(node, v4s)).toEqual(v4s);
  });

  it('learns both tables under .adaptive()', () => {
    const plain = p.array(p.uuid()).encode(v4s).length;
    for (const node of [p.uuid().adaptive(), p.uuid().adaptive({ separate: true })]) {
      const list = p.array(node);
      expect(trip(list, v4s)).toEqual(v4s);
      expect(list.encode(v4s).length).toBeLessThan(plain);
    }
    // A run of RFC 4122 v7 UUIDs is cheaper once the version table learns 7.
    const v7s = Array.from({ length: 64 }, () => uuidOf(7));
    expect(p.array(p.uuid().adaptive()).encode(v7s).length).toBeLessThan(
      p.array(p.uuid()).encode(v7s).length
    );
  });

  it.each<[string, () => unknown, string]>([
    ['.learn() twice', () => p.uuid().learn().learn(), 'p.uuid learn is already set'],
    ['.adaptive() twice', () => p.uuid().adaptive().adaptive(), 'p.uuid adaptive is already set'],
    [
      '.learn() then .adaptive()',
      () => p.uuid().learn().adaptive(),
      'p.uuid learn and adaptive cannot both be set',
    ],
    [
      '.adaptive() then .learn()',
      () => p.uuid().adaptive().learn(),
      'p.uuid learn and adaptive cannot both be set',
    ],
  ])('refuses %s', (_name, build, message) => {
    expect(build).toThrow(new TypeError(message));
  });

  it('spells its values as strings to a parent on the predictor', () => {
    expect([...p.uuid()._markers()]).toEqual([STRUCT.STR]);
    expect(p.uuid()._marker(v4s[0])).toBe(STRUCT.STR);
  });

  it('adapts under _adapted unless it learns or adapts already', () => {
    const adapted = p.uuid()._adapted({});
    expect(adapted._adaptive).toEqual({});
    const learned = p.uuid().learn();
    expect(learned._adapted({})).toBe(learned);
    const own = p.uuid().adaptive({ separate: true });
    expect(own._adapted({})).toBe(own);
  });

  it('round-trips under an adaptive object', () => {
    const node = p.object({ id: p.uuid(), n: p.int() }).adaptive();
    const rows = p.array(node);
    const value = v4s.slice(0, 8).map((id, n) => ({ id, n }));
    expect(trip(rows, value)).toEqual(value);
    expect(trip(node, { id: uuidOf(7), n: 1 }).n).toBe(1);
  });

  it.each([
    ['p.any', () => p.any([p.uuid()])],
    ['p.any().adaptive()', () => p.any([p.uuid()]).adaptive()],
  ])('is a hint to %s for UUID strings and not other strings', (_name, make) => {
    const node = make();
    expect(node._marker(v4s[0])).toBe(STRUCT.HINT);
    expect(node._marker('hello')).toBe(STRUCT.STR);
    expect(node._marker(v4s[0].toUpperCase())).toBe(STRUCT.STR);
    const value: AnyValue = { ids: v4s.slice(0, 6), name: 'hello', other: 'F47AC10B' };
    expect(trip(node, value)).toEqual(value);
    const bare = p.any();
    const ids = v4s.slice(0, 6);
    expect(node.encode(ids).length).toBeLessThan(bare.encode(ids).length);
  });
});
