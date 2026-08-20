import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';

import { classifyError, describeError } from './errors.js';
import { REDACTED_LOG_PATHS } from './logging.js';

/**
 * These tests drive the real production logger through a memory destination, so what they assert is
 * what a deployed process would actually write.
 */

const AUTH_VALUE = 'Bearer super-secret-access-token';
const COOKIE_VALUE = 'sb-access-token=secret-session-cookie';
const SIGNATURE_VALUE = 't=1234,v1=deadbeefsignaturevalue';
const BODY_SECRET = 'customer-message-body-and-phone-+14155550101';

let app: FastifyInstance | null = null;

function captureLogs(): { app: FastifyInstance; lines: string[] } {
  const lines: string[] = [];
  const created = buildApp({ loggerDestination: { write: (chunk) => void lines.push(chunk) } });
  created.post('/v1/test-webhook', () => ({ received: true }));
  return { app: created, lines };
}

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('request logging', () => {
  it('records correlation, route, method, status, and duration for a completed request', async () => {
    const captured = captureLogs();
    app = captured.app;

    const response = await app.inject({ method: 'GET', url: '/health/live?token=leaky-token' });

    const completion = captured.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.operation === 'request');

    expect(response.statusCode).toBe(200);
    expect(completion).toMatchObject({
      component: 'http',
      method: 'GET',
      outcome: 'completed',
      route: '/health/live',
      service: 'avenlyo-api',
      status_code: 200,
    });
    expect(typeof completion?.duration_ms).toBe('number');
    expect(completion?.request_id).toBe(response.headers['x-request-id']);
    // The route is logged, never the raw URL, so query-string tokens cannot reach a log.
    expect(JSON.stringify(completion)).not.toContain('leaky-token');
  });

  it('never writes an authorization header, cookie, signature, or request body', async () => {
    const captured = captureLogs();
    app = captured.app;

    await app.inject({
      headers: {
        authorization: AUTH_VALUE,
        cookie: COOKIE_VALUE,
        'stripe-signature': SIGNATURE_VALUE,
        'x-twilio-signature': SIGNATURE_VALUE,
      },
      method: 'POST',
      payload: { body: BODY_SECRET },
      url: '/v1/test-webhook',
    });

    const output = captured.lines.join('\n');
    expect(output).not.toContain(AUTH_VALUE);
    expect(output).not.toContain('super-secret-access-token');
    expect(output).not.toContain(COOKIE_VALUE);
    expect(output).not.toContain(SIGNATURE_VALUE);
    expect(output).not.toContain(BODY_SECRET);
    expect(output).not.toContain('+14155550101');
  });

  it('stamps every line with the service and release rather than environment values', async () => {
    const captured = captureLogs();
    app = captured.app;

    await app.inject({ method: 'GET', url: '/health/live' });
    const entries = captured.lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.service).toBe('avenlyo-api');
      expect(entry).toHaveProperty('release');
    }
    const output = captured.lines.join('\n').toUpperCase();
    for (const forbidden of ['SUPABASE_', 'STRIPE_SECRET', 'TWILIO_AUTH', 'SERVICE_ROLE']) {
      expect(output).not.toContain(forbidden);
    }
  });

  it('redacts every credential-bearing header the providers use', () => {
    for (const path of [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["stripe-signature"]',
      'req.headers["x-twilio-signature"]',
      'req.headers["webhook-signature"]',
      'req.headers["x-avenlyo-session"]',
      'req.body',
    ]) {
      expect(REDACTED_LOG_PATHS).toContain(path);
    }
  });
});

describe('webhook logging', () => {
  it('identifies the route and outcome without the signed payload or its signature', async () => {
    const captured = captureLogs();
    app = captured.app;

    await app.inject({
      headers: { 'stripe-signature': SIGNATURE_VALUE },
      method: 'POST',
      payload: { data: { object: { customer: 'cus_secret_identifier' } }, id: 'evt_secret_id' },
      url: '/v1/test-webhook',
    });

    const completion = captured.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.operation === 'request');

    expect(completion).toMatchObject({ route: '/v1/test-webhook', status_code: 200 });
    const output = captured.lines.join('\n');
    expect(output).not.toContain('evt_secret_id');
    expect(output).not.toContain('cus_secret_identifier');
    expect(output).not.toContain(SIGNATURE_VALUE);
  });
});

describe('error classification', () => {
  it('maps provider failures onto a bounded set of codes', () => {
    expect(classifyError({ status: 401 })).toBe('provider_unauthorized');
    expect(classifyError({ status: 429 })).toBe('provider_rate_limited');
    expect(classifyError({ status: 409 })).toBe('lease_conflict');
    expect(classifyError({ status: 504 })).toBe('provider_timeout');
    expect(classifyError({ status: 422 })).toBe('provider_rejected');
    expect(classifyError({ code: 'ETIMEDOUT' })).toBe('provider_timeout');
    expect(classifyError({ code: 'ECONNREFUSED' })).toBe('database_unavailable');
    expect(classifyError(new Error('anything at all'))).toBe('unexpected_error');
  });

  it('keeps provider error text out of production diagnostics', () => {
    const error = new Error('POST https://api.stripe.com/v1/charges failed for cus_12345');

    expect(describeError(error, 'production')).toEqual({ error_code: 'unexpected_error' });
    expect(describeError(error, 'development').error_message).toContain('api.stripe.com');
  });
});
