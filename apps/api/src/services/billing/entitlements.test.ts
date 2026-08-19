import { describe, expect, it } from 'vitest';

import { createBillingCatalog } from './catalog.js';
import { billingEntitlements } from './entitlements.js';

const catalog = createBillingCatalog({
  STRIPE_PRICE_CORE_MONTHLY: 'price_core',
  STRIPE_PRODUCT_CORE: 'prod_core',
})!.core;

describe('billing entitlements', () => {
  it('keeps past-due Core available for later policy decisions without a runtime gate', () => {
    expect(
      billingEntitlements({ catalog, state: 'attention', supportedPlan: true }).featureAvailability
        .sms,
    ).toBe(true);
  });

  it('does not grant capability for an unsupported or ambiguous provider plan', () => {
    expect(
      billingEntitlements({ catalog, state: 'review_required', supportedPlan: false }),
    ).toMatchObject({
      planKey: null,
      usageLimits: null,
    });
  });
});
