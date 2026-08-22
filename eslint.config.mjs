import eslint from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      'supabase/.temp/**',
    ],
  },
  eslint.configs.recommended,
  {
    ...nextPlugin.flatConfig.coreWebVitals,
    files: ['apps/web/**/*.{ts,tsx}'],
    settings: {
      next: {
        rootDir: 'apps/web/',
      },
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    files: ['apps/web/next-env.d.ts'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },
  {
    // Plain Node.js build/deploy tooling (esbuild config, boot smokes) -- not part of any shipped
    // artifact, so it stays plain .mjs rather than adding a TypeScript loader dependency just to
    // typecheck a handful of lines. The TS block above only covers .ts/.tsx, so these otherwise get
    // no globals at all and every Node global reads as undefined.
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
);
