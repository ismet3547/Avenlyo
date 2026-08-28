/**
 * Which deployment this process belongs to, and whether its public configuration is self-consistent.
 *
 * ## Why NODE_ENV cannot answer this
 *
 * Staging runs `NODE_ENV=production`, deliberately, so that it exercises production runtime
 * behaviour rather than a friendlier development path. Real production will run `NODE_ENV=production`
 * too. The two are therefore indistinguishable by `NODE_ENV`, and every check that matters here --
 * "is a staging hostname allowed in this origin", "must Stripe be live", "must the release be an
 * exact commit" -- needs to tell them apart. `NODE_ENV` stays what it is: the Node/Next runtime
 * mode. `AVENLYO_DEPLOYMENT_ENV` is the deployment identity, and it is explicit.
 *
 * Deriving the identity from a hostname was rejected. A hostname is a value the deployment supplies,
 * so inferring identity from it means the thing being validated also decides which rules apply to
 * it -- a cross-wired production deploy pointing at a staging domain would classify itself as
 * staging and pass. The identity is declared, and the hostnames are then checked against it.
 *
 * ## What this module is
 *
 * Pure. No `process.env`, no I/O, no clock. Everything is a function of its input, so the same rules
 * run in the API's runtime validation, in `ops:preflight`, in CI's rendered-configuration check and
 * in unit tests without four implementations drifting apart.
 */

export const DEPLOYMENT_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

/** Deployments where a release is a real artifact rather than a working copy. */
export const DEPLOYED_ENVIRONMENTS: readonly DeploymentEnvironment[] = ['staging', 'production'];

