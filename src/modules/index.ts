/**
 * Register all encoding modules
 */

import { registerNumberModule } from './number';
import { registerStringModule } from './string';
import { registerBooleanModule } from './boolean';
import { registerItemModule } from './item';
import { registerFractionModule } from './fraction';
import { registerDateModule } from './date';
import { registerAnyModule } from './any';
import { registerObjectModule } from './object';

/**
 * Register all built-in modules
 * Call this once to enable all encoding types
 */
export function registerAllModules() {
  registerNumberModule();
  registerStringModule();
  registerBooleanModule();
  registerItemModule();
  registerFractionModule();
  registerDateModule();
  registerAnyModule();
  registerObjectModule();
}

// Re-export registry
export { modules, registerModule } from './registry';

// Re-export individual module registration functions for users
export {
  registerNumberModule,
  registerStringModule,
  registerBooleanModule,
  registerItemModule,
  registerFractionModule,
  registerDateModule,
  registerAnyModule,
  registerObjectModule,
};
