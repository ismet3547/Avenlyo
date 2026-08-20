import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import type {
  CapabilityName,
  CapabilityReport,
  CapabilityStatus,
} from '../observability/capabilities.js';
import { REQUIRED_SCHEMA_VERSION } from '../observability/readiness.js';
import { createRuntimeState } from '../observability/runtime-state.js';

/**
 * Liveness runs with no Supabase configuration, which is exactly the local and public boot case.
 *
 * Readiness is driven through injected capabilities and an injected probe, so every branch of the
 * contract is asserted as a single status code. The previous test accepted either 200 or 503,
 * which asserted nothing at all: it passed whatever the route did.
 */

let app: FastifyInstance | null = null;

const ALL_CAPABILITIES: readonly CapabilityName[] = [
  'ezyvet',
  'google_calendar',
  'openai_text',
  'openai_voice',
  'stripe_billing',
  'supabase_core',
  'twilio_messaging',
];

/** Core configured, every optional provider deliberately disabled. */
function capabilitiesWith(
  overrides: Partial<Record<CapabilityName, CapabilityStatus>> = {},
): CapabilityReport {
  const capabilities = {} as Record<CapabilityName, CapabilityStatus>;
  for (const name of ALL_CAPABILITIES) {
    capabilities[name] = name === 'supabase_core' ? 'configured' : 'disabled';
  }
  Object.assign(capabilities, overrides);
  return {
    capabilities,
    partial: ALL_CAPABILITIES.filter((name) => capabilities[name] === 'partial'),
  };
}

const DATABASE_AT_REQUIRED_SCHEMA = () =>
  Promise.resolve({ ok: true as const, schemaVersion: REQUIRED_SCHEMA_VERSION });

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('liveness', () => {
  it('answers without any dependency configured', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'avenlyo-api', status: 'ok' });
  });

  it('keeps the original endpoint as a liveness alias', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'avenlyo-api', status: 'ok' });
  });

  it('returns a server-generated correlation identifier on every request', async () => {
    app = buildApp();

    const first = await app.inject({ method: 'GET', url: '/health/live' });
    const second = await app.inject({
      headers: { 'x-request-id': 'client-supplied-value' },
      method: 'GET',
      url: '/health/live',
    });

    expect(first.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    // A client-supplied identifier is never adopted as the internal correlation identity.
    expect(second.headers['x-request-id']).not.toBe('client-supplied-value');
    expect(second.headers['x-request-id']).not.toBe(first.headers['x-request-id']);
  });
});

describe('readiness', () => {
  it('refuses when core database configuration is absent', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ service: 'avenlyo-api', status: 'not_ready' });
  });

  it('accepts traffic when the database answers with the required schema', async () => {
    app = buildApp({
      capabilities: capabilitiesWith(),
      probeDatabase: DATABASE_AT_REQUIRED_SCHEMA,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'avenlyo-api', status: 'ready' });
  });

  it('keeps serving against a newer additive schema so a rollback is possible', async () => {
    app = buildApp({
      capabilities: capabilitiesWith(),
      probeDatabase: () =>
        Promise.resolve({ ok: true as const, schemaVersion: REQUIRED_SCHEMA_VERSION + 3 }),
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
  });

  it('refuses when the configured database does not answer', async () => {
    app = buildApp({
      capabilities: capabilitiesWith(),
      probeDatabase: () => Promise.resolve({ ok: false as const }),
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'not_ready' });
  });

  it('refuses when the deployed schema is older than this build requires', async () => {
    app = buildApp({
      capabilities: capabilitiesWith(),
      probeDatabase: () =>
        Promise.resolve({ ok: true as const, schemaVersion: REQUIRED_SCHEMA_VERSION - 1 }),
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
  });

  it('refuses when a probe rejects rather than returning a failure', async () => {
    app = buildApp({
      capabilities: capabilitiesWith(),
      probeDatabase: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
  });

  it('serves with every optional provider deliberately disabled', async () => {
    // A capability nobody configured is not a failure. Only a half-configured one is.
    app = buildApp({
      capabilities: capabilitiesWith(),
      probeDatabase: DATABASE_AT_REQUIRED_SCHEMA,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
  });

  it('refuses when an optional provider is only half configured', async () => {
    // Half a Twilio boundary is not a disabled provider; it is a deployment that fails later.
    app = buildApp({
      capabilities: capabilitiesWith({ twilio_messaging: 'partial' }),
      probeDatabase: DATABASE_AT_REQUIRED_SCHEMA,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
  });

  it('refuses when a configured worker scheduler failed to start', async () => {
    const runtimeState = createRuntimeState();
    runtimeState.markLocalStartupComplete();
    runtimeState.registerSchedulerFailure('message_processing');
    app = buildApp({
      capabilities: capabilitiesWith(),
      probeDatabase: DATABASE_AT_REQUIRED_SCHEMA,
      runtimeState,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
  });

  it('refuses until local startup has finished, while liveness already answers', async () => {
    // The listener comes up before startup completes so liveness never waits on a database. This
    // is the assertion that the earlier listener cannot advertise a replica whose schedulers do
    // not exist yet.
    const runtimeState = createRuntimeState();
    app = buildApp({
      capabilities: capabilitiesWith(),
      probeDatabase: DATABASE_AT_REQUIRED_SCHEMA,
      runtimeState,
    });

    const startingLive = await app.inject({ method: 'GET', url: '/health/live' });
    const startingReady = await app.inject({ method: 'GET', url: '/health/ready' });
    runtimeState.markLocalStartupComplete();
    const startedReady = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(startingLive.statusCode).toBe(200);
    expect(startingReady.statusCode).toBe(503);
    expect(startedReady.statusCode).toBe(200);
  });

  it('refuses while the process is draining', async () => {
    const runtimeState = createRuntimeState();
    runtimeState.markLocalStartupComplete();
    runtimeState.markDraining();
    app = buildApp({
      capabilities: capabilitiesWith(),
      probeDatabase: DATABASE_AT_REQUIRED_SCHEMA,
      runtimeState,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'not_ready' });
  });

  it('never leaks a dependency, configuration state, or queue count to a public caller', async () => {
    const runtimeState = createRuntimeState();
    runtimeState.registerSchedulerFailure('message_processing');
    app = buildApp({ runtimeState });

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/health' }),
      app.inject({ method: 'GET', url: '/health/live' }),
      app.inject({ method: 'GET', url: '/health/ready' }),
    ]);

    for (const response of responses) {
      const body = response.body.toUpperCase();
      for (const forbidden of [
        'SUPABASE',
        'STRIPE',
        'TWILIO',
        'OPENAI',
        'GOOGLE',
        'EZYVET',
        'SECRET',
        'TOKEN',
        'PASSWORD',
        'HTTP://',
        'HTTPS://',
        'QUEUE',
        'SCHEMA_INCOMPATIBLE',
        'DATABASE',
        'WORKER',
      ]) {
        expect(body).not.toContain(forbidden);
      }
      // The safe shape is deliberately tiny.
      expect(Object.keys(response.json<Record<string, unknown>>()).sort()).not.toContain('reasons');
    }
  });
});
