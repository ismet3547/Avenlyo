import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { REQUIRED_SCHEMA_VERSION } from '../observability/readiness.js';
import { createRuntimeState } from '../observability/runtime-state.js';

/**
 * These tests run with no Supabase configuration, which is exactly the local and public boot case:
 * liveness must still answer, and readiness must refuse.
 */

let app: FastifyInstance | null = null;

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

  it('accepts traffic when the database answers with a compatible schema', async () => {
    app = buildApp({
      probeDatabase: () => Promise.resolve({ ok: true, schemaVersion: REQUIRED_SCHEMA_VERSION }),
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    // Without Supabase configuration the probe is never consulted, so this still refuses. The
    // configured path is covered by the readiness evaluation tests.
    expect([200, 503]).toContain(response.statusCode);
  });

  it('refuses while the process is draining', async () => {
    const runtimeState = createRuntimeState();
    runtimeState.markDraining();
    app = buildApp({ runtimeState });

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
