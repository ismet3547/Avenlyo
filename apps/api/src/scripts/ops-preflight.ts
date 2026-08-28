import {
  evaluatePreflight,
  formatPreflightReport,
  type PreflightReport,
} from '../observability/preflight.js';

/**
 * Trusted operator command, run before or around a deployment.
 *
 * Read-only by construction. The only database call it makes is the same `platform_readiness_probe`
 * readiness already uses, which returns a schema version and nothing else; there is no write path
 * here, no provider client, and no tenant query. It will not send an SMS, place a call, create a
 * Checkout, book an appointment, or touch a row to see whether it can.
 *
 * It is a CLI rather than an HTTP route for the same reason `ops:status` is: Avenlyo has tenant
 * authorization and no platform-staff role, so a hidden super-admin endpoint would be pretending to
 * have an authorization boundary that does not exist.
 *
 * Failures here are configuration facts, not crashes, so they print as bounded lines and never as a
 * stack trace. Nothing from the environment is echoed -- findings name a setting and describe the
 * problem in source-controlled words.
 *
 * ## Why `../env.js` is imported dynamically
 *
 * `env.ts` validates and resolves the deployment identity at module scope, so a missing or invalid
 * AVENLYO_DEPLOYMENT_ENV throws during *import*. A static import here would therefore throw before
 * this file's own try/catch existed, and the process would die with an unhandled ESM rejection and a
 * stack trace -- exactly the output the exit-2 contract promises never to produce, and a stack trace
 * is precisely where an environment value is most likely to be quoted.
 *
 * The dynamic import moves that evaluation inside the guarded region. This weakens nothing at
 * runtime: the API server still imports `env.js` statically and still refuses to start when its
 * deployment identity is missing. What changes is only that the operator CLI gets to *report* that
 * failure as a bounded configuration finding instead of crashing while trying to describe it.
 */

export const PREFLIGHT_EXIT_OK = 0;
/** At least one check failed. The deployment should not proceed. */
export const PREFLIGHT_EXIT_CHECKS_FAILED = 1;
/** The configuration could not be read at all -- e.g. the deployment identity is missing. */
export const PREFLIGHT_EXIT_CONFIGURATION_INVALID = 2;

const PROBE_UNAVAILABLE =
  'The database did not answer the readiness probe; schema compatibility could not be proven.\n';

const CONFIGURATION_INVALID =
  'Deployment configuration could not be evaluated. Check AVENLYO_DEPLOYMENT_ENV and the other ' +
  'deployment settings named in deploy/env/api.env.example.\n';

export interface PreflightIo {
  readonly argv?: readonly string[];
  readonly stderr?: (text: string) => void;
  readonly stdout?: (text: string) => void;
}

/**
 * Everything the report needs from the validated environment, gathered behind one boundary.
 *
 * Separated from the evaluation so the import that can throw has exactly one call site, and so the
 * shape this command feeds the shared policy is visible in one place.
 */
async function loadDeploymentSnapshot() {
  const { deploymentEnvironment, env, release, runtimeCapabilities } = await import('../env.js');
  const { createServiceSupabaseClient } = await import('../lib/supabase.js');
  const { REQUIRED_SCHEMA_VERSION } = await import('../observability/readiness.js');

  return {
    capabilities: runtimeCapabilities,
    // The full deployment profile, not the subset the API happens to use for its own behaviour.
    // The AVENLYO_PROFILE_* half arrives from deploy/compose.yaml, which passes the same non-secret
    // values the build read; see the `api` service comment there.
    config: {
      apiCorsOrigin: env.API_CORS_ORIGIN,
      caddyApiHost: env.AVENLYO_PROFILE_API_HOST,
      caddyWebHost: env.AVENLYO_PROFILE_WEB_HOST,
      deploymentEnv: deploymentEnvironment,
      googleOauthRedirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
      internalApiUrl: env.AVENLYO_PROFILE_WEB_API_URL,
      publicApiUrl: env.AVENLYO_PROFILE_PUBLIC_API_URL,
      publicWebUrl: env.AVENLYO_PROFILE_APP_URL,
      release,
      stripeMode: env.STRIPE_MODE,
      supabaseUrl: env.SUPABASE_URL,
      twilioWebhookBaseUrl: env.TWILIO_MESSAGING_WEBHOOK_BASE_URL,
      webChatIframeOrigin: env.WEB_CHAT_IFRAME_ORIGIN,
    },
    createServiceSupabaseClient,
    deploymentEnvironment,
    expectedSupabaseProjectRef: env.AVENLYO_EXPECTED_SUPABASE_PROJECT_REF,
    release,
    requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
    supabaseUrl: env.SUPABASE_URL,
  };
}

/** Probes the schema, or returns null. Never surfaces a driver message: it can carry the host. */
async function probeSchemaVersion(
  createClient: () => ReturnType<
    Awaited<ReturnType<typeof loadDeploymentSnapshot>>['createServiceSupabaseClient']
  >,
  stderr: (text: string) => void,
): Promise<number | null> {
  const supabase = createClient();
  if (!supabase) return null;
  try {
    const probe = await supabase.rpc('platform_readiness_probe');
    const row = probe.data?.[0];
    if (probe.error || !row) {
      stderr(PROBE_UNAVAILABLE);
      return null;
    }
    return row.schema_version;
  } catch {
    stderr(PROBE_UNAVAILABLE);
    return null;
  }
}

export async function runOpsPreflight(io: PreflightIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const argv = io.argv ?? process.argv;

  let report: PreflightReport;
  try {
    const snapshot = await loadDeploymentSnapshot();
    const schemaVersion = await probeSchemaVersion(snapshot.createServiceSupabaseClient, stderr);

    report = evaluatePreflight({
      capabilities: snapshot.capabilities,
      config: snapshot.config,
      deploymentEnvironment: snapshot.deploymentEnvironment,
      expectedSupabaseProjectRef: snapshot.expectedSupabaseProjectRef,
      release: snapshot.release,
      requiredSchemaVersion: snapshot.requiredSchemaVersion,
      schemaVersion,
      supabaseUrl: snapshot.supabaseUrl,
    });
  } catch {
    // Reaching here means configuration could not be interpreted at all. The message is fixed: an
    // exception's own text is not printed, because a validation error can quote a value.
    stderr(CONFIGURATION_INVALID);
    return PREFLIGHT_EXIT_CONFIGURATION_INVALID;
  }

  stdout(
    argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatPreflightReport(report),
  );
  return report.ok ? PREFLIGHT_EXIT_OK : PREFLIGHT_EXIT_CHECKS_FAILED;
}

if (process.argv[1]?.includes('ops-preflight')) {
  process.exitCode = await runOpsPreflight();
}
