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
 * Source-controlled capability snapshot for the API's own reporting surfaces.
 *
 * Phase 17 made entitlement enforced rather than observational, and the authority for that is the
 * database: every execution claim asks `billing_feature_available` inside the same transaction
 * that takes the claim. This function deliberately did not become that authority. A capability
 * decision made in a Node process, from a snapshot read at some earlier moment, would be a second
 * source of truth that a worker could disagree with — and one that never sees the row lock the
 * claim holds. It stays what it always was: a description of what a plan and state mean, used for
 * display and for tests, never consulted to authorize a provider or model call.
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
