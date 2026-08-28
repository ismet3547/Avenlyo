import { describe, expect, it } from 'vitest';

import {
  DeploymentEnvironmentError,
  evaluateDeploymentConfig,
  INTERNAL_API_URL,
  isExactReleaseSha,
  GOOGLE_OAUTH_CALLBACK_PATH,
  isStagingHostname,
  REQUIRED_DEPLOYED_PROFILE_SETTINGS,
  resolveDeploymentEnvironment,
  supabaseIdentityAssurance,
  SUPABASE_PROJECT_HOST_SUFFIX,
  supabaseProjectRefOf,
  TWILIO_WEBHOOK_BASE_PATH,
  type DeploymentConfigInput,
} from './deployment';

/**
 * The deployment contract.
 *
 * These are the checks that stand between "the deploy command succeeded" and "the deploy went to the
 * right place". Every one of them is written as a defect that would otherwise reach production
 * silently, and the negative cases matter more than the positive ones: a guard nobody has seen fail
 * is a guard nobody has tested.
 */

const SHA = 'c000caf742f7e4ca5d8dc85376931fcbb7a9e6a7';

/** A legitimate staging profile, matching what deploy/env/*.example describe today. */
const staging: DeploymentConfigInput = {
  apiCorsOrigin: 'https://staging.avenlyo.com',
  caddyApiHost: 'api-staging.avenlyo.com',
  caddyWebHost: 'staging.avenlyo.com',
  deploymentEnv: 'staging',
  internalApiUrl: INTERNAL_API_URL,
  profileDeploymentEnv: 'staging',
  publicApiUrl: 'https://api-staging.avenlyo.com',
  publicWebUrl: 'https://staging.avenlyo.com',
  release: SHA,
  webChatIframeOrigin: 'https://staging.avenlyo.com',
};

/** A legitimate production profile built from placeholders. No secret, no DNS claim. */
const production: DeploymentConfigInput = {
  apiCorsOrigin: 'https://avenlyo.com',
  caddyApiHost: 'api.avenlyo.com',
  caddyWebHost: 'avenlyo.com',
  deploymentEnv: 'production',
  internalApiUrl: INTERNAL_API_URL,
  profileDeploymentEnv: 'production',
  publicApiUrl: 'https://api.avenlyo.com',
  publicWebUrl: 'https://avenlyo.com',
  release: SHA,
  webChatIframeOrigin: 'https://avenlyo.com',
};

const errors = (input: DeploymentConfigInput) =>
  evaluateDeploymentConfig(input).filter((f) => f.severity === 'error');
const checks = (input: DeploymentConfigInput) => errors(input).map((f) => f.check);

describe('the deployment identity is declared, never inferred', () => {
  it('defaults to development when nothing is deployed', () => {
    expect(resolveDeploymentEnvironment({ nodeEnv: 'development' })).toBe('development');
    expect(resolveDeploymentEnvironment({ nodeEnv: 'test' })).toBe('development');
    expect(resolveDeploymentEnvironment({})).toBe('development');
  });

  it('refuses to guess when NODE_ENV=production and nothing was declared', () => {
    // The whole point: staging and production are both NODE_ENV=production, so a missing identity is
    // ambiguous rather than "probably production". Ambiguity fails closed.
    expect(() => resolveDeploymentEnvironment({ nodeEnv: 'production' })).toThrow(
      DeploymentEnvironmentError,
    );
  });

  it('tells staging and production apart even though NODE_ENV cannot', () => {
    expect(resolveDeploymentEnvironment({ deploymentEnv: 'staging', nodeEnv: 'production' })).toBe(
      'staging',
    );
    expect(
      resolveDeploymentEnvironment({ deploymentEnv: 'production', nodeEnv: 'production' }),
    ).toBe('production');
  });

  it('rejects an invalid value deterministically rather than falling back', () => {
    for (const value of ['prod', 'PRODUCTION', 'stage', 'live', 'true', '1']) {
      expect(() => resolveDeploymentEnvironment({ deploymentEnv: value })).toThrow(
        DeploymentEnvironmentError,
      );
    }
  });

  it('never lets a declared identity be overridden by NODE_ENV', () => {
    expect(resolveDeploymentEnvironment({ deploymentEnv: 'staging', nodeEnv: 'development' })).toBe(
      'staging',
    );
  });
});

