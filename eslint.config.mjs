import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const testGlobals = {
  afterAll: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  beforeEach: 'readonly',
  describe: 'readonly',
  expect: 'readonly',
  it: 'readonly',
  vi: 'readonly'
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker
      }
    },
    rules: {
      'no-console': 'off',
      'no-nested-ternary': 'error'
    }
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.ts'],
    languageOptions: {
      globals: testGlobals
    }
  }
);
