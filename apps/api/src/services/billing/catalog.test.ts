import { describe, expect, it } from 'vitest';

import { createBillingCatalog, isBillingPlanKey } from './catalog.js';

describe('billing catalog', () => {
  it('does not create an authorization catalog from partial provider configuration', () => {
    expect(createBillingCatalog({ STRIPE_PRODUCT_CORE: 'prod_core' })).toBeNull();
    expect(createBillingCatalog({ STRIPE_PRICE_CORE_MONTHLY: 'price_core' })).toBeNull();
  });

  it('keeps Core source-controlled with intentionally unlimited Phase 12 limits', () => {
    const catalog = createBillingCatalog({
      STRIPE_PRICE_CORE_MONTHLY: 'price_core_monthly',
      STRIPE_PRODUCT_CORE: 'prod_core',
    });
    expect(catalog?.core.features).toContain('lead_followups');
    expect(catalog?.core.usageLimits).toEqual({
      ai_text_turn: null,
      appointment_booked: null,
      outbound_sms: null,
      voice_seconds: null,
    });
    expect(isBillingPlanKey('core')).toBe(true);
    expect(isBillingPlanKey('arbitrary')).toBe(false);
  });
});
