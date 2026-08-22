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

await build({
  ...sharedOptions,
  entryPoints: {
    server: 'src/server.ts',
    'scripts/chromium-sandbox-smoke': 'src/scripts/chromium-sandbox-smoke.ts',
  },
});
