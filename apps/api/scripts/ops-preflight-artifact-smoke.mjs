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
 * Every scenario below is a real spawn of the built command with a real environment. None of them
 * calls the policy functions directly -- the point is to exercise the path an operator actually
 * runs, including the environment parsing that happens at import time, because that boundary is
 * where a preflight can fail in a way a unit test cannot see.
 *
 * Nothing here contacts a database or a provider. Supabase is deliberately unconfigured, so the
 * schema probe is skipped for want of a client rather than by reaching anything.
 */

const ARTIFACT = 'dist/scripts/ops-preflight.js';
const RUN_TIMEOUT_MS = 20_000;
const PREFLIGHT_EXIT_CHECKS_FAILED = 1;
const PREFLIGHT_EXIT_CONFIGURATION_INVALID = 2;
const MAX_OUTPUT_CHARACTERS = 8_000;

let failures = 0;
function fail(scenario, message) {
  failures += 1;
  process.stderr.write(`ops-preflight-artifact-smoke: FAIL [${scenario}] -- ${message}\n`);
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

const CLEARED = [
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
  'AVENLYO_DEPLOYMENT_ENV',
  'AVENLYO_PROFILE_APP_URL',
  'AVENLYO_PROFILE_PUBLIC_API_URL',
  'AVENLYO_PROFILE_WEB_HOST',
  'AVENLYO_PROFILE_API_HOST',
  'AVENLYO_PROFILE_WEB_API_URL',
];

/**
 * A deployed production-mode environment, with the caller's overrides applied last.
 *
 * Unset variables are *removed* rather than set to '', because the API's schema validates shapes --
 * an empty string is not a URL and not a Stripe mode, so blanking them would fail at import and this
 * smoke would be asserting against a validation crash instead of the preflight report.
 */
function profileEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of CLEARED) delete env[key];
  const merged = {
    ...env,
    AVENLYO_DEPLOYMENT_ENV: 'production',
    NODE_ENV: 'production',
    ...overrides,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged;
}

