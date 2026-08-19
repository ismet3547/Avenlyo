import Stripe from 'stripe';

import type {
  BillingStripeProvider,
  StripeCheckoutSessionRecord,
  StripeCustomerRecord,
  StripePortalSessionRecord,
  StripeSubscriptionItemRecord,
  StripeSubscriptionRecord,
  StripeWebhookEventRecord,
} from './types.js';

export const MAX_STRIPE_SUBSCRIPTION_SNAPSHOT_SIZE = 500;

/** Collects an SDK auto-paginated iterable without allowing silent snapshot truncation. */
export async function collectBoundedSnapshot<T>(
  source: AsyncIterable<T>,
  maximum = MAX_STRIPE_SUBSCRIPTION_SNAPSHOT_SIZE,
): Promise<readonly T[]> {
  const rows: T[] = [];
  for await (const row of source) {
    if (rows.length >= maximum) {
      throw new Error('Stripe subscription snapshot exceeds the safe reconciliation limit.');
    }
    rows.push(row);
  }
  return rows;
}

function asDate(value: number | null | undefined): Date | null {
  return typeof value === 'number' ? new Date(value * 1000) : null;
}

function customerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof customer === 'string' ? customer : customer.id;
}

function productId(product: string | Stripe.Product | Stripe.DeletedProduct): string {
  return typeof product === 'string' ? product : product.id;
}

function subscriptionItem(item: Stripe.SubscriptionItem): StripeSubscriptionItemRecord {
  return {
    currentPeriodEnd: asDate(item.current_period_end),
    currentPeriodStart: asDate(item.current_period_start),
    priceId: item.price.id,
    productId: productId(item.price.product),
  };
}

function subscriptionRecord(subscription: Stripe.Subscription): StripeSubscriptionRecord {
  return {
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    customerId: customerId(subscription.customer),
    endedAt: asDate(subscription.ended_at),
    id: subscription.id,
    items: subscription.items.data.map(subscriptionItem),
    livemode: subscription.livemode,
    status: subscription.status,
    trialEnd: asDate(subscription.trial_end),
  };
}

function toRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function eventRecord(event: Stripe.Event): StripeWebhookEventRecord {
  const object = toRecord(event.data.object);
  return {
    createdAt: new Date(event.created * 1000),
    id: event.id,
    livemode: event.livemode,
    object,
    objectId: typeof object.id === 'string' ? object.id : null,
    type: event.type,
  };
}

/** Official Stripe SDK adapter. It converts provider objects to a deliberately narrow local shape. */
export class StripeSdkBillingProvider implements BillingStripeProvider {
  private readonly client: Stripe;

  public constructor(input: { readonly secretKey: string; readonly webhookSecret: string }) {
    this.client = new Stripe(input.secretKey);
    this.webhookSecret = input.webhookSecret;
  }

  private readonly webhookSecret: string;

  public async createCustomer(input: {
    readonly idempotencyKey: string;
    readonly organizationId: string;
    readonly organizationName: string;
  }): Promise<StripeCustomerRecord> {
    const customer = await this.client.customers.create(
      {
        metadata: { avenlyo_organization_id: input.organizationId },
        name: input.organizationName,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: customer.id, livemode: customer.livemode };
  }

  public async createCheckoutSession(input: {
    readonly customerId: string;
    readonly idempotencyKey: string;
    readonly priceId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<StripeCheckoutSessionRecord> {
    const session = await this.client.checkout.sessions.create(
      {
        cancel_url: input.cancelUrl,
        customer: input.customerId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        mode: 'subscription',
        success_url: input.successUrl,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (!customer) throw new Error('Stripe Checkout did not return a customer identity.');
    return {
      customerId: customer,
      expiresAt: asDate(session.expires_at),
      id: session.id,
      livemode: session.livemode,
      url: session.url,
    };
  }

  public async createPortalSession(input: {
    readonly customerId: string;
    readonly returnUrl: string;
  }): Promise<StripePortalSessionRecord> {
    const session = await this.client.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  public async retrieveEvent(eventId: string): Promise<StripeWebhookEventRecord> {
    return eventRecord(await this.client.events.retrieve(eventId));
  }

  public async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionRecord> {
    return subscriptionRecord(
      await this.client.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price.product'],
      }),
    );
  }

  public async listSubscriptions(customerId: string): Promise<readonly StripeSubscriptionRecord[]> {
    const subscriptions = await collectBoundedSnapshot(
      this.client.subscriptions.list({
        customer: customerId,
        expand: ['data.items.data.price.product'],
        limit: 100,
        status: 'all',
      }),
    );
    return subscriptions.map(subscriptionRecord);
  }

  public verifyWebhook(rawBody: string, signature: string): StripeWebhookEventRecord {
    return eventRecord(this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret));
  }
}
