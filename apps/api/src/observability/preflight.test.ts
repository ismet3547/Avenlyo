import { INTERNAL_API_URL } from '@avenlyo/shared';
import { describe, expect, it } from 'vitest';

import { describeRuntimeCapabilities } from './capabilities.js';
import {
  evaluatePreflight,
  formatPreflightReport,
  PRODUCTION_REQUIRED_CAPABILITIES,
  type PreflightInput,
} from './preflight.js';

/**
 * The pre-deployment gate.
 *
 * Preflight's value is entirely in what it refuses, so these are written as the deployments that
 * should not be allowed to proceed.
 */

const SHA = 'c000caf742f7e4ca5d8dc85376931fcbb7a9e6a7';

const fullyConfigured = describeRuntimeCapabilities({
  OPENAI_API_KEY: 'placeholder',
  SUPABASE_ANON_KEY: 'placeholder',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder',
  SUPABASE_URL: 'https://project-ref.supabase.co',
});

function base(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    capabilities: fullyConfigured,
    config: {
      apiCorsOrigin: 'https://avenlyo.com',
      deploymentEnv: 'production',
      internalApiUrl: INTERNAL_API_URL,
      publicWebUrl: 'https://avenlyo.com',
      release: SHA,
      webChatIframeOrigin: 'https://avenlyo.com',
    },
    deploymentEnvironment: 'production',
    release: SHA,
    requiredSchemaVersion: 19,
    schemaVersion: 19,
    ...overrides,
  };
}

const failed = (input: PreflightInput) => evaluatePreflight(input).failed;

describe('a healthy production profile passes', () => {
  it('reports ok with everything in order', () => {
    const report = evaluatePreflight(base());

    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.deployment_environment).toBe('production');
  });
});

describe('release identity', () => {
  it('fails a deployed release that is not an exact commit', () => {
    expect(failed(base({ release: 'latest' }))).toContain('release_is_exact_commit');
  });

  it('does not enforce it in development', () => {
    const report = evaluatePreflight(
      base({
        config: { deploymentEnv: 'development', release: 'local' },
        deploymentEnvironment: 'development',
        release: 'local',
      }),
    );

    expect(report.failed).not.toContain('release_is_exact_commit');
  });
});

describe('schema compatibility uses the >= rule, not equality', () => {
  it('passes when the deployed schema is newer, so rollback stays possible', () => {
    expect(evaluatePreflight(base({ schemaVersion: 25 })).ok).toBe(true);
  });

  it('fails when the deployed schema is older than the build needs', () => {
    expect(failed(base({ schemaVersion: 18 }))).toContain('schema_compatible');
  });

  it('skips rather than inventing a pass when no probe was possible', () => {
    const report = evaluatePreflight(base({ schemaVersion: null }));
    const check = report.checks.find((entry) => entry.name === 'schema_compatible');

    expect(check?.outcome).toBe('skip');
    expect(report.ok).toBe(true);
  });
});

describe('capability policy', () => {
  it('fails any partial capability, required or not', () => {
    // Twilio with a SID but no auth token: not a disabled integration, a deployment that breaks
    // later at the webhook boundary.
    const partial = describeRuntimeCapabilities({
      OPENAI_API_KEY: 'placeholder',
      SUPABASE_ANON_KEY: 'placeholder',
      SUPABASE_SERVICE_ROLE_KEY: 'placeholder',
      SUPABASE_URL: 'https://project-ref.supabase.co',
      TWILIO_ACCOUNT_SID: 'placeholder',
    });

    expect(failed(base({ capabilities: partial }))).toContain('capability:twilio_messaging');
  });

  it('accepts a cleanly disabled optional integration in production', () => {
    // Everything except the two required capabilities is unset here.
    const report = evaluatePreflight(base());
    const disabled = report.checks.filter((entry) =>
      entry.detail.includes('disabled, which is a supported deployment choice'),
    );

    expect(disabled.length).toBeGreaterThan(0);
    expect(report.ok).toBe(true);
  });

  it('fails production when a genuinely required capability is missing', () => {
    const noBackend = describeRuntimeCapabilities({ OPENAI_API_KEY: 'placeholder' });

    expect(failed(base({ capabilities: noBackend }))).toContain('capability:supabase_core');
  });

  it('keeps the required list short and justified', () => {
    expect([...PRODUCTION_REQUIRED_CAPABILITIES].sort()).toEqual(['openai_text', 'supabase_core']);
  });

  it('does not impose the production requirement on staging', () => {
    const noBackend = describeRuntimeCapabilities({});
    const report = evaluatePreflight(
      base({
        capabilities: noBackend,
        config: { deploymentEnv: 'staging', internalApiUrl: INTERNAL_API_URL, release: SHA },
        deploymentEnvironment: 'staging',
      }),
    );

    expect(report.failed).not.toContain('capability:supabase_core');
  });
});

describe('configuration defects surface as bounded findings', () => {
  it('reports a staging hostname in a production deployment', () => {
    const report = evaluatePreflight(
      base({
        config: {
          apiCorsOrigin: 'https://staging.avenlyo.com',
          deploymentEnv: 'production',
          internalApiUrl: INTERNAL_API_URL,
          publicWebUrl: 'https://staging.avenlyo.com',
          release: SHA,
        },
      }),
    );

    expect(report.failed.some((name) => name.includes('no_staging_host_in_production'))).toBe(true);
  });
});

describe('Supabase identity is reported, never guessed', () => {
  it('skips when nothing was declared', () => {
    const check = evaluatePreflight(base()).checks.find(
      (entry) => entry.name === 'supabase_project_identity',
    );

    expect(check?.outcome).toBe('skip');
  });

  it('fails when the deployment points at a project it did not declare', () => {
    expect(
      failed(
        base({
          expectedSupabaseProjectRef: 'production-ref',
          supabaseUrl: 'https://staging-ref.supabase.co',
        }),
      ),
    ).toContain('supabase_project_identity');
  });
});

describe('the report is safe to print', () => {
  it('never contains a configured value, only setting names and fixed text', () => {
    const report = evaluatePreflight(
      base({
        config: {
          apiCorsOrigin: 'https://staging.avenlyo.com',
          deploymentEnv: 'production',
          internalApiUrl: 'http://api:4000',
          publicWebUrl: 'https://staging.avenlyo.com',
          release: 'latest',
        },
        expectedSupabaseProjectRef: 'expected-ref',
        release: 'latest',
        supabaseUrl: 'https://actual-ref.supabase.co',
      }),
    );
    const text = formatPreflightReport(report);

    expect(report.ok).toBe(false);
    for (const forbidden of [
      'staging.avenlyo.com',
      'actual-ref',
      'expected-ref',
      'supabase.co',
      'http://api:4000',
      'latest',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('produces bounded output with one line per check', () => {
    const text = formatPreflightReport(evaluatePreflight(base()));

    expect(text.length).toBeLessThan(4_000);
    expect(text).toContain('RESULT: pass');
    expect(text).not.toMatch(/\n\s+at\s+.+:\d+:\d+/);
  });
});
