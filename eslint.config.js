import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['**/dist/', '**/coverage/', 'spikes/', '.claude*'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
  // Server code queries only through the site-scoped repositories (RFC 04 §2, T4.4). This is the
  // single no-restricted-syntax entry for the server: later rules extend it, because flat-config
  // entries for the same rule replace each other.
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/repo/**', 'apps/server/src/db/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.type="MemberExpression"][callee.property.name=/^(selectFrom|insertInto|updateTable|deleteFrom|mergeInto|replaceInto)$/]',
          message: 'Query through apps/server/src/repo (site-scoped); raw query builders are not allowed here',
        },
      ],
    },
  },
  // IDs and secrets need a CSPRNG (SR-12); no exemptions, because repo/ is where IDs are minted.
  {
    files: ['apps/server/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use node:crypto (IDs need a CSPRNG, SR-12)' },
      ],
    },
  },
)
