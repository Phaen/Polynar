import { defineConfig } from 'tsup';

// One entry, emitted as CJS (.js) + ESM (.mjs) + type declarations. Unminified
// so downstream bundlers can do their own thing. Browsers load the ESM build
// through a CDN such as esm.sh or jsdelivr's /+esm.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
