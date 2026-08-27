import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type * as EnvModule from '../env.js';

/**
 * Provider webhook signature regression.
 *
 * Phase 19 exempts these routes from the ordinary per-client rate limit, because a provider retry
 * wave looks exactly like the flood such a limit is built to reject and dropping it would be data
 * loss with amplification behind it. That exemption is only defensible if the signature check is
 * genuinely the gate, so these assertions pin it: an unsigned or wrongly-signed request must be
 * refused before it reaches any Supabase RPC, whatever shape its body is.
 *
 * The Twilio routes had normalization unit tests but no HTTP-level signature test at all. That gap
 * is closed here.
 */

const AUTH_TOKEN = 'twilio-auth-token-value-32-characters';
const BASE_URL = 'https://api-staging.avenlyo.example';

const rpc = vi.fn(() => Promise.resolve({ data: [{ accepted: true }], error: null }));

vi.mock('../env.js', async () => {
  const actual = await vi.importActual<typeof EnvModule>('../env.js');
  return {
    ...actual,
    env: {
      ...actual.env,
      TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_MESSAGING_WEBHOOK_BASE_URL: BASE_URL,
    },
    isTwilioMessagingConfigured: true,
  };
});

vi.mock('../lib/supabase.js', () => ({
  createServiceSupabaseClient: () => ({ rpc }),
}));

const { twilioMessagingWebhookRoutes } = await import('./twilio-messaging-webhook.js');
const { validateTwilioSignature } = await import('../services/messaging/twilio.js');

const INBOUND = '/v1/webhooks/twilio/messaging/inbound';
const STATUS = '/v1/webhooks/twilio/messaging/status';

function signedFields() {
  return {
    Body: 'Are you open today?',
    From: '+15550000000',
    MessageSid: `SM${'a'.repeat(32)}`,
    To: '+15550000001',
  };
}

function encode(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe('Twilio webhooks refuse anything they cannot verify', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    rpc.mockClear();
    app = Fastify();
    await app.register(import('@fastify/formbody'));
    await app.register(twilioMessagingWebhookRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  for (const route of [INBOUND, STATUS]) {
    it(`rejects a missing signature on ${route}`, async () => {
      const response = await app.inject({
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
        payload: encode(signedFields()),
        url: route,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'INVALID_TWILIO_SIGNATURE' });
      // The gate is before any durable work: nothing reached the database.
      expect(rpc).not.toHaveBeenCalled();
    });

    it(`rejects a wrong signature on ${route}`, async () => {
      const response = await app.inject({
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': 'ZGVmaW5pdGVseS1ub3QtdGhlLXJpZ2h0LXNpZ25hdHVyZQ==',
        },
        method: 'POST',
        payload: encode(signedFields()),
        url: route,
      });

      expect(response.statusCode).toBe(403);
      expect(rpc).not.toHaveBeenCalled();
    });

    it(`rejects a signature computed over different fields on ${route}`, async () => {
      // A replayed signature from one payload must not authorise another. This is the case a
      // constant-time comparison alone would not catch -- the signature is well formed, just not
      // for this body.
      const other = { ...signedFields(), Body: 'a completely different message' };
      const response = await app.inject({
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': Buffer.from('signature-for-another-body').toString('base64'),
        },
        method: 'POST',
        payload: encode(other),
        url: route,
      });

      expect(response.statusCode).toBe(403);
      expect(rpc).not.toHaveBeenCalled();
    });

    it(`rejects a malformed body on ${route} without bypassing the signature gate`, async () => {
      const response = await app.inject({
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': 'not-base64-at-all',
        },
        method: 'POST',
        payload: 'this=is&not[]=a+valid+twilio+form&NumMedia=notanumber',
        url: route,
      });

      // Whatever the shape, an unverifiable request never becomes database work.
      expect([400, 403]).toContain(response.statusCode);
      expect(rpc).not.toHaveBeenCalled();
    });
  }

  it('never echoes the presented signature back to the caller', async () => {
    const signature = 'a-signature-value-that-must-not-be-reflected';
    const response = await app.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      method: 'POST',
      payload: encode(signedFields()),
      url: INBOUND,
    });

    expect(response.body).not.toContain(signature);
    expect(JSON.stringify(response.headers)).not.toContain(signature);
  });

  it('does not write the signature or the auth token into a log line', async () => {
    const written: string[] = [];
    const logged = Fastify({
      logger: { level: 'trace', stream: { write: (chunk: string) => written.push(chunk) } },
    });
    await logged.register(import('@fastify/formbody'));
    await logged.register(twilioMessagingWebhookRoutes);
    await logged.ready();

    await logged.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'signature-should-never-be-logged',
      },
      method: 'POST',
      payload: encode(signedFields()),
      url: INBOUND,
    });

    const output = written.join('\n');
    expect(output).not.toContain('signature-should-never-be-logged');
    expect(output).not.toContain(AUTH_TOKEN);
    await logged.close();
  });
});

describe('the signature validator itself', () => {
  it('refuses when no signature is presented', () => {
    expect(
      validateTwilioSignature({
        configuration: { authToken: AUTH_TOKEN, webhookBaseUrl: BASE_URL },
        form: signedFields(),
        route: INBOUND,
        signature: undefined,
      }),
    ).toBe(false);
  });

  it('refuses a signature that does not match the presented fields', () => {
    expect(
      validateTwilioSignature({
        configuration: { authToken: AUTH_TOKEN, webhookBaseUrl: BASE_URL },
        form: signedFields(),
        route: INBOUND,
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }),
    ).toBe(false);
  });
});
