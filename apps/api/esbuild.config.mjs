import { rm } from 'node:fs/promises';

import { build } from 'esbuild';

/**
 * The production bundler for @avenlyo/api.
 *
 * `apps/api`'s own source is TypeScript with no emit (`tsc --noEmit`), and every `@avenlyo/*`
 * workspace package it imports exports raw `.ts` source directly (`"exports": {"." : "./src/index.ts"}`,
 * no `dist/`). `tsx` papers over both facts by transpiling everything on every process start, which
 * is fine for local development and wrong for a long-lived production process: there is no artifact
 * that proves "what CI typechecked" and "what boots in staging" are the same bytes, and no support
 * contract for running a dev tool as a server.
 *
 * esbuild resolves and inlines the workspace packages' TypeScript at build time instead, so the
 * output is one self-contained file per entry point that a plain `node` can run with no loader.
 * Nothing about the 8 workspace packages changes -- esbuild reads their raw `.ts` source the same
 * way `tsx` does, it just does it once, at build time, and writes the result down.
 *
 * Runtime npm dependencies are deliberately NOT bundled (`external`, below). Some ship native
 * bindings or their own asset resolution (`playwright-core` locates a browser binary relative to
 * its own installed package directory at runtime); bundling them would either break that resolution
 * or duplicate work node_modules already does for free. Only the raw-TypeScript workspace packages
 * need esbuild's help -- everything already shipping as plain JS in node_modules keeps working
 * exactly as it does today, resolved normally at runtime.
 */

const external = [
  '@fastify/cors',
  '@fastify/formbody',
  '@fastify/helmet',
  '@fastify/rate-limit',
  '@supabase/supabase-js',
  'dotenv',
  'fastify',
  'fastify-plugin',
  'openai',
  'playwright-core',
  'stripe',
  'twilio',
  'ws',
  'zod',
];

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
  banner: {
    // esbuild's ESM output does not automatically shim `require()` for every bundled CJS
    // dependency -- some transitive deps (observed: `iconv-lite`/`safer-buffer`, pulled in through
    // a bundled workspace package) call `require('buffer')` in a way esbuild's static ESM/CJS
    // interop cannot rewrite to a real `import`, and throw "Dynamic require of ... is not
    // supported" at runtime instead of at build time. A real `require`, built from the ESM module
    // loader, fixes it for every such case rather than one dependency at a time. This is the
    // documented esbuild workaround for platform:node + format:esm
    // (https://github.com/evanw/esbuild/issues/1921), not an Avenlyo-specific patch.
    js: "import { createRequire as __avenlyoCreateRequire } from 'node:module';\nconst require = __avenlyoCreateRequire(import.meta.url);",
  },
  bundle: true,
  external,
  format: 'esm',
  logLevel: 'info',
  minify: false,
  outdir: 'dist',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
};

/**
 * Clean first, so `dist/` only ever contains what this build produced.
 *
 * esbuild writes its outputs but does not remove outputs from a previous run, so an entry point
 * deleted from the list below would leave its stale artifact on disk -- and every "is the operator
 * command in the bundle?" check would keep passing against a file nothing builds any more. That is
 * not hypothetical: removing `scripts/smoke-production` to prove the guard was load-bearing left the
 * artifact smoke green, because it was testing yesterday's file.
 *
 * CI builds from a fresh checkout and so was never exposed to this; a local incremental build was.
 */
await rm('dist', { force: true, recursive: true });

await build({
  ...sharedOptions,
  entryPoints: {
    server: 'src/server.ts',
    'scripts/chromium-sandbox-smoke': 'src/scripts/chromium-sandbox-smoke.ts',
    // The operator status command. The runbook tells whoever is on the host to run it, the image
    // copies `dist/` and not `src/`, and the production image has no tsx -- so leaving this out of
    // the bundle meant the documented operational check simply did not exist in production.
    'scripts/ops-status': 'src/scripts/ops-status.ts',
    // Phase 20's deployment safety gate. Shipped for the same reason ops-status is: the runbook
    // tells an operator to run it, and the production image copies dist/ and carries no tsx.
    'scripts/ops-preflight': 'src/scripts/ops-preflight.ts',
    // The post-deploy smoke. Same reason again, found the same way: the runbook told the operator
    // to run `pnpm smoke:production` on the deployment host, and the real Hetzner host has neither
    // pnpm nor a Node runtime -- it builds everything inside Docker. Bundling it means the
    // documented post-deploy check runs from the exact release image, with no host toolchain.
    'scripts/smoke-production': 'src/scripts/smoke-production.ts',
  },
});
