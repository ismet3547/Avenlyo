import { describe, expect, it } from 'vitest';

import {
  DeploymentEnvironmentError,
  evaluateDeploymentConfig,
  INTERNAL_API_URL,
  isExactReleaseSha,
  isStagingHostname,
  resolveDeploymentEnvironment,
  supabaseIdentityAssurance,
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
        expectedProjectRef: 'production-ref-here',
        supabaseUrl: 'https://staging-ref-here.supabase.co',
      }).status,
    ).toBe('mismatch');
  });
});
