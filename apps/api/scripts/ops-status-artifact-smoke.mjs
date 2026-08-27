#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Production artifact smoke for the operator status command.
 *
 * This exists because of a real gap, not a hypothetical one. `apps/api/package.json` told operators
 * to run `ops:status`, the deployment runbook told them the same, and the production image copies
 * `dist/` rather than `src/` and ships no `tsx` -- so the documented operational check had no
 * artifact to run and failed with MODULE_NOT_FOUND on the real host. Nothing caught it, because
 * nothing had ever executed it the way a host would.
 *
 * So this asserts the artifact by running it, not by reading `esbuild.config.mjs`. A test that only
 * inspected the config would have passed on the broken build the moment the config was edited, and
 * would still not prove `node` can load what came out.
 *
 * The database is deliberately left unconfigured, while everything `src/env.ts` demands at import
 * time is supplied. `ops-status` is required to answer an operator safely when it cannot reach the
 * database, and that is the one failure a smoke can create honestly without a database: it must
 * exit `OPS_EXIT_DATABASE_UNAVAILABLE`, say so in one fixed sentence, and leak nothing -- no
 * connection string, no host, no stack, no key. Those are the Phase 14 rules, and they matter most
 * on the failure path, which is the path nobody looks at.
 */

const ARTIFACT = 'dist/scripts/ops-status.js';
const RUN_TIMEOUT_MS = 20_000;
const OPS_EXIT_DATABASE_UNAVAILABLE = 1;
/** Generous: the whole output is a handful of fixed sentences. */
const MAX_OUTPUT_CHARACTERS = 4_000;

function fail(message) {
  process.stderr.write(`ops-status-artifact-smoke: FAIL -- ${message}\n`);
  process.exitCode = 1;
}

/**
 * Strings that must never appear, whatever the process decided to say.
 *
 * `postgres://` and `supabase.co` are the two shapes a leaked connection target actually takes
 * here; the stack-frame markers catch an unhandled rejection printing an internal path.
 */
const FORBIDDEN = [
  'postgres://',
  'postgresql://',
  'supabase.co',
  'service_role',
  'SUPABASE_SERVICE_ROLE_KEY',
  'eyJ',
  'at Object.',
  'at async',
  'node:internal',
  'MODULE_NOT_FOUND',
];

function run() {
  return new Promise((resolve) => {
    // The minimum a real production host supplies, and nothing more. `src/env.ts` runs its
    // production guards at import time, so an empty environment would fail on configuration before
    // the command ever ran -- which would test the guard, not the operator command. Supabase is
    // deliberately still absent: that is the unconfigured-database path this smoke is here to walk.
    const child = spawn(process.execPath, [ARTIFACT], {
      env: {
        API_HOST: '127.0.0.1',
        API_PORT: '4101',
        NODE_ENV: 'production',
        PATH: process.env.PATH ?? '',
        WEB_CHAT_IFRAME_ORIGIN: 'https://staging.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stderr, stdout, timedOut: true });
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout, timedOut: false });
    });
  });
}

async function main() {
  if (!existsSync(ARTIFACT)) {
    fail(`${ARTIFACT} is missing -- the production build does not emit the operator command.`);
    return;
  }

  const result = await run();
  const combined = `${result.stdout}${result.stderr}`;

  if (result.timedOut) {
    fail(`${ARTIFACT} did not exit within ${RUN_TIMEOUT_MS}ms.`);
    return;
  }
  if (result.code !== OPS_EXIT_DATABASE_UNAVAILABLE) {
    fail(
      `expected exit ${OPS_EXIT_DATABASE_UNAVAILABLE} with no database configured, got ${result.code}.\n${combined}`,
    );
    return;
  }
  // MODULE_NOT_FOUND is checked below with the other forbidden strings, but call it out here too:
  // it is the exact failure this smoke was written for.
  if (combined.includes('Cannot find module')) {
    fail(`${ARTIFACT} could not be loaded by plain node.\n${combined}`);
    return;
  }
  if (combined.length > MAX_OUTPUT_CHARACTERS) {
    fail(`output was ${combined.length} characters, expected a bounded operator message.`);
    return;
  }
  const leaked = FORBIDDEN.filter((needle) => combined.includes(needle));
  if (leaked.length > 0) {
    fail(`output contained forbidden content: ${leaked.join(', ')}`);
    return;
  }
  if (!combined.includes('operational status')) {
    fail(`expected the fixed unconfigured-database message, got:\n${combined}`);
    return;
  }

  process.stdout.write(
    'ops-status-artifact-smoke: PASS -- artifact runs under plain node, exits 1 unconfigured, ' +
      'bounded output, no secret or connection detail\n',
  );
}

await main();
