/**
 * Type checking utilities
 */

export const isArray = (o: any): o is any[] => Array.isArray(o);
export const isDate = (o: any): o is Date => o instanceof Date;

/**
 * An object literal or a null-prototype dictionary — a value whose whole state
 * is its own enumerable keys. A Map, a Set or a class instance keeps state
 * elsewhere, and walking its keys would encode an empty object.
 */
export const isPlainObject = (o: any): o is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(o);
  return proto === null || proto === Object.prototype;
};

/** The JS kinds `p.union` tells apart: `typeof`, with null, arrays, dates and each typed-array class split out of `'object'`. */
export type Kind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | 'symbol'
  | 'function'
  | 'undefined'
  | 'null'
  | 'array'
  | 'date'
  | 'object'
  // A typed array's kind is its built-in class name, e.g. 'Int16Array'; the
  // intersection keeps the names above as suggestions.
  | (string & {});

export const kindOf = (v: unknown): Kind => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (ArrayBuffer.isView(v)) return typedArrayKind(v);
  return typeof v;
};

export type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

/**
 * The built-in class name of a typed array (or `'DataView'`), read from its
 * internal tag, so a subclass such as Node's `Buffer` reads as `'Uint8Array'`
 * and an array from another realm (an iframe, a vm context) reads the same as
 * a local one.
 */
export const typedArrayKind = (value: ArrayBufferView): string =>
  Object.prototype.toString.call(value).slice(8, -1);
