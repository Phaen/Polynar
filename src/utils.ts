/**
 * Utility functions for Polynar
 */

import type { Charset, EncodingOptions } from './types';
import { DEFAULT_CHARSET } from './constants';
import { modules } from './modules/registry';

/**
 * Type checking utilities
 */
export const isObject = (o: any): o is object => o && typeof o === 'object';
export const isArray = (o: any): o is any[] => Array.isArray(o);
export const isDate = (o: any): o is Date => o instanceof Date;

/**
 * Math utilities
 */
export const multiply = (a: number, b: number): number => a * b;

/**
 * Validate encoding options
 */
export function validateOptions(optionsObj: EncodingOptions): EncodingOptions {
  if (!isObject(optionsObj)) {
    throw new TypeError(`${optionsObj} is not an object`);
  }

  if (modules[optionsObj.type] == null) {
    throw new TypeError('Invalid encoding type');
  }

  // Shallow copy the options
  const options: any = {};
  for (const i in optionsObj) {
    if (Object.prototype.hasOwnProperty.call(optionsObj, i)) {
      options[i] = (optionsObj as any)[i];
    }
  }

  const validator = modules[options.type].validator;
  if (validator) {
    validator(options);
  }

  if (options.limit != null) {
    if (typeof options.limit !== 'number' || options.limit % 1 !== 0 || options.limit < 0) {
      throw new TypeError('Invalid item limit');
    }
  }

  return options;
}

/**
 * Validate character set
 */
export function validateCharset(charset?: Charset): Charset {
  const errChar = 'Invalid character set';
  const errBin = 'Invalid binary range';

  if (charset == null) {
    return DEFAULT_CHARSET;
  } else if (typeof charset === 'number') {
    if (charset % 1 !== 0 || charset < 2) {
      throw new TypeError(errBin);
    }
    return [0, charset];
  } else if (typeof charset === 'string') {
    if (charset.match(/(.).*\1/)) {
      throw new Error(errChar);
    }
    return charset;
  } else if (isArray(charset)) {
    if (charset.length !== 2) {
      throw new TypeError(errBin);
    }

    // Normalize into a fresh array so the caller's is never mutated.
    let [min, max] = charset;
    if (min > max) {
      [min, max] = [max, min];
    }

    if (max - min < 2) {
      throw new Error(errBin);
    }

    return [min, max];
  } else {
    throw new TypeError(errChar);
  }
}
