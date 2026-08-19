import { describe, expect, it } from 'vitest';

import { createBillingCatalog } from './catalog.js';
import { projectStripeSubscription } from './projection.js';
import type { StripeSubscriptionRecord } from './types.js';

const catalog = createBillingCatalog({
  STRIPE_PRICE_CORE_MONTHLY: 'price_core',
  STRIPE_PRODUCT_CORE: 'prod_core',
})!.core;

function subscription(
  items: StripeSubscriptionRecord['items'],
  status = 'active',
): StripeSubscriptionRecord {
  return {
    cancelAtPeriodEnd: false,
    customerId: 'cus_1',
    endedAt: null,
    id: 'sub_1',
    items,
    livemode: false,
    status,
    trialEnd: null,
  };
}

describe('Stripe subscription projection', () => {
  it('accepts exactly one configured Core product/price item', () => {
    const start = new Date('2026-08-01T00:00:00.000Z');
    const end = new Date('2026-09-01T00:00:00.000Z');
    const projected = projectStripeSubscription(
      subscription([
        {
          currentPeriodEnd: end,
          currentPeriodStart: start,
          priceId: 'price_core',
          productId: 'prod_core',
        },
      ]),
      catalog,
    );
    expect(projected.isSupported).toBe(true);
    expect(projected.planKey).toBe('core');
    expect(projected.periodEnd).toEqual(end);
  });

  it('does not infer Core from an unknown price or ambiguous multiple items', () => {
    expect(
      projectStripeSubscription(
        subscription([
          {
            currentPeriodEnd: null,
            currentPeriodStart: null,
            priceId: 'price_other',
            productId: 'prod_core',
          },
        ]),
        catalog,
      ).isSupported,
    ).toBe(false);
    expect(
      projectStripeSubscription(
        subscription([
          {
            currentPeriodEnd: null,
            currentPeriodStart: null,
            priceId: 'price_core',
            productId: 'prod_core',
          },
          {
            currentPeriodEnd: null,
            currentPeriodStart: null,
            priceId: 'price_other',
            productId: 'prod_other',
          },
        ]),
        catalog,
      ).isSupported,
    ).toBe(false);
  });
});
