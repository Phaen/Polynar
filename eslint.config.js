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
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
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
    // The predictor must compute the same integers on every engine: no transcendental
    // functions, no floating division, and no 32-bit shifts or bitwise operators
    // outside the two files that work on hash and range words.
    files: ['src/predictor/**/*.ts'],
    ignores: ['src/predictor/arith.ts', 'src/predictor/keymap.ts', 'src/predictor/alphabet.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name=/^(exp|log|log2|log10|log1p|expm1|pow|sqrt|cbrt|hypot|sin|cos|tan|atan|atan2|round|trunc|ceil|floor|fround)$/]",
          message: 'The predictor uses arith.ts for every non-integer operation.',
        },
        { selector: "BinaryExpression[operator='**']", message: 'The predictor uses arith.ts for powers.' },
        { selector: "BinaryExpression[operator='/']", message: 'The predictor divides through arith.ts.' },
        { selector: "AssignmentExpression[operator='/=']", message: 'The predictor divides through arith.ts.' },
        {
          selector: "BinaryExpression[operator=/^(<<|>>|>>>|&|\\||\\^)$/]",
          message: 'Shifts and bitwise operators wrap at 32 bits; the predictor uses arith.ts.',
        },
        {
          selector: "AssignmentExpression[operator=/^(<<=|>>=|>>>=|&=|\\|=|\\^=)$/]",
          message: 'Shifts and bitwise operators wrap at 32 bits; the predictor uses arith.ts.',
        },
        { selector: "UnaryExpression[operator='~']", message: 'Bitwise operators wrap at 32 bits.' },
        { selector: "NewExpression[callee.name='Float32Array']", message: 'The predictor holds integers in Float64Array.' },
        { selector: "CallExpression[callee.name='parseFloat']", message: 'The predictor never parses floats.' },
      ],
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
