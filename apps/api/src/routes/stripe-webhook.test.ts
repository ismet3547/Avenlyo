import Fastify from 'fastify';
import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { BillingService } from '../services/billing/billing-service.js';
import type { BillingStripeProvider } from '../services/billing/types.js';

import { stripeWebhookRoutes } from './stripe-webhook.js';

function provider(livemode = false): BillingStripeProvider {
  return {
    createCheckoutSession: vi.fn(),
    createCustomer: vi.fn(),
    createPortalSession: vi.fn(),
    listSubscriptions: vi.fn(),
    retrieveEvent: vi.fn(),
    retrieveSubscription: vi.fn(),
    verifyWebhook: vi.fn(() => ({
      createdAt: new Date('2026-08-25T00:00:00.000Z'),
      id: 'evt_billing_test',
      livemode,
      object: { id: 'in_test' },
      objectId: 'in_test',
      type: 'invoice.paid',
    })),
  };
}

function service(input: { readonly livemode?: boolean; readonly persistenceFails?: boolean } = {}) {
  const rpc = vi.fn((name: string) => {
    if (name === 'record_stripe_webhook_event') {
      return Promise.resolve(
        input.persistenceFails
          ? { data: null, error: { message: 'database unavailable' } }
          : { data: [{ accepted: true }], error: null },
      );
    }
    return Promise.resolve({ data: null, error: null });
  });
  return new BillingService({
    catalog: {
      features: [
        'voice',
        'sms',
        'web_chat',
        'appointments',
        'lead_capture',
        'reminders',
        'lead_followups',
      ],
      key: 'core',
      monthlyPriceId: 'price_core',
      name: 'Avenlyo Core',
      productId: 'prod_core',
      usageLimits: {
        ai_text_turn: null,
        appointment_booked: null,
        outbound_sms: null,
        voice_seconds: null,
      },
    },
    expectedLivemode: false,
    provider: provider(input.livemode),
    supabase: { rpc } as unknown as SupabaseClient<Database>,
    webOrigin: 'https://app.avenlyo.example',
  });
}

describe('Stripe webhook route', () => {
  it('requires a signature before calling the verifier', async () => {
    const billing = service();
    const app = Fastify();
    await app.register(stripeWebhookRoutes, { service: billing });
    const response = await app.inject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      payload: '{}',
      url: '/webhooks/stripe',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('persists a verified, expected-mode event before acknowledging it', async () => {
    const billing = service();
    const app = Fastify();
    await app.register(stripeWebhookRoutes, { service: billing });
    const response = await app.inject({
      headers: { 'content-type': 'application/json', 'stripe-signature': 'verified' },
      method: 'POST',
      payload: '{}',
      url: '/webhooks/stripe',
    });
    expect(response.statusCode).toBe(204);
    await app.close();
  });

  it('rejects a verified event in the wrong Stripe mode', async () => {
    const billing = service({ livemode: true });
    const app = Fastify();
    await app.register(stripeWebhookRoutes, { service: billing });
    const response = await app.inject({
      headers: { 'content-type': 'application/json', 'stripe-signature': 'verified' },
      method: 'POST',
      payload: '{}',
      url: '/webhooks/stripe',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'STRIPE_MODE_MISMATCH' });
    await app.close();
  });

  it('returns non-2xx when durable event persistence fails so Stripe can retry', async () => {
    const billing = service({ persistenceFails: true });
    const app = Fastify();
    await app.register(stripeWebhookRoutes, { service: billing });
    const response = await app.inject({
      headers: { 'content-type': 'application/json', 'stripe-signature': 'verified' },
      method: 'POST',
      payload: '{}',
      url: '/webhooks/stripe',
    });
    expect(response.statusCode).toBe(500);
    await app.close();
  });
});
