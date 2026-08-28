import {
  deploymentEnvironment,
  env,
  release,
  runtimeCapabilities,
} from '../env.js';
import { createServiceSupabaseClient } from '../lib/supabase.js';
import {
  evaluatePreflight,
  formatPreflightReport,
  type PreflightReport,
} from '../observability/preflight.js';
import { REQUIRED_SCHEMA_VERSION } from '../observability/readiness.js';

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
 */

export const PREFLIGHT_EXIT_OK = 0;
/** At least one check failed. The deployment should not proceed. */
export const PREFLIGHT_EXIT_CHECKS_FAILED = 1;
/** The configuration could not be read at all -- e.g. the deployment identity is missing. */
export const PREFLIGHT_EXIT_CONFIGURATION_INVALID = 2;

const PROBE_UNAVAILABLE =
  'The database did not answer the readiness probe; schema compatibility was not checked.\n';

export interface PreflightIo {
  readonly argv?: readonly string[];
  readonly stderr?: (text: string) => void;
  readonly stdout?: (text: string) => void;
}

/** Probes the schema, or returns null. Never surfaces a driver message: it can carry the host. */
async function probeSchemaVersion(stderr: (text: string) => void): Promise<number | null> {
  const supabase = createServiceSupabaseClient();
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
    const schemaVersion = await probeSchemaVersion(stderr);

    report = evaluatePreflight({
      capabilities: runtimeCapabilities,
      config: {
        apiCorsOrigin: env.API_CORS_ORIGIN,
        deploymentEnv: deploymentEnvironment,
        googleOauthRedirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
        release,
        stripeMode: env.STRIPE_MODE,
        supabaseUrl: env.SUPABASE_URL,
        twilioWebhookBaseUrl: env.TWILIO_MESSAGING_WEBHOOK_BASE_URL,
        webChatIframeOrigin: env.WEB_CHAT_IFRAME_ORIGIN,
      },
      deploymentEnvironment,
      expectedSupabaseProjectRef: env.AVENLYO_EXPECTED_SUPABASE_PROJECT_REF,
      release,
      requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
      schemaVersion,
      supabaseUrl: env.SUPABASE_URL,
    });
  } catch {
    // Reaching here means configuration could not be interpreted at all. The message is fixed: an
    // exception's own text is not printed, because a validation error can quote a value.
    stderr('Deployment configuration could not be evaluated. Check AVENLYO_DEPLOYMENT_ENV.\n');
    return PREFLIGHT_EXIT_CONFIGURATION_INVALID;
  }

  stdout(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatPreflightReport(report));
  return report.ok ? PREFLIGHT_EXIT_OK : PREFLIGHT_EXIT_CHECKS_FAILED;
}

if (process.argv[1]?.includes('ops-preflight')) {
  process.exitCode = await runOpsPreflight();
}
