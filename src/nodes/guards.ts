/**
 * Type checking utilities
 */

export const isObject = (o: any): o is object => o && typeof o === 'object';
export const isArray = (o: any): o is any[] => Array.isArray(o);
export const isDate = (o: any): o is Date => o instanceof Date;
