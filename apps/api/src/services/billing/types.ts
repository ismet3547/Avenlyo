import type { BillingPlanKey } from './catalog.js';

export interface StripeCustomerRecord {
  readonly id: string;
  readonly livemode: boolean;
}

export interface StripeCheckoutSessionRecord {
  readonly customerId: string;
  readonly expiresAt: Date | null;
  readonly id: string;
  readonly livemode: boolean;
  readonly url: string | null;
}

export interface StripePortalSessionRecord {
  readonly url: string;
}

export interface StripeSubscriptionItemRecord {
  readonly currentPeriodEnd: Date | null;
  readonly currentPeriodStart: Date | null;
  readonly priceId: string;
  readonly productId: string;
}

export interface StripeSubscriptionRecord {
  readonly cancelAtPeriodEnd: boolean;
  readonly customerId: string;
  readonly endedAt: Date | null;
  readonly id: string;
  readonly items: readonly StripeSubscriptionItemRecord[];
  /** False when Stripe's embedded item page may omit additional subscription items. */
  readonly itemsComplete: boolean;
  readonly livemode: boolean;
  readonly status: string;
  readonly trialEnd: Date | null;
}

export interface StripeWebhookEventRecord {
  readonly createdAt: Date;
  readonly id: string;
  readonly livemode: boolean;
  readonly object: Readonly<Record<string, unknown>>;
  readonly objectId: string | null;
  readonly type: string;
}

/** Minimal durable webhook claim; the signed provider object is retrieved only by the worker. */
export interface StripeWebhookClaim {
  readonly attemptCount: number;
  readonly eventType: string;
  readonly livemode: boolean;
  readonly stripeEventId: string;
  readonly stripeObjectId: string | null;
}

/** Validated, bounded provider data sent to the one atomic database snapshot RPC. */
export interface BillingSubscriptionSnapshot {
  readonly cancelAtPeriodEnd: boolean;
  readonly endedAt: string | null;
  readonly isSupported: boolean;
  readonly periodEnd: string | null;
  readonly periodStart: string | null;
  readonly planKey: BillingPlanKey | null;
  readonly priceId: string | null;
  readonly productId: string | null;
  readonly status: string;
  readonly subscriptionId: string;
  readonly trialEnd: string | null;
}

export interface BillingStripeProvider {
  createCheckoutSession(input: {
    readonly customerId: string;
    readonly idempotencyKey: string;
    readonly priceId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<StripeCheckoutSessionRecord>;
  createCustomer(input: {
    readonly idempotencyKey: string;
    readonly organizationId: string;
    readonly organizationName: string;
  }): Promise<StripeCustomerRecord>;
  createPortalSession(input: {
    readonly customerId: string;
    readonly returnUrl: string;
  }): Promise<StripePortalSessionRecord>;
  listSubscriptions(customerId: string): Promise<readonly StripeSubscriptionRecord[]>;
  retrieveEvent(eventId: string): Promise<StripeWebhookEventRecord>;
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionRecord>;
  verifyWebhook(rawBody: string, signature: string): StripeWebhookEventRecord;
}

export interface BillingSubscriptionProjection {
  readonly cancelAtPeriodEnd: boolean;
  readonly endedAt: Date | null;
  readonly isSupported: boolean;
  readonly planKey: BillingPlanKey | null;
  readonly priceId: string | null;
  readonly productId: string | null;
  readonly status: string;
  readonly subscription: StripeSubscriptionRecord;
  readonly periodEnd: Date | null;
  readonly periodStart: Date | null;
  readonly trialEnd: Date | null;
}
