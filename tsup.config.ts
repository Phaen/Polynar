import { defineConfig } from 'tsup';

// One entry, built once as CJS (.js) plus type declarations. scripts/esm-wrapper.cjs
// then writes the ESM entry (.mjs) as a thin wrapper re-exporting the CJS module,
// so both module systems share one copy of every class and `instanceof` holds
// across them. Unminified so downstream bundlers can do their own thing. Browsers
// load the ESM build through a CDN such as esm.sh or jsdelivr's /+esm.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  treeshake: true,
});
