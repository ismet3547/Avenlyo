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
    include: ['apps/**/*.test.{ts,tsx}', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
