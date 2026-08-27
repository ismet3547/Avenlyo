import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The real-browser security suite.
 *
 * It is a separate config so it can never silently skip: its CI job installs Chromium, fails if the
 * binary is missing, and runs only these files. Keeping it out of the default suite also stops one
 * slow browser run from starving unrelated tests on a loaded machine.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': fileURLToPath(new URL('./apps/web', import.meta.url)) } },
  test: {
    environment: 'node',
    // A browser launch, several navigations, and a full teardown do not fit a five-second default.
    hookTimeout: 90_000,
    include: ['apps/**/*.chromium.test.ts', 'packages/*/src/**/*.chromium.test.ts'],
    testTimeout: 120_000,
  },
});
