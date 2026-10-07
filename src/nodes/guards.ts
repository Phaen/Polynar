/**
 * Type checking utilities
 */

export const isObject = (o: any): o is object => o && typeof o === 'object';
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
