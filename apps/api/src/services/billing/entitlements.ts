import type { BillingPlanCatalogEntry } from './catalog.js';

export type NormalizedBillingState =
  'active' | 'attention' | 'inactive' | 'review_required' | 'unconfigured';

export interface BillingEntitlementSnapshot {
  readonly billingState: NormalizedBillingState;
  readonly featureAvailability: Readonly<
    Record<BillingPlanCatalogEntry['features'][number], boolean>
  >;
  readonly planKey: 'core' | null;
  readonly usageLimits: BillingPlanCatalogEntry['usageLimits'] | null;
}

/**
 * Source-controlled capability snapshot for a later explicit enforcement phase. It is intentionally
 * observational in Phase 12: no live Voice, SMS, Web Chat, reminder, or follow-up runtime reads it.
 */
export function billingEntitlements(input: {
  readonly catalog: BillingPlanCatalogEntry;
  readonly state: NormalizedBillingState;
  readonly supportedPlan: boolean;
}): BillingEntitlementSnapshot {
  const available =
    input.supportedPlan && (input.state === 'active' || input.state === 'attention');
  return {
    billingState: input.state,
    featureAvailability: Object.fromEntries(
      input.catalog.features.map((feature) => [feature, available]),
    ) as BillingEntitlementSnapshot['featureAvailability'],
    planKey: input.supportedPlan ? 'core' : null,
    usageLimits: input.supportedPlan ? input.catalog.usageLimits : null,
  };
}
