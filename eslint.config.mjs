import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration.
 *
 * The repository's OWN rules — the `process.env` boundary, routes reaching past
 * the scoped query layer — are enforced by `src/lib/env-boundary.test.ts`
 * rather than here, because they are assertions about the codebase that should
 * fail the test suite, not warnings a lint run can be told to ignore.
 *
 * What is left is the standard TypeScript and React surface, with a few rules
 * promoted to errors because the build spec names them as anti-patterns.
 */
export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'drizzle/**', 'next-env.d.ts', '*.tsbuildinfo'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  /*
   * The Next plugin directly rather than `eslint-config-next`, which still
   * ships the legacy rushstack patch and refuses to load under flat config.
   */
  {
    /*
     * Scoped to the app, not the whole repo. Playwright fixtures take a
     * callback named `use`, and the rules-of-hooks rule reads that as a React
     * hook called outside a component — a false positive that would otherwise
     * have to be silenced file by file.
     */
    files: ['src/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
    },
  },

  {
    /*
     * Type-aware rules need a program, and the config files themselves are not
     * in the tsconfig. `allowDefaultProject` lets them lint without dragging
     * them into the build's type-check.
     */
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', 'postcss.config.mjs', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /*
       * The spec lists `any` as an anti-pattern outright, and the tsconfig is
       * strict with noUncheckedIndexedAccess — a stray `any` quietly undoes
       * both for everything it touches.
       */
      '@typescript-eslint/no-explicit-any': 'error',

      // An unused import in a server file is usually a half-finished refactor,
      // and in a route file it can keep a whole module in the bundle.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // `await` inside a loop over properties is deliberate in the ingest jobs
      // (one tenant at a time, bounded), so this stays off rather than being
      // disabled line by line.
      '@typescript-eslint/require-await': 'off',

      // Drizzle's builders are thenable; awaiting them is the API.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },

  {
    // Plain-JavaScript build scripts run under Node, outside the TypeScript
    // program, so the base config's no-undef needs told about Node's globals.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },

  {
    // Tests reach into internals on purpose.
    files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
