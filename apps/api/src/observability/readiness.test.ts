import { describe, expect, it } from 'vitest';

import { describeRuntimeCapabilities, type CapabilityEnvironment } from './capabilities.js';
import { evaluateReadiness, REQUIRED_SCHEMA_VERSION } from './readiness.js';

const CORE: CapabilityEnvironment = {
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  SUPABASE_URL: 'https://project.supabase.co',
};

function readinessFor(overrides: Partial<Parameters<typeof evaluateReadiness>[0]> = {}) {
  return evaluateReadiness({
    capabilities: describeRuntimeCapabilities(CORE),
    draining: false,
    probe: { ok: true, schemaVersion: REQUIRED_SCHEMA_VERSION },
    schedulerFailures: [],
    ...overrides,
  });
}

describe('runtime capability diagnostics', () => {
  it('reports a provider nobody configured as disabled rather than broken', () => {
    const report = describeRuntimeCapabilities(CORE);

    expect(report.capabilities.stripe_billing).toBe('disabled');
    expect(report.capabilities.twilio_messaging).toBe('disabled');
    expect(report.capabilities.supabase_core).toBe('configured');
    expect(report.partial).toEqual([]);
  });

  it('reports a half-configured provider as partial instead of silently disabling it', () => {
    const report = describeRuntimeCapabilities({ ...CORE, TWILIO_ACCOUNT_SID: 'AC123' });

    expect(report.capabilities.twilio_messaging).toBe('partial');
    expect(report.partial).toContain('twilio_messaging');
  });

  it('treats a text-only OpenAI deployment as configured text and disabled voice', () => {
    const report = describeRuntimeCapabilities({ ...CORE, OPENAI_API_KEY: 'sk-test' });

    expect(report.capabilities.openai_text).toBe('configured');
    expect(report.capabilities.openai_voice).toBe('disabled');
    expect(report.partial).toEqual([]);
  });

  it('flags a voice webhook secret with no API key as partial', () => {
    const report = describeRuntimeCapabilities({ ...CORE, OPENAI_WEBHOOK_SECRET: 'whsec_x' });

    expect(report.capabilities.openai_voice).toBe('partial');
  });

  it('never reports a setting name or value alongside a partial capability', () => {
    const report = describeRuntimeCapabilities({ ...CORE, STRIPE_SECRET_KEY: 'sk_test_secret' });

    expect(report.partial).toEqual(['stripe_billing']);
    expect(JSON.stringify(report)).not.toContain('sk_test_secret');
    expect(JSON.stringify(report)).not.toContain('STRIPE_SECRET_KEY');
  });
});

describe('readiness evaluation', () => {
  it('is ready when configuration, database, and schema all check out', () => {
    expect(readinessFor()).toMatchObject({ ready: true, reasons: [] });
  });

  it('is not ready without core database configuration', () => {
    const result = readinessFor({
      capabilities: describeRuntimeCapabilities({}),
      probe: null,
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain('database_not_configured');
    expect(result.reasons).not.toContain('database_unavailable');
  });

  it('is not ready when the database does not answer', () => {
    const result = readinessFor({ probe: { ok: false } });

    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(['database_unavailable']);
  });

  it('is not ready when the deployed schema is older than this build requires', () => {
    const result = readinessFor({
      probe: { ok: true, schemaVersion: REQUIRED_SCHEMA_VERSION - 1 },
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(['schema_incompatible']);
  });

  it('stays ready against a newer additive schema so a rollback can still serve', () => {
    const result = readinessFor({
      probe: { ok: true, schemaVersion: REQUIRED_SCHEMA_VERSION + 5 },
    });

    expect(result.ready).toBe(true);
  });

  describe('the Phase 23 schema contract', () => {
    it('requires 20 because current customer mutation authority depends on Phase 23 RPCs', () => {
      expect(REQUIRED_SCHEMA_VERSION).toBe(20);
    });

    it('refuses a 19 database that lacks durable confirmation presentation authority', () => {
      const result = readinessFor({ probe: { ok: true, schemaVersion: 19 } });

      expect(result.ready).toBe(false);
      expect(result.reasons).toEqual(['schema_incompatible']);
      expect(result.schemaVersion).toBe(19);
    });

    it('accepts a 20 database', () => {
      expect(readinessFor({ probe: { ok: true, schemaVersion: 20 } })).toMatchObject({
        ready: true,
        schemaVersion: 20,
      });
    });
  });

  it('is not ready while draining', () => {
    expect(readinessFor({ draining: true })).toMatchObject({
      ready: false,
      reasons: ['shutting_down'],
    });
  });

  it('is not ready when a configured worker scheduler failed to start', () => {
    const result = readinessFor({ schedulerFailures: ['message_processing'] });

    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(['worker_scheduler_failed']);
  });

  it('is not ready when any provider is only half configured', () => {
    const result = readinessFor({
      capabilities: describeRuntimeCapabilities({ ...CORE, STRIPE_MODE: 'live' }),
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain('configuration_partial');
  });

  it('stays ready when an optional provider is fully disabled', () => {
    const result = readinessFor({
      capabilities: describeRuntimeCapabilities(CORE),
    });

    expect(result.ready).toBe(true);
  });
});