export function isDeploymentEnvironment(value: unknown): value is DeploymentEnvironment {
  return (
    typeof value === 'string' && (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

export class DeploymentEnvironmentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DeploymentEnvironmentError';
  }
}

/**
 * Resolve the deployment identity, failing closed.
 *
 * A missing value is only allowed to mean `development`, and only when the Node runtime mode is not
 * `production`. A container running `NODE_ENV=production` without an explicit deployment identity is
 * the ambiguous case this whole module exists to prevent, so it raises rather than guessing. Test
 * runs are development for this purpose.
 */
export function resolveDeploymentEnvironment(input: {
  readonly deploymentEnv?: string | undefined;
  readonly nodeEnv?: string | undefined;
}): DeploymentEnvironment {
  const declared = input.deploymentEnv?.trim();

  if (declared) {
    if (!isDeploymentEnvironment(declared)) {
      throw new DeploymentEnvironmentError(
        `AVENLYO_DEPLOYMENT_ENV must be one of ${DEPLOYMENT_ENVIRONMENTS.join(', ')}.`,
      );
    }
    return declared;
  }

  if (input.nodeEnv === 'production') {
    throw new DeploymentEnvironmentError(
      'AVENLYO_DEPLOYMENT_ENV is required when NODE_ENV=production, because staging and production ' +
        'both run in production mode and cannot be told apart without it.',
    );
  }

  return 'development';
}

// ---------------------------------------------------------------------------------------------
// Release identity
// ---------------------------------------------------------------------------------------------

const EXACT_SHA = /^[0-9a-f]{40}$/;

/**
 * A deployed release is an exact, immutable commit.
 *
 * Not `latest`, not a branch, not an abbreviated SHA, not a timestamp: the deployment model is
 * build-once under a SHA tag and deploy that exact image, and a mutable identifier silently breaks
 * the rollback guarantee that depends on a tag meaning one set of bytes forever.
 */
export function isExactReleaseSha(value: unknown): boolean {
  return typeof value === 'string' && EXACT_SHA.test(value);
}

// ---------------------------------------------------------------------------------------------
// Hostname classification
// ---------------------------------------------------------------------------------------------

/**
 * Hostnames this repository knows belong to the staging deployment.
 *
 * Source-controlled because that is the only way a configuration check can be honest: the policy can
 * prove "this production config names a hostname we know is staging", which is a real cross-wire. It
 * deliberately does not carry a production API hostname -- that is a deployment decision, not a fact
 * this repository owns, and hardcoding one would turn an unmade decision into an invariant.
 */
export const STAGING_HOSTNAMES: readonly string[] = ['staging.avenlyo.com', 'api-staging.avenlyo.com'];

/** The production web origin is a settled product fact; the production API hostname is not. */
export const PRODUCTION_WEB_HOSTNAMES: readonly string[] = ['avenlyo.com', 'www.avenlyo.com'];

export function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The normalized browser origin -- scheme, host and port together.
 *
 * Origin, not hostname, because the browser's same-origin rule is not a hostname rule.
 * `https://avenlyo.com` and `https://avenlyo.com:444` share a hostname and are different origins, so
 * a CORS allow-list or an iframe ancestor check compared by hostname would call a real mismatch
 * agreement. `URL.origin` also elides the default port, so `https://avenlyo.com:443` and
 * `https://avenlyo.com` compare equal -- which they should, being genuinely the same origin.
 */
export function originOf(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The only TLS port this topology serves.
 *
 * `deploy/compose.yaml` has Caddy publish 80, 443 and 443/udp, and nothing else. A public URL naming
 * any other port describes an endpoint no container is listening on, so the deployment would build a
 * browser bundle that calls an address the host does not answer -- and the agreement checks above
 * would happily pass it, because every hostname involved would still match.
 */
export const CADDY_PUBLISHED_TLS_PORT = '443';

/** The explicit port in a URL, `''` when it is the scheme default, `null` when unparseable. */
export function portOf(value: string): string | null {
  try {
    return new URL(value).port;
  } catch {
    return null;
  }
}

/** True for a hostname this repository knows is staging, including the `*-staging.avenlyo.com` shape. */
export function isStagingHostname(host: string | null): boolean {
  if (!host) return false;
  if (STAGING_HOSTNAMES.includes(host)) return true;
  return host.endsWith('.avenlyo.com') && /(^|[.-])staging\./.test(`${host}.`);
}

export function isProductionWebHostname(host: string | null): boolean {
  return host !== null && PRODUCTION_WEB_HOSTNAMES.includes(host);
}

// ---------------------------------------------------------------------------------------------
// Deployment configuration policy
// ---------------------------------------------------------------------------------------------

export type DeploymentCheckSeverity = 'error' | 'warning';

/**
 * One finding. `setting` is the variable NAME only and `detail` is source-controlled text -- neither
 * ever carries a value, so a report can be printed by an operator holding the service-role key
 * without leaking what it holds.
 */
export interface DeploymentFinding {
  readonly check: string;
  readonly detail: string;
  readonly setting: string;
  readonly severity: DeploymentCheckSeverity;
}

/**
 * Public, non-secret deployment configuration.
 *
 * Every field here is a URL, a hostname, a mode flag or an identifier. No key, token or secret is
 * accepted by this policy at all, which is what lets CI run it against placeholder profiles and lets
 * the preflight print its findings.
 */
export interface DeploymentConfigInput {
  readonly apiCorsOrigin?: string | undefined;
  readonly caddyApiHost?: string | undefined;
  readonly caddyWebHost?: string | undefined;
  readonly deploymentEnv: DeploymentEnvironment;
  /** Server-side URL the web container uses to reach the API inside the compose network. */
  readonly internalApiUrl?: string | undefined;
  readonly googleOauthRedirectUri?: string | undefined;
  readonly publicApiUrl?: string | undefined;
  readonly publicWebUrl?: string | undefined;
  readonly release?: string | undefined;
  readonly stripeMode?: string | undefined;
  readonly supabaseUrl?: string | undefined;
  /** Optional, non-secret. Lets the policy prove the project is the intended one; see the note below. */
  readonly expectedSupabaseProjectRef?: string | undefined;
  readonly twilioWebhookBaseUrl?: string | undefined;
  readonly webChatIframeOrigin?: string | undefined;
}

/** The internal boundary Phase 19 established. Source-controlled: a deployment does not get to pick. */
export const INTERNAL_API_URL = 'http://caddy:8080';

function requireHttps(
  findings: DeploymentFinding[],
  setting: string,
  value: string | undefined,
  check: string,
): void {
  if (!value) return;
  if (!value.startsWith('https://')) {
    findings.push({
      check,
      detail: 'must use https in a deployed environment',
      setting,
      severity: 'error',
    });
  }
}

function rejectStagingHost(
  findings: DeploymentFinding[],
  setting: string,
  value: string | undefined,
  check: string,
): void {
  if (!value) return;
  if (isStagingHostname(hostnameOf(value))) {
    findings.push({
      check,
      detail: 'names a known staging hostname while the deployment environment is production',
      setting,
      severity: 'error',
    });
  }
}

function rejectProductionWebHost(
  findings: DeploymentFinding[],
  setting: string,
  value: string | undefined,
  check: string,
): void {
  if (!value) return;
  if (isProductionWebHostname(hostnameOf(value))) {
    findings.push({
      check,
      detail: 'names the production web hostname while the deployment environment is staging',
      setting,
      severity: 'error',
    });
  }
}

/**
 * Evaluate a deployment's public configuration.
 *
 * Only conditions that configuration can actually prove are checked. The policy never claims to know
 * something it cannot see -- see `supabaseIdentityAssurance` below for the one place where that
 * distinction is load-bearing.
 */
export function evaluateDeploymentConfig(input: DeploymentConfigInput): readonly DeploymentFinding[] {
  const findings: DeploymentFinding[] = [];
  const deployed = DEPLOYED_ENVIRONMENTS.includes(input.deploymentEnv);

  // -- Release identity ----------------------------------------------------------------------
  if (deployed && !isExactReleaseSha(input.release)) {
    findings.push({
      check: 'release_is_exact_commit',
      detail: 'must be a full 40-character lowercase commit SHA for a deployed release',
      setting: 'AVENLYO_RELEASE',
      severity: 'error',
    });
  }

  // -- Internal boundary ---------------------------------------------------------------------
  // Phase 19 put web and api on separate networks, so the web container reaches the API only
  // through Caddy's unpublished internal listener. A deployment that points this anywhere else has
  // either lost the network split or is routing internal traffic over the public internet.
  if (deployed && input.internalApiUrl && input.internalApiUrl !== INTERNAL_API_URL) {
    findings.push({
      check: 'internal_api_boundary',
      detail: `must be ${INTERNAL_API_URL} so server-side web traffic keeps crossing the Caddy boundary`,
      setting: 'AVENLYO_API_URL',
      severity: 'error',
    });
  }

  if (!deployed) return findings;

  // -- Public schemes ------------------------------------------------------------------------
  for (const [setting, value] of [
    ['NEXT_PUBLIC_APP_URL', input.publicWebUrl],
    ['NEXT_PUBLIC_AVENLYO_API_URL', input.publicApiUrl],
    ['API_CORS_ORIGIN', input.apiCorsOrigin],
    ['WEB_CHAT_IFRAME_ORIGIN', input.webChatIframeOrigin],
    ['GOOGLE_OAUTH_REDIRECT_URI', input.googleOauthRedirectUri],
    ['TWILIO_MESSAGING_WEBHOOK_BASE_URL', input.twilioWebhookBaseUrl],
  ] as const) {
    requireHttps(findings, setting, value, 'public_scheme_is_https');
  }

  // -- Public ports --------------------------------------------------------------------------
  // Checked before the agreement rules below, because a port drift is invisible to them: every
  // hostname still matches, and the deployment ships a bundle calling a port nothing publishes.
  for (const [setting, value] of [
    ['NEXT_PUBLIC_APP_URL', input.publicWebUrl],
    ['NEXT_PUBLIC_AVENLYO_API_URL', input.publicApiUrl],
    ['API_CORS_ORIGIN', input.apiCorsOrigin],
    ['WEB_CHAT_IFRAME_ORIGIN', input.webChatIframeOrigin],
  ] as const) {
    if (value === undefined) continue;
    const port = portOf(value);
    if (port !== null && port !== '' && port !== CADDY_PUBLISHED_TLS_PORT) {
      findings.push({
        check: 'public_port_is_published',
        detail: `names a port Caddy does not publish; this topology serves ${CADDY_PUBLISHED_TLS_PORT} only`,
        setting,
        severity: 'error',
      });
    }
  }

  // -- Origin agreement ----------------------------------------------------------------------
  // These three must name the same browser *origin*. CORS and the Web Chat iframe check are the two
  // controls standing between a customer's site and this API; if either drifts from the app's own
  // origin the widget breaks, or worse, trusts the wrong one.
  //
  // Compared as origins rather than hostnames because that is the rule the browser actually applies:
  // https://avenlyo.com and https://avenlyo.com:444 are different origins sharing a hostname, and a
  // hostname comparison would call that pair agreement.
  const webOrigin = originOf(input.publicWebUrl ?? '');
  for (const [setting, value] of [
    ['API_CORS_ORIGIN', input.apiCorsOrigin],
    ['WEB_CHAT_IFRAME_ORIGIN', input.webChatIframeOrigin],
  ] as const) {
    const origin = originOf(value ?? '');
    if (webOrigin && origin && origin !== webOrigin) {
      findings.push({
        check: 'public_web_origin_agreement',
        detail: 'does not name the same browser origin as NEXT_PUBLIC_APP_URL',
        setting,
        severity: 'error',
      });
    }
  }
  const webHost = hostnameOf(input.publicWebUrl ?? '');

  // The public API URL the browser is built against and the hostname Caddy answers on must agree,
  // or the compiled bundle calls an endpoint this deployment does not serve.
  const publicApiHost = hostnameOf(input.publicApiUrl ?? '');
  if (publicApiHost && input.caddyApiHost && publicApiHost !== input.caddyApiHost.toLowerCase()) {
    findings.push({
      check: 'public_api_host_agreement',
      detail: 'does not match the hostname Caddy is configured to serve the API on',
      setting: 'NEXT_PUBLIC_AVENLYO_API_URL',
      severity: 'error',
    });
  }
  if (webHost && input.caddyWebHost && webHost !== input.caddyWebHost.toLowerCase()) {
    findings.push({
      check: 'public_web_host_agreement',
      detail: 'does not match the hostname Caddy is configured to serve the web app on',
      setting: 'NEXT_PUBLIC_APP_URL',
      severity: 'error',
    });
  }

  // -- Cross-environment wiring --------------------------------------------------------------
  const environmentSensitive = [
    ['NEXT_PUBLIC_APP_URL', input.publicWebUrl],
    ['NEXT_PUBLIC_AVENLYO_API_URL', input.publicApiUrl],
    ['API_CORS_ORIGIN', input.apiCorsOrigin],
    ['WEB_CHAT_IFRAME_ORIGIN', input.webChatIframeOrigin],
    ['GOOGLE_OAUTH_REDIRECT_URI', input.googleOauthRedirectUri],
    ['TWILIO_MESSAGING_WEBHOOK_BASE_URL', input.twilioWebhookBaseUrl],
  ] as const;

  if (input.deploymentEnv === 'production') {
    for (const [setting, value] of environmentSensitive) {
      rejectStagingHost(findings, setting, value, 'no_staging_host_in_production');
    }
    for (const host of [input.caddyWebHost, input.caddyApiHost]) {
      if (host && isStagingHostname(host.toLowerCase())) {
        findings.push({
          check: 'no_staging_host_in_production',
          detail: 'Caddy is configured to serve a known staging hostname in production',
          setting: host === input.caddyWebHost ? 'AVENLYO_WEB_HOST' : 'AVENLYO_API_HOST',
          severity: 'error',
        });
      }
    }
    if (input.stripeMode === 'test') {
      findings.push({
        check: 'stripe_mode_not_test_in_production',
        detail: 'is test mode while the deployment environment is production',
        setting: 'STRIPE_MODE',
        severity: 'error',
      });
    }
  }

  if (input.deploymentEnv === 'staging') {
    // The reverse cross-wire, checked only where the repository owns the truth: the production web
    // origin is a settled fact, so a staging deployment naming it is provably wrong. There is no
    // equivalent claim to make about a production API hostname, because none is decided here.
    for (const [setting, value] of environmentSensitive) {
      rejectProductionWebHost(findings, setting, value, 'no_production_host_in_staging');
    }
  }

  return findings;
}

/**
 * What can, and cannot, be proven about which Supabase project a deployment points at.
 *
 * A project URL is an opaque ref. Nothing in it says "staging" or "production", so pointing a
 * production deployment at the staging database is NOT detectable from the URL alone -- and claiming
 * otherwise would be a fake guarantee, which is worse than no check.
 *
 * The smallest honest fix is an explicit expectation: if the deployment declares which project ref
 * it intends, a mismatch becomes provable. When it does not, this reports `unverified` and the
 * runbook carries it as an operator verification step rather than pretending it is covered.
 */
export function supabaseIdentityAssurance(input: {
  readonly expectedProjectRef?: string | undefined;
  readonly supabaseUrl?: string | undefined;
}): { readonly detail: string; readonly status: 'match' | 'mismatch' | 'unverified' } {
  const expected = input.expectedProjectRef?.trim();
  if (!expected) {
    return {
      detail:
        'no expected project ref declared; a project URL cannot prove which environment it belongs to',
      status: 'unverified',
    };
  }
  const host = hostnameOf(input.supabaseUrl ?? '');
  if (!host) {
    return { detail: 'SUPABASE_URL is missing or not a URL', status: 'mismatch' };
  }
  const actualRef = host.split('.')[0] ?? '';
  return actualRef === expected
    ? { detail: 'configured project ref matches the declared expectation', status: 'match' }
    : { detail: 'configured project ref does not match the declared expectation', status: 'mismatch' };
}
