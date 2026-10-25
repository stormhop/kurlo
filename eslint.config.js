import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';

export default [
  {
    ignores: [
      '.claude/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/.astro/**',
      'apps/desktop/build/**',
      'apps/desktop/frontend/wailsjs/**',
      'apps/desktop/internal/loadtest/testdata/**',
      'perf/fixtures/**',
      'release/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],

  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'svelte/no-useless-mustaches': 'off',
    },
  },

  {
    files: ['apps/desktop/frontend/e2e/cookie-sync-extension.mjs'],
    languageOptions: {
      globals: { chrome: 'readonly', connect: 'readonly' },
    },
  },

  {
    files: ['apps/desktop/frontend/src/tests/**', 'apps/desktop/frontend/e2e/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    files: ['apps/desktop/frontend/src/lib/stores/**'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },

  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: tseslint.parser },
    },
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      'svelte/require-each-key': 'error',
      'svelte/prefer-svelte-reactivity': 'error',
    },
  },
];
