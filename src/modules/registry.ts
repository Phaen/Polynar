/**
 * Module registry for Polynar encoding/decoding modules
 */

import type { Modules, Encoder, Decoder } from '../types';

/**
 * Modules registry
 */
export const modules: Modules = {};

/**
 * Register a module
 */
export function registerModule(
  name: string,
  validator: ((options: any) => void) | false,
  encoder: (this: Encoder, items: any[], options: any) => void,
  decoder: (this: Decoder, options: any, count: number) => any[]
): void {
  modules[name] = { validator, encoder, decoder };
}
