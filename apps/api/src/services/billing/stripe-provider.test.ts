import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { StripeSdkBillingProvider } from './stripe-provider.js';

describe('Stripe SDK webhook boundary', () => {
  it('uses Stripe signature verification before exposing a typed event', () => {
    const secretKey = `sk_test_${'1'.repeat(24)}`;
    const webhookSecret = 'whsec_test_secret';
    const client = new Stripe(secretKey);
    const raw = JSON.stringify({
      created: 1_700_000_000,
      data: {
        object: { customer: 'cus_1', id: 'cs_1', mode: 'subscription', subscription: 'sub_1' },
      },
      id: 'evt_1',
      livemode: false,
      object: 'event',
      type: 'checkout.session.completed',
    });
    const signature = client.webhooks.generateTestHeaderString({
      payload: raw,
      secret: webhookSecret,
    });
    const provider = new StripeSdkBillingProvider({ secretKey, webhookSecret });
    expect(provider.verifyWebhook(raw, signature)).toMatchObject({
      id: 'evt_1',
      livemode: false,
      objectId: 'cs_1',
      type: 'checkout.session.completed',
    });
    expect(() => provider.verifyWebhook(raw, 't=0,v1=bad')).toThrow();
  });
});
