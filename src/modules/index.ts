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
import { modules } from './registry';

const builtins: Record<string, () => void> = {
  number: registerNumberModule,
  string: registerStringModule,
  boolean: registerBooleanModule,
  item: registerItemModule,
  fraction: registerFractionModule,
  date: registerDateModule,
  any: registerAnyModule,
  object: registerObjectModule,
};

/**
 * Register all built-in modules.
 *
 * Idempotent and non-clobbering: a built-in is registered only if no module of
 * that name already exists. This is safe to call from multiple entry points
 * (the codec and the schema layer both call it at import time) and never
 * overwrites a module a caller registered themselves.
 */
export function registerAllModules() {
  for (const name in builtins) {
    if (modules[name] == null) {
      builtins[name]();
    }
  }
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