describe('a deployed release is an exact commit', () => {
  it('accepts a full lowercase 40-character SHA', () => {
    expect(isExactReleaseSha(SHA)).toBe(true);
  });

  it('rejects everything a mutable tag could be', () => {
    for (const value of [
      'unknown',
      'local',
      'latest',
      'main',
      'feat/phase-20-production-readiness',
      SHA.slice(0, 7),
      SHA.toUpperCase(),
      '2026-08-28T09:00:00Z',
      '',
      undefined,
      null,
    ]) {
      expect(isExactReleaseSha(value)).toBe(false);
    }
  });

  it('requires it for both deployed environments, and not for development', () => {
    expect(checks({ ...staging, release: 'latest' })).toContain('release_is_exact_commit');
    expect(checks({ ...production, release: 'latest' })).toContain('release_is_exact_commit');
    expect(errors({ deploymentEnv: 'development', release: 'local' })).toEqual([]);
  });
});

describe('legitimate profiles pass', () => {
  it('accepts the current staging configuration unchanged', () => {
    expect(errors(staging)).toEqual([]);
  });

  it('accepts a production placeholder configuration', () => {
    expect(errors(production)).toEqual([]);
  });

  it('leaves development alone', () => {
    expect(
      errors({
        apiCorsOrigin: 'http://localhost:3000',
        deploymentEnv: 'development',
        internalApiUrl: 'http://localhost:4000',
        publicWebUrl: 'http://localhost:3000',
        webChatIframeOrigin: 'http://localhost:3000',
      }),
    ).toEqual([]);
  });
});

describe('a staging hostname cannot reach a production deployment', () => {
  const settings = [
    'publicWebUrl',
    'publicApiUrl',
    'apiCorsOrigin',
    'webChatIframeOrigin',
    'googleOauthRedirectUri',
    'twilioWebhookBaseUrl',
  ] as const;

  for (const setting of settings) {
    it(`catches a staging host injected into ${setting}`, () => {
      const injected = { ...production, [setting]: 'https://staging.avenlyo.com' };
      expect(checks(injected)).toContain('no_staging_host_in_production');
    });
  }

  it('catches a staging host on either Caddy site', () => {
    expect(checks({ ...production, caddyWebHost: 'staging.avenlyo.com' })).toContain(
      'no_staging_host_in_production',
    );
    expect(checks({ ...production, caddyApiHost: 'api-staging.avenlyo.com' })).toContain(
      'no_staging_host_in_production',
    );
  });

  it('recognises the -staging shape, not just the two literal hosts', () => {
    expect(isStagingHostname('staging.avenlyo.com')).toBe(true);
    expect(isStagingHostname('api-staging.avenlyo.com')).toBe(true);
    expect(isStagingHostname('avenlyo.com')).toBe(false);
    expect(isStagingHostname('api.avenlyo.com')).toBe(false);
    expect(isStagingHostname(null)).toBe(false);
  });

  it('catches the reverse cross-wire where the repository owns the truth', () => {
    // The production web origin is a settled fact, so staging naming it is provably wrong. There is
    // deliberately no equivalent assertion about a production API hostname.
    expect(checks({ ...staging, apiCorsOrigin: 'https://avenlyo.com' })).toContain(
      'no_production_host_in_staging',
    );
  });
});

describe('public transport and origin agreement', () => {
  it('rejects plain HTTP on a deployed public setting', () => {
    expect(checks({ ...production, publicWebUrl: 'http://avenlyo.com' })).toContain(
      'public_scheme_is_https',
    );
    expect(checks({ ...staging, webChatIframeOrigin: 'http://staging.avenlyo.com' })).toContain(
      'public_scheme_is_https',
    );
  });

  it('catches CORS or the iframe origin drifting from the app origin', () => {
    expect(checks({ ...production, apiCorsOrigin: 'https://elsewhere.example' })).toContain(
      'public_web_origin_agreement',
    );
    expect(checks({ ...production, webChatIframeOrigin: 'https://elsewhere.example' })).toContain(
      'public_web_origin_agreement',
    );
  });

  it('catches the browser bundle being built against a host Caddy does not serve', () => {
    expect(checks({ ...production, publicApiUrl: 'https://api2.avenlyo.com' })).toContain(
      'public_api_host_agreement',
    );
  });
});

