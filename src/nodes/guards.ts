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

/** The JS kinds `p.union` tells apart: `typeof`, with null, arrays, dates and bytes split out of `'object'`. */
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
  | 'bytes'
  | 'object';

export const kindOf = (v: unknown): Kind => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (v instanceof Uint8Array) return 'bytes';
  return typeof v;
};
