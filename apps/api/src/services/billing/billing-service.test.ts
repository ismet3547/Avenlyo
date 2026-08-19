import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { BillingService } from './billing-service.js';
import type {
  BillingStripeProvider,
  StripeCheckoutSessionRecord,
  StripeSubscriptionRecord,
  StripeWebhookEventRecord,
} from './types.js';

const coreSubscription: StripeSubscriptionRecord = {
  cancelAtPeriodEnd: false,
  customerId: 'cus_core',
  endedAt: null,
  id: 'sub_core',
  items: [
    {
      currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
      currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
      priceId: 'price_core',
      productId: 'prod_core',
    },
  ],
  livemode: false,
  status: 'active',
  trialEnd: null,
};

function event(type: string, object: Readonly<Record<string, unknown>>): StripeWebhookEventRecord {
  return {
    createdAt: new Date('2026-08-25T00:00:00.000Z'),
    id: 'evt_test',
    livemode: false,
    object,
    objectId: typeof object.id === 'string' ? object.id : null,
    type,
  };
}

function testService(input: { readonly subscriptions?: readonly StripeSubscriptionRecord[] } = {}) {
  let storedCustomer: string | null = null;
  const checkoutKeys: string[] = [];
  const projectCalls: Readonly<Record<string, unknown>>[] = [];
  const createCheckoutSession = vi.fn(
    (request: Parameters<BillingStripeProvider['createCheckoutSession']>[0]) => {
      checkoutKeys.push(request.idempotencyKey);
      return Promise.resolve<StripeCheckoutSessionRecord>({
        customerId: request.customerId,
        expiresAt: new Date('2026-08-26T00:00:00.000Z'),
        id: 'cs_core',
        livemode: false,
        url: 'https://checkout.stripe.example/cs_core',
      });
    },
  );
  const createCustomer = vi.fn(() => Promise.resolve({ id: 'cus_core', livemode: false }));
  const provider: BillingStripeProvider = {
    createCheckoutSession,
    createCustomer,
    createPortalSession: vi.fn(() => Promise.resolve({ url: 'https://billing.stripe.example/portal' })),
    listSubscriptions: vi.fn(() => Promise.resolve(input.subscriptions ?? [coreSubscription])),
    retrieveEvent: vi.fn(),
    retrieveSubscription: vi.fn(() => Promise.resolve(coreSubscription)),
    verifyWebhook: vi.fn(),
  };
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    switch (name) {
      case 'get_billing_checkout_execution_context':
        return Promise.resolve({
          data: [
            {
              checkout_id: 'checkout_a',
              idempotency_key: 'avenlyo:billing-checkout:org_a:attempt_a',
              livemode: false,
              organization_id: 'org_a',
              organization_name: 'Avenlyo Test',
              plan_key: 'core',
              stripe_customer_id: storedCustomer,
            },
          ],
          error: null,
        });
      case 'record_stripe_billing_customer':
        storedCustomer =
          typeof args.target_stripe_customer_id === 'string' ? args.target_stripe_customer_id : null;
        return Promise.resolve({ data: null, error: null });
      case 'record_stripe_checkout_session':
      case 'mark_missing_stripe_billing_subscriptions_terminal':
      case 'complete_stripe_webhook_event':
      case 'fail_stripe_webhook_event':
        return Promise.resolve({ data: null, error: null });
      case 'get_billing_customer_execution_context':
        return Promise.resolve({
          data: [
            {
              billing_account_id: 'account_a',
              livemode: false,
              organization_id: 'org_a',
              organization_name: 'Avenlyo Test',
              stripe_customer_id: 'cus_core',
            },
          ],
          error: null,
        });
      case 'project_stripe_billing_subscription':
        projectCalls.push(args);
        return Promise.resolve({ data: 'active', error: null });
      default:
        return Promise.resolve({ data: null, error: null });
    }
  });
  const service = new BillingService({
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
    provider,
    supabase: { rpc } as unknown as SupabaseClient<Database>,
    webOrigin: 'https://app.avenlyo.example',
  });
  return { checkoutKeys, createCustomer, projectCalls, service };
}

describe('billing service', () => {
  it('uses durable Stripe idempotency keys for customer and Checkout retries', async () => {
    const test = testService();
    await expect(test.service.createCheckout('checkout_a')).resolves.toEqual({
      action: 'checkout',
      url: 'https://checkout.stripe.example/cs_core',
    });
    await test.service.createCheckout('checkout_a');
    expect(test.createCustomer).toHaveBeenCalledTimes(1);
    expect(test.checkoutKeys).toEqual([
      'avenlyo:billing-checkout:org_a:attempt_a',
      'avenlyo:billing-checkout:org_a:attempt_a',
    ]);
  });

  it('reconciles current provider truth for an out-of-order invoice event', async () => {
    const test = testService();
    await expect(
      test.service.processClaimedEvent(
        event('invoice.paid', { customer: 'cus_core', id: 'in_old' }),
      ),
    ).resolves.toBe('processed');
    expect(test.projectCalls).toHaveLength(1);
    expect(test.projectCalls[0]).toMatchObject({
      target_is_supported: true,
      target_status: 'active',
      target_subscription_id: 'sub_core',
    });
  });

  it('marks unknown provider product/price projection unsupported instead of inferring Core', async () => {
    const unsupported: StripeSubscriptionRecord = {
      ...coreSubscription,
      items: [
        {
          currentPeriodEnd: null,
          currentPeriodStart: null,
          priceId: 'price_other',
          productId: 'prod_other',
        },
      ],
    };
    const test = testService({ subscriptions: [unsupported] });
    await test.service.processClaimedEvent(
      event('invoice.payment_failed', { customer: 'cus_core', id: 'in_2' }),
    );
    expect(test.projectCalls[0]).toMatchObject({
      target_is_supported: false,
      target_plan_key: null,
    });
  });
});
