#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';

/**
 * Production artifact smoke for the post-deploy smoke command.
 *
 * The lesson, for the third time in this repository: the runbook told an operator to run
 * `pnpm smoke:production` on the deployment host, and the real Hetzner host has neither pnpm nor a
 * Node runtime -- it builds everything inside Docker. Worse than ops-status and ops-preflight were,
 * this one was not even in the bundle: the package script ran the TypeScript source through `tsx`,
 * which the production image does not ship. So the documented post-deploy verification could not
 * run anywhere it was documented to run.
 *
 * Everything below is a real spawn of the built artifact under plain `node`, against a loopback
 * fixture server. Nothing contacts a real deployment, a provider, or a database.
 */

const ARTIFACT = 'dist/scripts/smoke-production.js';
const RUN_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARACTERS = 8_000;
const SHA = 'c000caf742f7e4ca5d8dc85376931fcbb7a9e6a7';
const OTHER_SHA = '1111111111111111111111111111111111111111';

let failures = 0;
function fail(scenario, message) {
  failures += 1;
  process.stderr.write(`smoke-production-artifact-smoke: FAIL [${scenario}] -- ${message}\n`);
  process.exitCode = 1;
}

/** Shapes a leaked credential or connection target actually takes. */
const FORBIDDEN = [
  'postgres://',
  'supabase.co',
  'service_role',
  'eyJ',
  'sk_live_',
  'sk_test_',
  'SUPABASE_SERVICE_ROLE_KEY=',
  'OPENAI_API_KEY=',
];

/** A deployment that answers exactly like the real one, on loopback. */
function startFixture(release) {
  const server = createServer((request, response) => {
    const body = { release, service: 'avenlyo-api', status: 'ok' };
    if (request.url === '/health/ready') body.status = 'ready';
    if (request.url === '/api/health') body.service = 'avenlyo-web';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }));
  });
}

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ARTIFACT], {
      env: { ...env, PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: RUN_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => resolve({ code: null, error, stderr, stdout }));
    child.on('close', (code) => resolve({ code, stderr, stdout }));
  });
}

function assertBoundedAndClean(scenario, result) {
  const output = `${result.stdout}${result.stderr}`;
  if (/\n\s+at\s+.+:\d+:\d+/.test(output)) {
    fail(scenario, 'a stack trace was printed for an expected outcome');
  }
  if (output.length > MAX_OUTPUT_CHARACTERS) {
    fail(scenario, `output was ${output.length} characters, above the ${MAX_OUTPUT_CHARACTERS} ceiling`);
  }
  for (const forbidden of FORBIDDEN) {
    if (output.includes(forbidden)) fail(scenario, `output contained a forbidden shape: ${forbidden}`);
  }
  return output;
}

// ---------------------------------------------------------------------------------------------
if (!existsSync(ARTIFACT)) {
  fail('artifact', `${ARTIFACT} does not exist -- the post-deploy smoke is not in the build.`);
  process.exit(1);
}

const { port, server } = await startFixture(SHA);
const base = `http://127.0.0.1:${port}`;

// -- The documented shape: no explicit variables, everything from the deployment profile ---------
{
  const scenario = 'runs from profile values alone, as the documented container command does';
  const result = await run({
    AVENLYO_PROFILE_PUBLIC_API_URL: base,
    AVENLYO_PROFILE_APP_URL: base,
    AVENLYO_RELEASE: SHA,
  });
  if (result.error) {
    fail(scenario, `could not execute the artifact: ${result.error.code ?? result.error.message}`);
  } else {
    if (result.code !== 0) fail(scenario, `expected exit 0, got ${result.code}`);
    const output = assertBoundedAndClean(scenario, result);
    for (const check of ['api_live', 'api_ready', 'web_live', 'api_release']) {
      if (!output.includes(check)) fail(scenario, `expected the report to include ${check}`);
    }
  }
}

// -- The check that matters: `up` silently kept the previous image --------------------------------
{
  const scenario = 'fails when the running deployment is not the release we meant to deploy';
  const result = await run({
    AVENLYO_PROFILE_PUBLIC_API_URL: base,
    AVENLYO_PROFILE_APP_URL: base,
    // The one-off container is created from the INTENDED image, so its AVENLYO_RELEASE is the new
    // SHA while the running deployment still reports the old one. That difference is the whole
    // reason the release assertion exists.
    AVENLYO_RELEASE: OTHER_SHA,
  });
  if (result.code !== 1) fail(scenario, `expected exit 1, got ${result.code}`);
  const output = assertBoundedAndClean(scenario, result);
  if (!output.includes('api_release')) fail(scenario, 'expected the release check to be named');
  if (!/FAIL\s+api_release/.test(output)) fail(scenario, 'expected api_release to be recorded FAIL');
}

// -- An explicit expectation always wins over the profile fallback --------------------------------
{
  const scenario = 'an explicit AVENLYO_EXPECTED_RELEASE overrides the profile fallback';
  const result = await run({
    AVENLYO_PROFILE_PUBLIC_API_URL: base,
    AVENLYO_RELEASE: OTHER_SHA,
    AVENLYO_EXPECTED_RELEASE: SHA,
  });
  if (result.code !== 0) fail(scenario, `expected exit 0, got ${result.code}`);
  assertBoundedAndClean(scenario, result);
}

// -- `unknown` is not an expectation --------------------------------------------------------------
{
  const scenario = 'an unset release does not manufacture a release assertion';
  const result = await run({ AVENLYO_PROFILE_PUBLIC_API_URL: base, AVENLYO_RELEASE: 'unknown' });
  if (result.code !== 0) fail(scenario, `expected exit 0, got ${result.code}`);
  const output = assertBoundedAndClean(scenario, result);
  if (output.includes('api_release')) {
    fail(scenario, 'asserted a release against the placeholder "unknown"');
  }
}

// -- No target at all is a bounded refusal, not a crash -------------------------------------------
{
  const scenario = 'no API base URL anywhere';
  const result = await run({});
  if (result.code !== 1) fail(scenario, `expected exit 1, got ${result.code}`);
  const output = assertBoundedAndClean(scenario, result);
  if (!output.includes('AVENLYO_API_BASE_URL')) {
    fail(scenario, 'expected the message to name the setting to supply');
  }
}

// -- An unreachable deployment fails; it does not hang or throw ------------------------------------
{
  const scenario = 'unreachable deployment';
  server.close();
  const result = await run({ AVENLYO_PROFILE_PUBLIC_API_URL: base, AVENLYO_RELEASE: SHA });
  if (result.code !== 1) fail(scenario, `expected exit 1, got ${result.code}`);
  assertBoundedAndClean(scenario, result);
}

if (failures === 0) {
  process.stdout.write(
    'smoke-production-artifact-smoke: PASS -- the post-deploy smoke ships in dist/ and runs under ' +
      'plain node; it reads its targets and expected release from the deployment profile, fails ' +
      'when the running release is not the intended one, refuses to invent an assertion from an ' +
      'unset release, and stays bounded and secret-free\n',
  );
}
