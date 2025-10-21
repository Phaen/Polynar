/**
 * Character sets available for encoding
 */
export interface CharacterSets {
  digit: string;
  hex: string;
  lowalpha: string;
  hialpha: string;
  alpha: string;
  alphanumeric: string;
  printable: string;
  htmlSafe: string;
  Base64: string;
  urlSafe: string;
}

/**
 * Charset can be a string, number, or binary range
 */
export type Charset = string | number | [number, number];

/**
 * Base options for all encoding types
 */
export interface BaseOptions {
  type: string;
  limit?: number;
  preProc?: (item: any) => any;
  postProc?: (item: any) => any;
}

/**
 * Options for number encoding
 */
export interface NumberOptions extends BaseOptions {
  type: 'number';
  min?: number | false;
  max?: number | false;
  step?: number;
}

/**
 * Options for string encoding
 */
export interface StringOptions extends BaseOptions {
  type: 'string';
  max?: number | false;
  charset?: Charset;
}

/**
 * Options for item encoding
 */
export interface ItemOptions extends BaseOptions {
  type: 'item';
  list: any[];
  sort?: boolean;
}

/**
 * Options for boolean encoding
 */
export interface BooleanOptions extends BaseOptions {
  type: 'boolean';
}

/**
 * Options for fraction encoding
 */
export interface FractionOptions extends BaseOptions {
  type: 'fraction';
  precision?: number;
}

/**
 * Options for date encoding
 */
export interface DateOptions extends BaseOptions {
  type: 'date';
  interval?: number | string;
  min?: number | Date;
  max?: number | Date;
}

/**
 * Template for object encoding
 */
export interface ObjectTemplate {
  [key: string]: EncodingOptions | ObjectTemplate | { optional?: boolean; type?: string };
}

/**
 * Options for object encoding
 */
export interface ObjectOptions extends BaseOptions {
  type: 'object';
  template?: ObjectTemplate | false;
  base?: any | any[] | (() => any) | (new () => any);
  optional?: boolean;
  sort?: boolean;
}

/**
 * Options for any type encoding
 */
export interface AnyOptions extends BaseOptions {
  type: 'any';
}

/**
 * All possible encoding options
 */
export type EncodingOptions =
  | NumberOptions
  | StringOptions
  | ItemOptions
  | BooleanOptions
  | FractionOptions
  | DateOptions
  | ObjectOptions
  | AnyOptions;

/**
 * Module definition
 */
export interface Module {
  validator: ((options: any) => void) | false;
  encoder: (this: Encoder, items: any[], options: any) => void;
  decoder: (this: Decoder, options: any, count: number) => any[];
}

/**
 * Modules registry
 */
export interface Modules {
  [key: string]: Module;
}

/**
 * Encoder class interface
 */
export interface Encoder {
  strict: boolean;
  radii: number[];
  integers: number[];
  write(items: any | any[], options: EncodingOptions): void;
  compose(integer: number, radix: number): void;
  composeTerm(integer: number): void;
  toString(charset?: Charset): string;
}

/**
 * Decoder class interface
 */
export interface Decoder {
  strict: boolean;
  str: string;
  charset: Charset;
  size: number;
  current?: number;
  radii?: number;
  pointer?: number;
  parse(radix: number): number;
  parseTerm(): number;
  read(options: EncodingOptions, count?: number): any;
}
