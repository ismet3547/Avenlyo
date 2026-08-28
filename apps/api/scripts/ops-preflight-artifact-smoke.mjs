#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Production artifact smoke for the deployment preflight command.
 *
 * Same lesson as the ops-status smoke, applied before it can bite again: the runbook tells an
 * operator to run `ops:preflight` before a production deploy, and the production image copies
 * `dist/` and ships no `tsx`. A test that read `esbuild.config.mjs` would pass on a build that
 * cannot actually start. So this runs the artifact with plain `node` and judges what comes out.
 *
 * The scenario is the one that must behave well on a real host: a production-mode process whose
 * deployment identity and release are wrong. That is a configuration mistake, not a crash, so the
 * command must exit `PREFLIGHT_EXIT_CHECKS_FAILED`, print bounded findings, and leak nothing --
 * no key, no connection target, no stack trace.
 */

const ARTIFACT = 'dist/scripts/ops-preflight.js';
const RUN_TIMEOUT_MS = 20_000;
const PREFLIGHT_EXIT_CHECKS_FAILED = 1;
const MAX_OUTPUT_CHARACTERS = 8_000;

function fail(message) {
  process.stderr.write(`ops-preflight-artifact-smoke: FAIL -- ${message}\n`);
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

/**
 * A deployed production-mode environment with nothing configured.
 *
 * Unset variables are *removed* rather than set to '', because the API's schema validates shapes --
 * an empty string is not a URL and not a Stripe mode, so blanking them would fail at import and
 * this smoke would be asserting against a validation crash instead of the preflight report.
 */
function productionProfileEnv() {
  const env = { ...process.env };
  for (const key of [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'STRIPE_MODE',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_CORE_MONTHLY',
    'STRIPE_PRODUCT_CORE',
    'OPENAI_API_KEY',
    'OPENAI_WEBHOOK_SECRET',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_MESSAGING_WEBHOOK_BASE_URL',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_OAUTH_REDIRECT_URI',
    'EZYVET_PARTNER_ID',
    'AVENLYO_EXPECTED_SUPABASE_PROJECT_REF',
  ]) {
    delete env[key];
  }
  // The release is deliberately not a commit SHA and the public origins are deliberately staging,
  // so the checks that matter have something real to catch. No credential is supplied or needed.
  return {
    ...env,
    API_CORS_ORIGIN: 'https://staging.avenlyo.com',
    AVENLYO_DEPLOYMENT_ENV: 'production',
    AVENLYO_RELEASE: 'latest',
    NODE_ENV: 'production',
    WEB_CHAT_IFRAME_ORIGIN: 'https://staging.avenlyo.com',
  };
}

function run() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ARTIFACT], {
      env: productionProfileEnv(),
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

if (!existsSync(ARTIFACT)) {
  fail(`${ARTIFACT} does not exist -- the preflight command is not in the production artifact.`);
  process.exit(1);
}

const result = await run();

if (result.error) {
  fail(`could not execute the artifact under plain node: ${result.error.code ?? result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout}${result.stderr}`;

if (result.code !== PREFLIGHT_EXIT_CHECKS_FAILED) {
  fail(`expected exit ${PREFLIGHT_EXIT_CHECKS_FAILED} for a misconfigured production profile, got ${result.code}`);
}

if (!/RESULT: fail/.test(result.stdout)) {
  fail('expected a bounded "RESULT: fail" summary line');
}

if (!/release_is_exact_commit/.test(result.stdout)) {
  fail('expected the non-SHA release to be reported');
}

if (!/no_staging_host_in_production/.test(result.stdout)) {
  fail('expected the staging hostname in a production profile to be reported');
}

if (/\n\s+at\s+.+:\d+:\d+/.test(output)) {
  fail('a stack trace was printed for an expected configuration failure');
}

if (output.length > MAX_OUTPUT_CHARACTERS) {
  fail(`output was ${output.length} characters, above the ${MAX_OUTPUT_CHARACTERS} ceiling`);
}

for (const forbidden of FORBIDDEN) {
  if (output.includes(forbidden)) fail(`output contained a forbidden value shape: ${forbidden}`);
}

if (process.exitCode !== 1) {
  process.stdout.write(
    'ops-preflight-artifact-smoke: PASS -- artifact runs under plain node, fails closed on a bad ' +
      'production profile, bounded output, no stack trace, no secret or connection detail\n',
  );
}
