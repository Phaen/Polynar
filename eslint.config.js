/**
 * ESLint v9 flat config.
 */
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const prettierPlugin = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error',
      // The codec operates on heterogeneous, runtime-typed data (the module
      // encoder/decoder boundary, preProc/postProc hooks, and `PNode<any>` shapes
      // that legitimately mix node types). `any` is deliberate here, not an escape.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Type-level assertion files: their `const X = ...` fixtures are referenced
    // only via `typeof X` (a type position), which no-unused-vars can't see.
    files: ['**/*.test-d.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