describe('the Phase 19 internal boundary is part of the contract', () => {
  it('requires server-side web traffic to cross the Caddy boundary', () => {
    // Reverting to http://api:4000 would mean the network split was undone.
    expect(checks({ ...production, internalApiUrl: 'http://api:4000' })).toContain(
      'internal_api_boundary',
    );
    expect(checks({ ...staging, internalApiUrl: 'https://api-staging.avenlyo.com' })).toContain(
      'internal_api_boundary',
    );
  });

  it('accepts exactly the source-controlled internal URL', () => {
    expect(INTERNAL_API_URL).toBe('http://caddy:8080');
    expect(checks(production)).not.toContain('internal_api_boundary');
  });
});

describe('production Stripe cannot be in test mode', () => {
  it('fails when production declares test mode', () => {
    expect(checks({ ...production, stripeMode: 'test' })).toContain(
      'stripe_mode_not_test_in_production',
    );
  });

  it('accepts live, and accepts an unconfigured Stripe', () => {
    expect(checks({ ...production, stripeMode: 'live' })).not.toContain(
      'stripe_mode_not_test_in_production',
    );
    expect(checks(production)).not.toContain('stripe_mode_not_test_in_production');
  });

  it('leaves staging free to use test mode', () => {
    expect(checks({ ...staging, stripeMode: 'test' })).toEqual([]);
  });
});

describe('findings never carry a value', () => {
  it('reports setting names and source-controlled text only', () => {
    const found = evaluateDeploymentConfig({
      ...production,
      apiCorsOrigin: 'https://staging.avenlyo.com',
      release: 'latest',
    });

    expect(found.length).toBeGreaterThan(0);
    for (const finding of found) {
      expect(finding.setting).toMatch(/^[A-Z0-9_]+$/);
      expect(finding.detail).not.toContain('https://');
      expect(JSON.stringify(finding)).not.toContain('avenlyo.com');
    }
  });
});

describe('Supabase project identity is reported honestly', () => {
  it('says unverified when no expectation is declared, rather than implying a check ran', () => {
    const result = supabaseIdentityAssurance({ supabaseUrl: 'https://abcdefghijklmnop.supabase.co' });

    expect(result.status).toBe('unverified');
    expect(result.detail).toContain('cannot prove');
  });

  it('proves a match when the deployment declares which project it intends', () => {
    expect(
      supabaseIdentityAssurance({
        expectedProjectRef: 'abcdefghijklmnop',
        supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
      }).status,
    ).toBe('match');
  });

  it('catches a deployment pointed at a different project than it declared', () => {
    expect(
      supabaseIdentityAssurance({
        expectedProjectRef: 'productionrefhere',
        supabaseUrl: 'https://stagingrefhere.supabase.co',
      }).status,
    ).toBe('mismatch');
  });
});

describe('browser origin agreement uses origin semantics, not hostname matching', () => {
  const production = (overrides: Partial<DeploymentConfigInput> = {}): DeploymentConfigInput => ({
    caddyApiHost: 'api.avenlyo.com',
    caddyWebHost: 'avenlyo.com',
    deploymentEnv: 'production',
    internalApiUrl: INTERNAL_API_URL,
    profileDeploymentEnv: 'production',
    publicApiUrl: 'https://api.avenlyo.com',
    publicWebUrl: 'https://avenlyo.com',
    release: 'c000caf742f7e4ca5d8dc85376931fcbb7a9e6a7',
    ...overrides,
  });

  const checksOf = (input: DeploymentConfigInput) =>
    evaluateDeploymentConfig(input).map((finding) => finding.check);

  it('accepts the ordinary case where every public origin is identical', () => {
    expect(
      checksOf(
        production({
          apiCorsOrigin: 'https://avenlyo.com',
          webChatIframeOrigin: 'https://avenlyo.com',
        }),
      ),
    ).toEqual([]);
  });

  it('treats an explicit :443 as the same origin, because it is', () => {
    // Normalization, not string comparison: https://avenlyo.com:443 and https://avenlyo.com are the
    // same origin to every browser, so reporting a defect here would be a false positive.
    expect(
      checksOf(
        production({
          apiCorsOrigin: 'https://avenlyo.com:443',
          webChatIframeOrigin: 'https://avenlyo.com',
        }),
      ),
    ).toEqual([]);
  });

  it('catches a CORS origin that shares the hostname but is a different origin', () => {
    // The defect a hostname comparison misses entirely. https://avenlyo.com:444 is NOT the same
    // browser origin as https://avenlyo.com, so a CORS allow-list naming it does not allow the app.
    expect(
      checksOf(
        production({
          apiCorsOrigin: 'https://avenlyo.com:444',
          webChatIframeOrigin: 'https://avenlyo.com',
        }),
      ),
    ).toContain('public_web_origin_agreement');
  });

  it('catches an iframe ancestor origin drifting by port alone', () => {
    expect(
      checksOf(
        production({
          apiCorsOrigin: 'https://avenlyo.com',
          webChatIframeOrigin: 'https://avenlyo.com:8443',
        }),
      ),
    ).toContain('public_web_origin_agreement');
  });

  it('still catches a plain hostname drift', () => {
    expect(
      checksOf(
        production({
          apiCorsOrigin: 'https://other.example.com',
          webChatIframeOrigin: 'https://avenlyo.com',
        }),
      ),
    ).toContain('public_web_origin_agreement');
  });
});

