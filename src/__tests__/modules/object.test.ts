/**
 * Object module — full feature & bounds coverage.
 *
 * Features: typed templates, nested templates, optional fields (presence bit),
 * templateless self-describing objects, the `sort` option (order-independent
 * output), and the `base` option (plain object / array / factory / constructor).
 */

import { Encoder, Decoder } from '../../polynar';
import type { ObjectOptions } from '../../types';

const roundTrip = (value: unknown, options: ObjectOptions) => {
  const encoder = new Encoder();
  encoder.write(value, options);
  const decoder = new Decoder(encoder.toString());
  return decoder.read(options);
};

const encodeToString = (value: unknown, options: ObjectOptions) => {
  const encoder = new Encoder();
  encoder.write(value, options);
  return encoder.toString();
};

describe('Object module', () => {
  describe('typed templates', () => {
    const opts: ObjectOptions = {
      type: 'object',
      template: {
        name: { type: 'string', max: 50 },
        age: { type: 'number', min: 0, max: 150 },
        active: { type: 'boolean' },
      },
    };

    it('round-trips a flat object', () => {
      const obj = { name: 'John', age: 30, active: true };
      expect(roundTrip(obj, opts)).toEqual(obj);
    });

    it('preserves falsy-but-defined values', () => {
      const obj = { name: '', age: 0, active: false };
      expect(roundTrip(obj, opts)).toEqual(obj);
    });

    it('throws on a missing required property', () => {
      const encoder = new Encoder();
      expect(() => encoder.write({ name: 'John', active: true }, opts)).toThrow(ReferenceError);
    });
  });

  describe('nested templates', () => {
    const opts: ObjectOptions = {
      type: 'object',
      template: {
        id: { type: 'number', min: 0, max: 1000 },
        user: {
          name: { type: 'string', max: 50 },
          age: { type: 'number', min: 0, max: 150 },
        },
      },
    };

    it('round-trips nested objects', () => {
      const obj = { id: 7, user: { name: 'John', age: 30 } };
      expect(roundTrip(obj, opts)).toEqual(obj);
    });
  });

  describe('optional fields', () => {
    const opts: ObjectOptions = {
      type: 'object',
      template: {
        name: { type: 'string', max: 50 },
        age: { type: 'number', min: 0, max: 150, optional: true },
      },
    };

    it('round-trips with the optional field present', () => {
      const obj = { name: 'John', age: 30 };
      expect(roundTrip(obj, opts)).toEqual(obj);
    });

    it('round-trips with the optional field absent', () => {
      const obj = { name: 'John' };
      expect(roundTrip(obj, opts)).toEqual(obj);
    });
  });

  describe('templateless (self-describing) objects', () => {
    const opts: ObjectOptions = { type: 'object', template: false };

    it('round-trips arbitrary key/value pairs', () => {
      const obj = { a: 1, b: 'test', c: true };
      expect(roundTrip(obj, opts)).toEqual(obj);
    });

    it('round-trips an empty object', () => {
      expect(roundTrip({}, opts)).toEqual({});
    });

    it('defaults to templateless when template is omitted', () => {
      const obj = { x: 5 };
      expect(roundTrip(obj, { type: 'object' } as ObjectOptions)).toEqual(obj);
    });
  });

  describe('sort option', () => {
    it('produces identical output regardless of key insertion order', () => {
      const a = encodeToString({ b: 2, a: 1 }, { type: 'object', template: false, sort: true });
      const b = encodeToString({ a: 1, b: 2 }, { type: 'object', template: false, sort: true });
      expect(a).toBe(b);
    });
  });

  describe('base option', () => {
    const opts: ObjectOptions = {
      type: 'object',
      template: { n: { type: 'number', min: 0, max: 100 } },
    };

    it('merges decoded fields onto a plain-object base', () => {
      const str = encodeToString({ n: 5 }, opts);
      const decoded = new Decoder(str).read({ ...opts, base: { extra: 'kept' } });
      expect(decoded).toEqual({ extra: 'kept', n: 5 });
    });

    it('clones a plain-object base per item (no shared reference)', () => {
      const encoder = new Encoder();
      encoder.write([{ n: 1 }, { n: 2 }], opts);
      const decoded = new Decoder(encoder.toString()).read(
        { ...opts, base: { kept: true } },
        2
      ) as Array<Record<string, unknown>>;
      expect(decoded).toEqual([
        { kept: true, n: 1 },
        { kept: true, n: 2 },
      ]);
      expect(decoded[0]).not.toBe(decoded[1]);
    });

    it('deep-clones a nested base object so records do not share it', () => {
      const nestedOpts: ObjectOptions = {
        type: 'object',
        template: { inner: { n: { type: 'number', min: 0, max: 9 } } },
      };
      const encoder = new Encoder();
      encoder.write([{ inner: { n: 1 } }, { inner: { n: 2 } }], nestedOpts);
      const decoded = new Decoder(encoder.toString()).read(
        { ...nestedOpts, base: { inner: { tag: 'D' } } },
        2
      ) as Array<{ inner: Record<string, unknown> }>;
      expect(decoded[0].inner.n).toBe(1);
      expect(decoded[1].inner.n).toBe(2);
      expect(decoded[0].inner).not.toBe(decoded[1].inner);
    });

    it('applies a base array element per item', () => {
      const encoder = new Encoder();
      encoder.write([{ n: 1 }, { n: 2 }], opts);
      const decoded = new Decoder(encoder.toString()).read(
        { ...opts, base: [{ i: 0 }, { i: 1 }] },
        2
      );
      expect(decoded).toEqual([
        { i: 0, n: 1 },
        { i: 1, n: 2 },
      ]);
    });

    it('throws when a base array length mismatches the item count', () => {
      const encoder = new Encoder();
      encoder.write([{ n: 1 }, { n: 2 }], opts);
      expect(() => new Decoder(encoder.toString()).read({ ...opts, base: [{ i: 0 }] }, 2)).toThrow(
        /mismatch/
      );
    });

    it('calls an anonymous factory base', () => {
      const factory = [() => ({ tag: 'f' })][0]; // array element → name '' → factory path
      const str = encodeToString({ n: 9 }, opts);
      const decoded = new Decoder(str).read({ ...opts, base: factory });
      expect(decoded).toEqual({ tag: 'f', n: 9 });
    });

    it('instantiates a named constructor base', () => {
      class Point {
        x = 0;
        y = 0;
      }
      const str = encodeToString({ n: 3 }, opts);
      const decoded = new Decoder(str).read({ ...opts, base: Point });
      expect(decoded).toBeInstanceOf(Point);
      expect(decoded).toMatchObject({ x: 0, y: 0, n: 3 });
    });
  });

  describe('validator rejections', () => {
    const enc = new Encoder();
    it('rejects an invalid base', () => {
      expect(() => enc.write({}, { type: 'object', template: false, base: 42 as never })).toThrow(
        TypeError
      );
    });
  });
});