/** A coherent production profile, which individual scenarios then break in exactly one way. */
function healthyProductionProfile(overrides = {}) {
  return profileEnv({
    API_CORS_ORIGIN: 'https://avenlyo.com',
    AVENLYO_PROFILE_API_HOST: 'api.avenlyo.com',
    AVENLYO_PROFILE_APP_URL: 'https://avenlyo.com',
    AVENLYO_PROFILE_PUBLIC_API_URL: 'https://api.avenlyo.com',
    AVENLYO_PROFILE_WEB_API_URL: 'http://caddy:8080',
    AVENLYO_PROFILE_WEB_HOST: 'avenlyo.com',
    AVENLYO_RELEASE: 'c000caf742f7e4ca5d8dc85376931fcbb7a9e6a7',
    WEB_CHAT_IFRAME_ORIGIN: 'https://avenlyo.com',
    ...overrides,
  });
}

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ARTIFACT], {
      env,
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

/** Every scenario must respect these, whatever else it asserts. */
function assertBoundedAndClean(scenario, result, extraForbidden = []) {
  const output = `${result.stdout}${result.stderr}`;

  if (/\n\s+at\s+.+:\d+:\d+/.test(output)) {
    fail(scenario, 'a stack trace was printed for an expected configuration failure');
  }
  if (output.length > MAX_OUTPUT_CHARACTERS) {
    fail(scenario, `output was ${output.length} characters, above the ${MAX_OUTPUT_CHARACTERS} ceiling`);
  }
  for (const forbidden of [...FORBIDDEN, ...extraForbidden]) {
    if (output.includes(forbidden)) {
      fail(scenario, `output contained a forbidden value shape: ${forbidden}`);
    }
  }
  return output;
}

async function expectChecksFailed(scenario, env, expectedCheck, forbidden = []) {
  const result = await run(env);
  if (result.error) {
    fail(scenario, `could not execute the artifact: ${result.error.code ?? result.error.message}`);
    return;
  }
  if (result.code !== PREFLIGHT_EXIT_CHECKS_FAILED) {
    fail(scenario, `expected exit ${PREFLIGHT_EXIT_CHECKS_FAILED}, got ${result.code}`);
  }
  if (!/RESULT: fail/.test(result.stdout)) {
    fail(scenario, 'expected a bounded "RESULT: fail" summary line');
  }
  if (!result.stdout.includes(expectedCheck)) {
    fail(scenario, `expected the report to name ${expectedCheck}`);
  }
  assertBoundedAndClean(scenario, result, forbidden);
}

// ---------------------------------------------------------------------------------------------
if (!existsSync(ARTIFACT)) {
  fail('artifact', `${ARTIFACT} does not exist -- the preflight command is not in the build.`);
  process.exit(1);
}

// -- Exit 2: the configuration cannot be interpreted at all ------------------------------------
// The contract says a configuration that cannot be parsed exits 2 with bounded fixed text. This
// used to be unreachable: env.ts resolves the deployment identity at module scope, so a static
// import threw before the command's own try/catch existed and the process died with an unhandled
// rejection and a stack trace. These two scenarios are the reason the import is dynamic.
for (const [scenario, overrides] of [
  ['missing deployment identity', { AVENLYO_DEPLOYMENT_ENV: undefined }],
  ['invalid deployment identity', { AVENLYO_DEPLOYMENT_ENV: 'prod' }],
]) {
  const result = await run(healthyProductionProfile(overrides));

  if (result.error) {
    fail(scenario, `could not execute the artifact: ${result.error.code ?? result.error.message}`);
  } else {
    if (result.code !== PREFLIGHT_EXIT_CONFIGURATION_INVALID) {
      fail(scenario, `expected exit ${PREFLIGHT_EXIT_CONFIGURATION_INVALID}, got ${result.code}`);
    }
    const output = assertBoundedAndClean(scenario, result, ['prod']);
    if (!output.includes('AVENLYO_DEPLOYMENT_ENV')) {
      fail(scenario, 'expected the fixed message to name the setting to check');
    }
    // An unhandled ESM rejection prints this; a caught configuration failure does not.
    if (/DeploymentEnvironmentError|ZodError|Unhandled/.test(output)) {
      fail(scenario, 'the failure escaped as an exception rather than a bounded finding');
    }
  }
}

// -- Exit 1: real check failures, driven through the real environment path ---------------------
// Each of these is a defect the documentation claims preflight catches. They are asserted here,
// through the built CLI reading actual environment variables, rather than by handing a complete
// object to evaluateDeploymentConfig -- a policy that is never reached by the command is a policy
// that does not protect a deployment.
await expectChecksFailed(
  'non-SHA release and staging host in production',
  healthyProductionProfile({
    API_CORS_ORIGIN: 'https://staging.avenlyo.com',
    AVENLYO_PROFILE_APP_URL: 'https://staging.avenlyo.com',
    AVENLYO_PROFILE_WEB_HOST: 'staging.avenlyo.com',
    AVENLYO_RELEASE: 'latest',
    WEB_CHAT_IFRAME_ORIGIN: 'https://staging.avenlyo.com',
  }),
  'release_is_exact_commit',
  ['staging.avenlyo.com'],
);

await expectChecksFailed(
  'CORS origin drifted from the app origin',
  healthyProductionProfile({ API_CORS_ORIGIN: 'https://other.example.com' }),
  'public_web_origin_agreement',
  ['other.example.com'],
);

await expectChecksFailed(
  'browser API URL does not match the host Caddy serves',
  healthyProductionProfile({ AVENLYO_PROFILE_PUBLIC_API_URL: 'https://wrong.example.com' }),
  'public_api_host_agreement',
  ['wrong.example.com'],
);

await expectChecksFailed(
  'web container bypasses the Caddy boundary',
  healthyProductionProfile({ AVENLYO_PROFILE_WEB_API_URL: 'http://api:4000' }),
  'internal_api_boundary',
  ['http://api:4000'],
);

await expectChecksFailed(
  'production Supabase identity is unverified',
  // Nothing declared, so the deployment cannot prove which database it is about to point at.
  healthyProductionProfile(),
  'supabase_project_identity',
);

if (failures === 0) {
  process.stdout.write(
    'ops-preflight-artifact-smoke: PASS -- artifact runs under plain node; exit 2 is bounded and ' +
      'stack-trace-free for an uninterpretable configuration; the real CLI path catches release, ' +
      'origin, host-agreement, Caddy-boundary and Supabase-identity defects; no secret leaked\n',
  );
}