describe('public URLs may only name a port Caddy actually publishes', () => {
  const production = (overrides: Partial<DeploymentConfigInput> = {}): DeploymentConfigInput => ({
    caddyApiHost: 'api.avenlyo.com',
    caddyWebHost: 'avenlyo.com',
    deploymentEnv: 'production',
    internalApiUrl: INTERNAL_API_URL,
    profileDeploymentEnv: 'production',
    publicApiUrl: 'https://api.avenlyo.com',
    publicWebUrl: 'https://avenlyo.com',
    release: 'c000caf742f7e4ca5d8dc85376931fcbb7a9e6a7',
    ...overrides,
  });

  const checksOf = (input: DeploymentConfigInput) =>
    evaluateDeploymentConfig(input).map((finding) => finding.check);

  it('rejects a public web URL on a port nothing listens on', () => {
    // deploy/compose.yaml publishes 80, 443 and 443/udp only. A profile naming 8443 builds a
    // browser bundle that calls an address the host does not answer -- and every hostname check
    // still passes, which is why this needs its own rule.
    expect(checksOf(production({ publicWebUrl: 'https://avenlyo.com:8443' }))).toContain(
      'public_port_is_published',
    );
  });

  it('rejects a public API URL on an unpublished port', () => {
    expect(checksOf(production({ publicApiUrl: 'https://api.avenlyo.com:4000' }))).toContain(
      'public_port_is_published',
    );
  });

  it('accepts the default port and an explicit 443', () => {
    for (const url of ['https://avenlyo.com', 'https://avenlyo.com:443']) {
      expect(checksOf(production({ publicWebUrl: url }))).not.toContain(
        'public_port_is_published',
      );
    }
  });

  it('names the setting and never the value', () => {
    const findings = evaluateDeploymentConfig(
      production({ publicWebUrl: 'https://avenlyo.com:8443' }),
    );
    const port = findings.find((finding) => finding.check === 'public_port_is_published');

    expect(port?.setting).toBe('NEXT_PUBLIC_APP_URL');
    expect(JSON.stringify(port)).not.toContain('avenlyo.com');
    expect(JSON.stringify(port)).not.toContain('8443');
  });
});

describe('a deployed profile must actually be present before it can be judged', () => {
  // Every agreement rule compares one declared value against another. Silently skipping a
  // comparison whose operand is missing is not a lenient check -- it is no check, reported as
  // `deployment_configuration: pass`. One case per required setting, because a contract that is
  // only enforced in aggregate is a contract with holes nobody has looked for.
  const requiredFields = [
    ['publicWebUrl', 'NEXT_PUBLIC_APP_URL'],
    ['publicApiUrl', 'NEXT_PUBLIC_AVENLYO_API_URL'],
    ['caddyWebHost', 'AVENLYO_WEB_HOST'],
    ['caddyApiHost', 'AVENLYO_API_HOST'],
    ['internalApiUrl', 'AVENLYO_API_URL'],
    ['profileDeploymentEnv', 'AVENLYO_DEPLOYMENT_ENV'],
  ] as const;

  for (const [field, setting] of requiredFields) {
    for (const environment of ['staging', 'production'] as const) {
      const profile = environment === 'staging' ? staging : production;

      it(`fails a ${environment} deployment whose profile omits ${setting}`, () => {
        const found = errors({ ...profile, [field]: undefined });

        expect(found.map((finding) => finding.check)).toContain('deployment_profile_complete');
        expect(found.map((finding) => finding.setting)).toContain(setting);
      });

      it(`treats an empty ${setting} in ${environment} as omitted, not as satisfied`, () => {
        // Compose renders an unset `${VAR:-}` as "", so this is the shape an omission actually
        // arrives in. An empty string must not read as a supplied value.
        expect(checks({ ...profile, [field]: '' })).toContain('deployment_profile_complete');
      });
    }
  }

  it('leaves development permissive: there is no profile, no Caddy and no compose network', () => {
    expect(errors({ deploymentEnv: 'development' })).toEqual([]);
  });

  it('names the setting and never a value when the profile is incomplete', () => {
    const found = evaluateDeploymentConfig({ ...production, publicWebUrl: undefined });
    const finding = found.find((entry) => entry.check === 'deployment_profile_complete');

    expect(finding?.setting).toBe('NEXT_PUBLIC_APP_URL');
    expect(JSON.stringify(finding)).not.toContain('avenlyo.com');
  });
});

