import type { BillingPlanCatalogEntry } from './catalog.js';
import type { BillingSubscriptionProjection, StripeSubscriptionRecord } from './types.js';

/** Maps only exact source-controlled Stripe product/price pairs to Avenlyo Core. */
export function projectStripeSubscription(
  subscription: StripeSubscriptionRecord,
  corePlan: BillingPlanCatalogEntry,
): BillingSubscriptionProjection {
  const matchingItems = subscription.items.filter(
    (item) => item.productId === corePlan.productId && item.priceId === corePlan.monthlyPriceId,
  );
  const supported =
    subscription.itemsComplete && subscription.items.length === 1 && matchingItems.length === 1;
  const item = subscription.items[0] ?? null;
  return {
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    endedAt: subscription.endedAt,
    isSupported: supported,
    periodEnd: supported ? (matchingItems[0]?.currentPeriodEnd ?? null) : null,
    periodStart: supported ? (matchingItems[0]?.currentPeriodStart ?? null) : null,
    planKey: supported ? 'core' : null,
    priceId: item?.priceId ?? null,
    productId: item?.productId ?? null,
    status: subscription.status,
    subscription,
    trialEnd: subscription.trialEnd,
  };
}
