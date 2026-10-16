const { copyFileSync, writeFileSync } = require('node:fs');

const names = Object.keys(require('../dist/index.js'));
writeFileSync(
  'dist/index.mjs',
  ["import cjs from './index.js';", `export const { ${names.join(', ')} } = cjs;`, ''].join('\n')
);
copyFileSync('dist/index.d.ts', 'dist/index.d.mts');
