#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Production artifact smoke.
 *
 * Proves the built artifact -- not the TypeScript source -- boots under plain `node`, answers
 * liveness, and shuts down cleanly on SIGTERM. No external provider is required: every dependency
 * this process talks to (Supabase, OpenAI, Stripe, Twilio, Google, the Chromium renderer) is
 * optional at boot by design (`apps/api/src/env.ts` -- every provider key is `.optional()`), so a
 * completely empty environment still produces a live process. That is the property this script
 * checks, not full integration behavior.
 *
 * This runs `dist/server.js` directly, never `tsx`: the whole point is that nothing here needs a
 * source loader at runtime.
 */

const PORT = Number(process.env.ARTIFACT_SMOKE_PORT ?? 4100);
const BOOT_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

function fail(message) {
  process.stderr.write(`artifact-smoke: FAIL -- ${message}\n`);
  process.exitCode = 1;
}

async function waitForLive(deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health/live`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        const body = await response.json();
        if (body?.status === 'ok') return true;
      }
    } catch {
      // Not listening yet.
    }
    await delay(200);
  }
  return false;
}

/**
 * The deployment identity is fail-closed at startup, proven against the real artifact.
 *
 * A production-mode container that cannot say which deployment it is must refuse to serve rather
 * than guess, because the wrong guess points production at a staging database or treats a test
 * Stripe key as live. This is the regression that keeps the guard honest: the operator CLI gained a
 * safe parse boundary so it can *report* this failure, and it would be easy to weaken the runtime
 * the same way by accident. The server must still die.
 */
async function assertRefusesToStartWithoutDeploymentIdentity() {
  const env = { ...process.env };
  delete env.AVENLYO_DEPLOYMENT_ENV;

  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...env,
      API_HOST: '127.0.0.1',
      API_PORT: String(PORT + 1),
      NODE_ENV: 'production',
      WEB_CHAT_IFRAME_ORIGIN: 'https://staging.avenlyo.com',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, timedOut: true });
    }, BOOT_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });

  if (exit.timedOut) {
    fail('a production-mode process with no AVENLYO_DEPLOYMENT_ENV kept running; it must refuse.');
    return;
  }
  if (exit.code === 0) {
    fail('a production-mode process with no AVENLYO_DEPLOYMENT_ENV exited 0; it must fail closed.');
    return;
  }
  if (!/AVENLYO_DEPLOYMENT_ENV/.test(stderr)) {
    fail('the startup refusal did not name the setting an operator has to fix.');
    return;
  }
  process.stdout.write(
    'artifact-smoke: PASS -- production-mode startup refuses a missing deployment identity\n',
  );
}

async function main() {
  await assertRefusesToStartWithoutDeploymentIdentity();

  process.stdout.write(`artifact-smoke: starting dist/server.js on port ${PORT}\n`);

  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      // Deliberately empty of every provider secret. A boot smoke proves the process can live with
      // nothing configured, exactly what a first deploy to an environment with no secrets yet does.
      API_HOST: '127.0.0.1',
      API_PORT: String(PORT),
      // Staging-shaped, not production-shaped: this smoke boots with no secret configured at all,
      // which is what a first deploy to a fresh staging host looks like. NODE_ENV=production alone
      // no longer identifies a deployment -- staging runs it too -- so the identity is explicit
      // here for the same reason the runtime demands it.
      AVENLYO_DEPLOYMENT_ENV: 'staging',
      NODE_ENV: 'production',
      // apps/api/src/env.ts enforces HTTPS here under NODE_ENV=production, same as the real
      // deployment will -- the value itself is unreachable in this smoke, only its scheme matters.
      WEB_CHAT_IFRAME_ORIGIN: 'https://staging.avenlyo.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  child.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });
  // The child's own structured Pino logs are useful for a human reading smoke output; passed
  // through as-is rather than parsed.
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));

  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  const live = await waitForLive(Date.now() + BOOT_TIMEOUT_MS);
  if (!live) {
    fail(`/health/live did not respond within ${BOOT_TIMEOUT_MS}ms.\n${stderrOutput}`);
    if (!exited) child.kill('SIGKILL');
    return;
  }
  process.stdout.write('artifact-smoke: /health/live responded ok\n');

  // `registerGracefulShutdown` (apps/api/src/lib/shutdown.ts) registers a real `process.on('SIGTERM',
  // ...)` listener and, on a clean run, lets Node exit naturally once the event loop empties -- it
  // never calls `process.exit(0)` itself on the success path, only on the forced-timeout path. That
  // is standard POSIX behavior (a registered listener suppresses the default terminate-immediately
  // action) and is what this checks for: code 0, no signal, meaning the listener ran to completion
  // rather than the OS just killing the process.
  //
  // Node.js on Windows does not deliver POSIX signals the way Linux/macOS do: `child.kill('SIGTERM')`
  // on win32 commonly terminates the child immediately (code null, signal SIGTERM) without the
  // listener ever running, regardless of application behavior. This is a documented Node-on-Windows
  // limitation, not something this script or the application can work around. On Linux -- every real
  // deployment target and this repository's own GitHub Actions CI -- the check below is authoritative.
  const isWindows = process.platform === 'win32';

  child.kill('SIGTERM');
  const shutdownDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (!exited && Date.now() < shutdownDeadline) {
    await delay(100);
  }

  if (!exited) {
    fail(`process did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM (still draining?).`);
    child.kill('SIGKILL');
    return;
  }
  if (exitCode !== 0) {
    if (isWindows && exitCode === null && exitSignal === 'SIGTERM') {
      process.stdout.write(
        'artifact-smoke: SKIP graceful-shutdown assertion -- win32 does not deliver a real SIGTERM ' +
          'to child processes; this check is authoritative on Linux (CI) only.\n',
      );
      return;
    }
    fail(
      `process exited with code ${exitCode} (signal ${exitSignal}) after SIGTERM, expected a clean 0.\n${stderrOutput}`,
    );
    return;
  }
  process.stdout.write('artifact-smoke: PASS -- graceful SIGTERM shutdown, exit code 0\n');
}

await main();