describe('the profile and the runtime must describe the same deployment', () => {
  it('fails when the profile declares a different environment than the runtime resolved', () => {
    // Two files an operator edits separately: /etc/avenlyo/api.env carries the runtime identity,
    // the --env-file carries the profile's. Neither can detect the disagreement alone.
    expect(checks({ ...production, profileDeploymentEnv: 'staging' })).toContain(
      'deployment_identity_agreement',
    );
    expect(checks({ ...staging, profileDeploymentEnv: 'production' })).toContain(
      'deployment_identity_agreement',
    );
  });

  it('accepts agreement, and reports the disagreement as its own check', () => {
    expect(checks(production)).not.toContain('deployment_identity_agreement');
    expect(checks(staging)).not.toContain('deployment_identity_agreement');
  });
});

describe('provider callbacks must address this deployment, not merely use HTTPS', () => {
  const googleUri = `https://api.avenlyo.com${GOOGLE_OAUTH_CALLBACK_PATH}`;

  it('accepts the aligned configuration', () => {
    expect(
      errors({
        ...production,
        googleOauthRedirectUri: googleUri,
        twilioWebhookBaseUrl: 'https://api.avenlyo.com',
      }),
    ).toEqual([]);
  });

  it('accepts a Twilio base URL written with the explicit root path', () => {
    expect(checks({ ...production, twilioWebhookBaseUrl: 'https://api.avenlyo.com/' })).not.toContain(
      'provider_callback_alignment',
    );
  });

  it('rejects a Google redirect on an unrelated HTTPS host', () => {
    // The gap the old rule left: HTTPS, not a staging hostname, and completely wrong. Google only
    // redirects to a URI registered in its console, so this fails after the user has consented.
    expect(
      checks({
        ...production,
        googleOauthRedirectUri: `https://unrelated.example.com${GOOGLE_OAUTH_CALLBACK_PATH}`,
      }),
    ).toContain('provider_callback_alignment');
  });

  it('rejects a Google redirect on a port this topology does not publish', () => {
    const found = checks({
      ...production,
      googleOauthRedirectUri: `https://api.avenlyo.com:8443${GOOGLE_OAUTH_CALLBACK_PATH}`,
    });

    expect(found).toContain('public_port_is_published');
    expect(found).toContain('provider_callback_alignment');
  });

  it('rejects a Google redirect on a route this API does not serve', () => {
    expect(
      checks({ ...production, googleOauthRedirectUri: 'https://api.avenlyo.com/oauth2/callback' }),
    ).toContain('provider_callback_alignment');
  });

  it('rejects a Google redirect carrying its own query or fragment', () => {
    expect(checks({ ...production, googleOauthRedirectUri: `${googleUri}?tenant=1` })).toContain(
      'provider_callback_alignment',
    );
    expect(checks({ ...production, googleOauthRedirectUri: `${googleUri}#x` })).toContain(
      'provider_callback_alignment',
    );
  });

  it('rejects a Twilio base URL on an unrelated HTTPS host', () => {
    expect(checks({ ...production, twilioWebhookBaseUrl: 'https://unrelated.example.com' })).toContain(
      'provider_callback_alignment',
    );
  });

  it('rejects a Twilio base URL carrying a path prefix', () => {
    // twilioWebhookUrl appends absolute routes to the base's pathname, so a prefix produces
    // /hooks/v1/webhooks/twilio/... -- a URL this API does not route, and Twilio would post to it.
    expect(checks({ ...production, twilioWebhookBaseUrl: 'https://api.avenlyo.com/hooks' })).toContain(
      'provider_callback_alignment',
    );
    expect(TWILIO_WEBHOOK_BASE_PATH).toBe('/');
  });

  it('rejects a Twilio base URL on an unpublished port, and one carrying a query', () => {
    expect(checks({ ...production, twilioWebhookBaseUrl: 'https://api.avenlyo.com:8443' })).toContain(
      'public_port_is_published',
    );
    expect(checks({ ...production, twilioWebhookBaseUrl: 'https://api.avenlyo.com/?x=1' })).toContain(
      'provider_callback_alignment',
    );
  });

  it('says nothing about a provider that is not configured', () => {
    // An integration a deployment legitimately does not have must stay a clean absence.
    expect(checks(production)).not.toContain('provider_callback_alignment');
  });

  it('keeps the callback route the one the API actually serves', () => {
    // Source-controlled, from apps/api/src/routes/google-calendar-scheduling.ts. If the route moves
    // and this constant does not, every deployment's redirect URI silently becomes wrong.
    expect(GOOGLE_OAUTH_CALLBACK_PATH).toBe('/v1/scheduling/google-calendar/callback');
  });

  it('names the setting and never the value', () => {
    const found = evaluateDeploymentConfig({
      ...production,
      googleOauthRedirectUri: 'https://unrelated.example.com/oauth2/callback',
    });

    for (const finding of found) {
      expect(finding.setting).toMatch(/^[A-Z0-9_]+$/);
      expect(JSON.stringify(finding)).not.toContain('unrelated.example.com');
    }
  });
});

