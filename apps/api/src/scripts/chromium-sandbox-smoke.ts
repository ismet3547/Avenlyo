import {
  buildRenderedLaunchOptions,
  renderedCapabilityExecutablePath,
} from '../services/knowledge/playwright-renderer.js';
import { chromium } from 'playwright-core';

/**
 * Deterministic proof that the final API container can launch a real, OS-sandboxed Chromium as the
 * actual non-root runtime user -- not that the application config *requests* a sandbox, which the
 * unit suite already covers with no browser required.
 *
 * This is deliberately not a test file: it ships inside the production bundle (`dist/scripts/
 * chromium-sandbox-smoke.js`) so it runs against the exact browser binary, executable path, and
 * launch options production uses, invoked with `node` and nothing else. It imports
 * `buildRenderedLaunchOptions` and `renderedCapabilityExecutablePath` from the renderer itself
 * rather than restating the launch configuration, so a change to the real options is what this
 * script proves -- not a copy of them that could quietly drift.
 *
 * Every failure path here exits non-zero. There is no skip: a container that ships this script is a
 * container that claims rendered capability, and "Chromium is missing" or "the sandbox could not
 * initialize" are the exact conditions this exists to catch before a deploy, not paper over.
 */

function fail(message: string): never {
  process.stderr.write(`chromium-sandbox-smoke: FAIL -- ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const uid = process.getuid?.();
  if (uid === 0) {
    fail('running as UID 0 (root). Chromium does not fully sandbox itself under a root parent.');
  }
  process.stdout.write(`chromium-sandbox-smoke: running as UID ${uid ?? '(unknown, no getuid)'}\n`);

  const executablePath = renderedCapabilityExecutablePath(
    process.env.KNOWLEDGE_RENDERER_EXECUTABLE_PATH,
  );
  if (!executablePath) {
    fail(
      'no Chromium binary found at KNOWLEDGE_RENDERER_EXECUTABLE_PATH ' +
        `(${process.env.KNOWLEDGE_RENDERER_EXECUTABLE_PATH ?? '(unset)'}) or the Playwright default. ` +
        'This image must ship a matching browser -- see deploy/Dockerfile.api.',
    );
  }
  process.stdout.write(`chromium-sandbox-smoke: resolved executable ${executablePath}\n`);

  const options = buildRenderedLaunchOptions({
    executablePath,
    // Nothing is fetched through it; the launch itself is the assertion, exactly as in the unit
    // suite this mirrors.
    proxyServer: 'http://127.0.0.1:1',
  });
  if (options.chromiumSandbox !== true) {
    // Defensive: proves this script would fail loudly if the shipped launch options ever regressed,
    // rather than silently launching an unsandboxed browser and reporting success.
    fail('buildRenderedLaunchOptions() did not request chromiumSandbox: true.');
  }

  const browser = await chromium.launch(options).catch((error: unknown) => {
    // No retry, and never with the sandbox removed. A host or container that cannot start a
    // sandboxed Chromium has no rendered capability -- proving that is this script's entire job.
    fail(
      `Chromium failed to launch with chromiumSandbox: true. ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<html><body><p id="x">sandboxed</p></body></html>');
    const text = await page.textContent('#x');
    if (text !== 'sandboxed') {
      fail(`page content mismatch after launch (got ${JSON.stringify(text)}).`);
    }
    await context.close();
    process.stdout.write(`chromium-sandbox-smoke: PASS -- ${browser.version()}, sandbox enabled\n`);
  } finally {
    await browser.close();
  }
}

await main();
