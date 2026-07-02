/**
 * Polynar.js 3.0
 * Efficient data encoding library
 * (c) 2014-2026 Pablo Kebees
 * Polynar may be freely distributed under the MIT license.
 */

import { registerAllModules } from './modules';

// Register all built-in modules
registerAllModules();

// Export everything
export { CharSets } from './constants';
export { Encoder } from './encoder';
export { Decoder } from './decoder';
export { modules, registerModule } from './modules';