describe('Supabase identity proves a Supabase project, not a first DNS label', () => {
  it('rejects an arbitrary domain whose first label happens to match the expectation', () => {
    // The discriminating regression. A first-label comparison called this a match, which turned
    // "unverified" into a green tick that any subdomain name could earn.
    const result = supabaseIdentityAssurance({
      expectedProjectRef: 'abc123',
      supabaseUrl: 'https://abc123.example.com',
    });

    expect(result.status).toBe('mismatch');
    expect(result.status).not.toBe('match');
  });

  it('reads a ref only from the canonical hosted project origin', () => {
    expect(supabaseProjectRefOf('https://abcdefghijklmnop.supabase.co')).toBe('abcdefghijklmnop');
    expect(supabaseProjectRefOf('https://abcdefghijklmnop.supabase.co/')).toBe('abcdefghijklmnop');
    expect(SUPABASE_PROJECT_HOST_SUFFIX).toBe('.supabase.co');
  });

  it('refuses to read a ref out of anything else', () => {
    for (const url of [
      'https://abc123.example.com',
      'http://abcdefghijklmnop.supabase.co',
      'https://abcdefghijklmnop.supabase.co:8443',
      'https://abcdefghijklmnop.supabase.co/rest/v1',
      'https://abcdefghijklmnop.supabase.co?x=1',
      'https://abcdefghijklmnop.supabase.co#x',
      'https://evil.abcdefghijklmnop.supabase.co',
      'https://supabase.co',
      'https://abcdefghijklmnop.supabase.co.attacker.example',
      'not a url',
      undefined,
    ]) {
      expect(supabaseProjectRefOf(url)).toBeNull();
    }
  });

  it('still matches a genuine hosted project, and still reports absence as unverified', () => {
    expect(
      supabaseIdentityAssurance({
        expectedProjectRef: 'abcdefghijklmnop',
        supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
      }).status,
    ).toBe('match');
    expect(supabaseIdentityAssurance({ supabaseUrl: 'https://x.supabase.co' }).status).toBe(
      'unverified',
    );
  });
});

describe('the required profile contract is one list', () => {
  it('names exactly the settings the policy enforces', () => {
    expect([...REQUIRED_DEPLOYED_PROFILE_SETTINGS]).toEqual([
      'AVENLYO_API_HOST',
      'AVENLYO_API_URL',
      'AVENLYO_DEPLOYMENT_ENV',
      'AVENLYO_WEB_HOST',
      'NEXT_PUBLIC_APP_URL',
      'NEXT_PUBLIC_AVENLYO_API_URL',
    ]);
  });

  it('reports every one of them when a deployed profile is empty', () => {
    const reported = new Set(
      evaluateDeploymentConfig({ deploymentEnv: 'production' })
        .filter((finding) => finding.check === 'deployment_profile_complete')
        .map((finding) => finding.setting),
    );

    for (const setting of REQUIRED_DEPLOYED_PROFILE_SETTINGS) {
      expect(reported).toContain(setting);
    }
  });
});
