import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next.js leaves JSX untransformed for its own compiler, so component tests need the automatic
  // runtime configured here. Without it a .tsx render fails with "React is not defined".
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/web', import.meta.url)),
    },
  },
  test: {
    // The real-Chromium suite is deliberately excluded here and run by its own config in a
    // dedicated CI job. Left in, it both skipped on hosts without a browser — which is a security
    // test that did not run — and starved the rest of the suite on hosts with one.
    exclude: ['**/node_modules/**', '**/*.chromium.test.ts'],
    include: ['apps/**/*.test.{ts,tsx}', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
