/**
 * Tests for object encoding module
 */

import { Encoder, Decoder } from '../../polynar';

describe('Object Module', () => {
  it('should encode and decode an object with template', () => {
    const obj = { name: 'John', age: 30 };
    const encoder = new Encoder();
    encoder.write(obj, {
      type: 'object',
      template: {
        name: { type: 'string', max: 50 },
        age: { type: 'number', min: 0, max: 150 },
      },
    });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({
      type: 'object',
      template: {
        name: { type: 'string', max: 50 },
        age: { type: 'number', min: 0, max: 150 },
      },
    });

    expect(decoded).toEqual(obj);
  });

  it('should encode nested objects', () => {
    const obj = {
      user: {
        name: 'John',
        age: 30,
      },
    };

    const encoder = new Encoder();
    encoder.write(obj, {
      type: 'object',
      template: {
        user: {
          name: { type: 'string', max: 50 },
          age: { type: 'number', min: 0, max: 150 },
        },
      },
    });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({
      type: 'object',
      template: {
        user: {
          name: { type: 'string', max: 50 },
          age: { type: 'number', min: 0, max: 150 },
        },
      },
    });

    expect(decoded).toEqual(obj);
  });

  it('should handle optional properties', () => {
    const obj = { name: 'John' };

    const encoder = new Encoder();
    encoder.write(obj, {
      type: 'object',
      template: {
        name: { type: 'string', max: 50 },
        age: { type: 'number', min: 0, max: 150, optional: true },
      },
    });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({
      type: 'object',
      template: {
        name: { type: 'string', max: 50 },
        age: { type: 'number', min: 0, max: 150, optional: true },
      },
    });

    expect(decoded).toEqual(obj);
  });

  it('should encode objects without template', () => {
    const obj = { a: 1, b: 'test', c: true };

    const encoder = new Encoder();
    encoder.write(obj, { type: 'object', template: false });
    const encoded = encoder.toString();

    const decoder = new Decoder(encoded);
    const decoded = decoder.read({ type: 'object', template: false });

    expect(decoded).toEqual(obj);
  });

  it('should sort object keys', () => {
    const obj1 = { b: 2, a: 1 };
    const obj2 = { a: 1, b: 2 };

    const encoder1 = new Encoder();
    encoder1.write(obj1, { type: 'object', template: false, sort: true });
    const encoded1 = encoder1.toString();

    const encoder2 = new Encoder();
    encoder2.write(obj2, { type: 'object', template: false, sort: true });
    const encoded2 = encoder2.toString();

    expect(encoded1).toBe(encoded2);
  });
});
