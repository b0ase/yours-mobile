// Flat-config equivalent of the former .eslintrc.js (eslint:recommended +
// @typescript-eslint/recommended + react-hooks/recommended + react-refresh).
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'build', 'build-mobile', 'build-web', 'release', 'android', 'ios', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node, ...globals.es2020 },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-require-imports': 'off', // successor of no-var-requires (was off)
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      // `_name` marks a deliberately unused binding; rest-sibling destructuring is
      // used to omit fields (e.g. `const { keyEpoch: _e, ...rest } = account`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Page entry points: they mount a root and export nothing, so there is no module for
    // Fast Refresh to hot-swap; a full reload is the expected behaviour for them.
    files: ['src/prompt-tab.tsx', 'src/sweep-tab.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    // A byte-identical copy of bit-sign's src/lib/feed/language.ts (canonical; language.test.ts
    // compares them), which writes its invisible-character class literally.
    files: ['src/mobile/feed/language.ts'],
    rules: { 'no-irregular-whitespace': 'off' },
  },
);
