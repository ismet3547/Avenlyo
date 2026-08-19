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

function subscription(input: Partial<StripeSubscriptionRecord>): StripeSubscriptionRecord {
  return { ...coreSubscription, ...input };
}

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

interface TestServiceOptions {
  readonly checkoutKnown?: boolean;
  readonly customerMapped?: boolean;
  readonly listError?: Error;
  readonly portalError?: Error;
  readonly retrievedEvent?: StripeWebhookEventRecord;
  readonly subscriptions?: readonly StripeSubscriptionRecord[];
}

function testService(options: TestServiceOptions = {}) {
  let storedCustomer: string | null = null;
  const checkoutKeys: string[] = [];
  const snapshotCalls: Readonly<Record<string, unknown>>[] = [];
  const portalAudits: string[] = [];
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
    createPortalSession: vi.fn(() =>
      options.portalError
        ? Promise.reject(options.portalError)
        : Promise.resolve({ url: 'https://billing.stripe.example/portal' }),
    ),
    listSubscriptions: vi.fn(() =>
      options.listError
        ? Promise.reject(options.listError)
        : Promise.resolve(options.subscriptions ?? [coreSubscription]),
    ),
    retrieveEvent: vi.fn(() =>
      Promise.resolve(
        options.retrievedEvent ?? event('invoice.paid', { customer: 'cus_core', id: 'in_retrieved' }),
      ),
    ),
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
      case 'complete_stripe_webhook_event':
      case 'fail_stripe_webhook_event':
        return Promise.resolve({ data: null, error: null });
      case 'record_billing_portal_opened':
        if (typeof args.target_account_id === 'string') portalAudits.push(args.target_account_id);
        return Promise.resolve({ data: null, error: null });
      case 'get_billing_customer_execution_context':
      case 'get_billing_account_execution_context':
        return Promise.resolve({
          data:
            options.customerMapped === false
              ? []
              : [
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
      case 'get_billing_checkout_event_context':
        return Promise.resolve({
          data:
            options.checkoutKnown === false
              ? []
              : [{ organization_id: 'org_a', stripe_customer_id: 'cus_core' }],
          error: null,
        });
      case 'complete_billing_checkout_from_event':
        return Promise.resolve({
          data: [
            {
              organization_id: 'org_a',
              stripe_customer_id: 'cus_core',
              stripe_subscription_id: 'sub_core',
            },
          ],
          error: null,
        });
      case 'apply_stripe_billing_snapshot':
        snapshotCalls.push(args);
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
  return { checkoutKeys, createCustomer, portalAudits, service, snapshotCalls };
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

  it('applies an out-of-order provider event as one complete atomic snapshot', async () => {
    const test = testService();
    await expect(
      test.service.processClaimedEvent(event('invoice.paid', { customer: 'cus_core', id: 'in_old' })),
    ).resolves.toBe('processed');
    expect(test.snapshotCalls).toEqual([
      expect.objectContaining({
        target_snapshot_complete: true,
        target_subscriptions: [
          expect.objectContaining({ stripe_status: 'active', subscription_id: 'sub_core' }),
        ],
      }),
    ]);
  });

  it('keeps terminal unsupported history in the complete snapshot without inferring Core', async () => {
    const test = testService({
      subscriptions: [
        coreSubscription,
        subscription({
          id: 'sub_old',
          items: [
            {
              currentPeriodEnd: null,
              currentPeriodStart: null,
              priceId: 'price_other',
              productId: 'prod_other',
            },
          ],
          status: 'canceled',
        }),
      ],
    });
    await test.service.processClaimedEvent(
      event('invoice.payment_failed', { customer: 'cus_core', id: 'in_2' }),
    );
    expect(test.snapshotCalls[0]?.target_subscriptions).toEqual([
      expect.objectContaining({ is_supported: true, stripe_status: 'active' }),
      expect.objectContaining({ is_supported: false, plan_key: null, stripe_status: 'canceled' }),
    ]);
  });

  it('keeps a current unpaid subscription in the one provider snapshot for review', async () => {
    const test = testService({
      subscriptions: [coreSubscription, subscription({ id: 'sub_unpaid', status: 'unpaid' })],
    });
    await test.service.processClaimedEvent(
      event('customer.subscription.updated', { customer: 'cus_core', id: 'sub_unpaid' }),
    );
    expect(test.snapshotCalls[0]).toMatchObject({ target_snapshot_complete: true });
    expect(test.snapshotCalls[0]?.target_subscriptions).toContainEqual(
      expect.objectContaining({ stripe_status: 'unpaid', subscription_id: 'sub_unpaid' }),
    );
  });

  it('uses an exact deleted-subscription fallback without marking siblings missing', async () => {
    const test = testService({ listError: new Error('temporary Stripe outage') });
    await test.service.processClaimedEvent(
      event('customer.subscription.deleted', {
        cancel_at_period_end: false,
        customer: 'cus_core',
        id: 'sub_deleted',
        items: {
          data: [
            {
              current_period_end: 1_788_307_200,
              current_period_start: 1_785_628_800,
              price: { id: 'price_core', product: 'prod_core' },
            },
          ],
        },
      }),
    );
    expect(test.snapshotCalls).toEqual([
      expect.objectContaining({
        target_snapshot_complete: false,
        target_subscriptions: [
          expect.objectContaining({ stripe_status: 'canceled', subscription_id: 'sub_deleted' }),
        ],
      }),
    ]);
  });

  it('ignores a verified event for an unmapped Stripe customer', async () => {
    const test = testService({ customerMapped: false });
    await expect(
      test.service.processClaimedEvent(event('invoice.paid', { customer: 'cus_other', id: 'in_other' })),
    ).resolves.toBe('ignored');
    expect(test.snapshotCalls).toEqual([]);
  });

  it('ignores a verified Checkout event without a trusted local Checkout mapping', async () => {
    const test = testService({ checkoutKnown: false });
    await expect(
      test.service.processClaimedEvent(
        event('checkout.session.completed', {
          customer: 'cus_core',
          id: 'cs_unknown',
          mode: 'subscription',
          subscription: 'sub_core',
        }),
      ),
    ).resolves.toBe('ignored');
    expect(test.snapshotCalls).toEqual([]);
  });

  it('rejects a retrieved event whose durable claim mode does not match', async () => {
    const test = testService({
      retrievedEvent: {
        ...event('invoice.paid', { customer: 'cus_core', id: 'in_mode' }),
        livemode: true,
      },
    });
    await expect(
      test.service.retrieveClaimedEvent({
        attemptCount: 1,
        eventType: 'invoice.paid',
        livemode: false,
        stripeEventId: 'evt_test',
        stripeObjectId: 'in_mode',
      }),
    ).rejects.toThrow('identity or mode mismatch');
  });

  it('records portal audit only after Stripe created the trusted portal session', async () => {
    const test = testService();
    await expect(test.service.createPortal('account_a')).resolves.toBe(
      'https://billing.stripe.example/portal',
    );
    expect(test.portalAudits).toEqual(['account_a']);
  });

  it('does not record a portal audit when Stripe cannot create a portal session', async () => {
    const test = testService({ portalError: new Error('Stripe unavailable') });
    await expect(test.service.createPortal('account_a')).rejects.toThrow('Stripe unavailable');
    expect(test.portalAudits).toEqual([]);
  });
});
