import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { BillingPlanCatalogEntry } from './catalog.js';
import { projectStripeSubscription } from './projection.js';
import type {
  BillingStripeProvider,
  StripeSubscriptionItemRecord,
  StripeSubscriptionRecord,
  StripeWebhookEventRecord,
} from './types.js';

interface BillingRpc {
  get_billing_checkout_execution_context: {
    Args: { target_checkout_id: string };
    Returns: readonly {
      checkout_id: string;
      idempotency_key: string;
      livemode: boolean | null;
      organization_id: string;
      organization_name: string;
      plan_key: 'core';
      stripe_customer_id: string | null;
    }[];
  };
  record_stripe_billing_customer: {
    Args: {
      target_checkout_id: string;
      target_livemode: boolean;
      target_stripe_customer_id: string;
    };
    Returns: null;
  };
  record_stripe_checkout_session: {
    Args: {
      target_checkout_id: string;
      target_customer_id: string;
      target_expires_at: string | null;
      target_livemode: boolean;
      target_session_id: string;
    };
    Returns: null;
  };
  get_billing_account_execution_context: {
    Args: { target_account_id: string };
    Returns: readonly {
      billing_account_id: string;
      livemode: boolean;
      organization_id: string;
      organization_name: string;
      stripe_customer_id: string;
    }[];
  };
  get_billing_customer_execution_context: {
    Args: { target_customer_id: string; target_livemode: boolean };
    Returns: readonly {
      billing_account_id: string;
      livemode: boolean;
      organization_id: string;
      organization_name: string;
      stripe_customer_id: string;
    }[];
  };
  complete_billing_checkout_from_event: {
    Args: {
      target_customer_id: string;
      target_livemode: boolean;
      target_session_id: string;
      target_subscription_id: string;
    };
    Returns: readonly {
      organization_id: string;
      stripe_customer_id: string;
      stripe_subscription_id: string;
    }[];
  };
  project_stripe_billing_subscription: {
    Args: {
      target_cancel_at_period_end: boolean;
      target_customer_id: string;
      target_ended_at: string | null;
      target_is_supported: boolean;
      target_livemode: boolean;
      target_organization_id: string;
      target_period_end: string | null;
      target_period_start: string | null;
      target_plan_key: 'core' | null;
      target_price_id: string | null;
      target_product_id: string | null;
      target_status: string;
      target_subscription_id: string;
      target_trial_end: string | null;
    };
    Returns: string;
  };
  mark_missing_stripe_billing_subscriptions_terminal: {
    Args: {
      target_customer_id: string;
      target_livemode: boolean;
      target_organization_id: string;
      target_subscription_ids: readonly string[];
    };
    Returns: string;
  };
  record_stripe_webhook_event: {
    Args: {
      target_created_at: string;
      target_event_id: string;
      target_event_type: string;
      target_livemode: boolean;
      target_object_id: string | null;
    };
    Returns: readonly { accepted: boolean }[];
  };
  claim_stripe_webhook_events: {
    Args: { target_limit: number; target_worker_id: string };
    Returns: readonly {
      attempt_count: number;
      event_type: string;
      livemode: boolean;
      stripe_event_id: string;
      stripe_object_id: string | null;
    }[];
  };
  complete_stripe_webhook_event: {
    Args: { target_event_id: string; target_status?: 'ignored' | 'processed' };
    Returns: null;
  };
  fail_stripe_webhook_event: {
    Args: { target_error_code: string; target_event_id: string };
    Returns: null;
  };
}

type BillingRpcClient = {
  rpc<Name extends keyof BillingRpc>(
    name: Name,
    args: BillingRpc[Name]['Args'],
  ): Promise<{ data: BillingRpc[Name]['Returns'] | null; error: { message: string } | null }>;
};

function asIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function textField(object: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof object[key] === 'string' && object[key].trim() ? object[key] : null;
}

function booleanField(object: Readonly<Record<string, unknown>>, key: string): boolean | null {
  return typeof object[key] === 'boolean' ? object[key] : null;
}

function nestedIdentifier(object: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = object[key];
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identifier = (value as Record<string, unknown>).id;
  return typeof identifier === 'string' ? identifier : null;
}

function webhookCustomerId(event: StripeWebhookEventRecord): string | null {
  return nestedIdentifier(event.object, 'customer');
}

function webhookSubscriptionId(event: StripeWebhookEventRecord): string | null {
  return (
    nestedIdentifier(event.object, 'subscription') ??
    (event.type.startsWith('customer.subscription.') ? event.objectId : null)
  );
}

function fallbackDeletedSubscription(
  event: StripeWebhookEventRecord,
): StripeSubscriptionRecord | null {
  const customerId = webhookCustomerId(event);
  const id = event.objectId;
  if (!customerId || !id || event.type !== 'customer.subscription.deleted') return null;
  const itemsRecord = event.object.items;
  const itemRows =
    itemsRecord && typeof itemsRecord === 'object' && !Array.isArray(itemsRecord)
      ? (itemsRecord as Record<string, unknown>).data
      : null;
  if (!Array.isArray(itemRows)) return null;
  const items: StripeSubscriptionItemRecord[] = itemRows.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const price = row.price;
    if (!price || typeof price !== 'object' || Array.isArray(price)) return [];
    const priceRow = price as Record<string, unknown>;
    const priceId = textField(priceRow, 'id');
    const productId = nestedIdentifier(priceRow, 'product');
    if (!priceId || !productId) return [];
    const toDate = (value: unknown): Date | null =>
      typeof value === 'number' ? new Date(value * 1000) : null;
    return [
      {
        currentPeriodEnd: toDate(row.current_period_end),
        currentPeriodStart: toDate(row.current_period_start),
        priceId,
        productId,
      },
    ];
  });
  return {
    cancelAtPeriodEnd: booleanField(event.object, 'cancel_at_period_end') ?? false,
    customerId,
    endedAt: event.createdAt,
    id,
    items,
    livemode: event.livemode,
    status: textField(event.object, 'status') ?? 'canceled',
    trialEnd: null,
  };
}

/**
 * Owns server-side Stripe mutation/reconciliation. It never accepts Stripe IDs, prices, or return
 * URLs from browser input; all identities came from an authenticated RPC or verified Stripe event.
 */
export class BillingService {
  private readonly rpc: BillingRpcClient;

  public constructor(
    private readonly input: {
      readonly catalog: BillingPlanCatalogEntry;
      readonly expectedLivemode: boolean;
      readonly provider: BillingStripeProvider;
      readonly supabase: SupabaseClient<Database>;
      readonly webOrigin: string;
    },
  ) {
    this.rpc = input.supabase as unknown as BillingRpcClient;
  }

  public async createCheckout(
    checkoutId: string,
  ): Promise<{ readonly action: 'checkout'; readonly url: string }> {
    const { data, error } = await this.rpc.rpc('get_billing_checkout_execution_context', {
      target_checkout_id: checkoutId,
    });
    const context = data?.[0];
    if (error || !context || context.plan_key !== this.input.catalog.key) {
      throw new Error('Billing checkout is unavailable.');
    }
    if (context.livemode !== null && context.livemode !== this.input.expectedLivemode) {
      throw new Error('Billing mode is unavailable.');
    }
    let customerId = context.stripe_customer_id;
    if (!customerId) {
      const customer = await this.input.provider.createCustomer({
        idempotencyKey: `avenlyo:billing-customer:${context.organization_id}:${this.input.expectedLivemode ? 'live' : 'test'}`,
        organizationId: context.organization_id,
        organizationName: context.organization_name,
      });
      if (customer.livemode !== this.input.expectedLivemode)
        throw new Error('Stripe mode is unavailable.');
      const saved = await this.rpc.rpc('record_stripe_billing_customer', {
        target_checkout_id: context.checkout_id,
        target_livemode: customer.livemode,
        target_stripe_customer_id: customer.id,
      });
      if (saved.error) throw new Error('Billing customer could not be saved.');
      customerId = customer.id;
    }
    const checkout = await this.input.provider.createCheckoutSession({
      cancelUrl: `${this.input.webOrigin}/dashboard/billing?checkout=cancelled`,
      customerId,
      idempotencyKey: context.idempotency_key,
      priceId: this.input.catalog.monthlyPriceId,
      successUrl: `${this.input.webOrigin}/dashboard/billing?checkout=success`,
    });
    if (
      checkout.livemode !== this.input.expectedLivemode ||
      checkout.customerId !== customerId ||
      !checkout.url
    ) {
      throw new Error('Stripe Checkout is unavailable.');
    }
    const saved = await this.rpc.rpc('record_stripe_checkout_session', {
      target_checkout_id: context.checkout_id,
      target_customer_id: checkout.customerId,
      target_expires_at: asIso(checkout.expiresAt),
      target_livemode: checkout.livemode,
      target_session_id: checkout.id,
    });
    if (saved.error) throw new Error('Billing checkout could not be saved.');
    return { action: 'checkout', url: checkout.url };
  }

  public async createPortal(accountId: string): Promise<string> {
    const context = await this.accountContext(accountId);
    const session = await this.input.provider.createPortalSession({
      customerId: context.stripe_customer_id,
      returnUrl: `${this.input.webOrigin}/dashboard/billing`,
    });
    return session.url;
  }

  public async refresh(accountId: string): Promise<void> {
    const context = await this.accountContext(accountId);
    await this.reconcileCustomer(context.organization_id, context.stripe_customer_id);
  }

  public async persistVerifiedWebhook(event: StripeWebhookEventRecord): Promise<boolean> {
    if (event.livemode !== this.input.expectedLivemode)
      throw new Error('Stripe mode is unavailable.');
    const { data, error } = await this.rpc.rpc('record_stripe_webhook_event', {
      target_created_at: event.createdAt.toISOString(),
      target_event_id: event.id,
      target_event_type: event.type,
      target_livemode: event.livemode,
      target_object_id: event.objectId,
    });
    if (error) throw new Error('Stripe webhook could not be persisted.');
    return data?.[0]?.accepted ?? false;
  }

  public verifyWebhook(rawBody: string, signature: string): StripeWebhookEventRecord {
    return this.input.provider.verifyWebhook(rawBody, signature);
  }

  public isExpectedMode(event: StripeWebhookEventRecord): boolean {
    return event.livemode === this.input.expectedLivemode;
  }

  public async claimEvents(
    workerId: string,
    limit: number,
  ): Promise<readonly StripeWebhookEventRecord[]> {
    const { data, error } = await this.rpc.rpc('claim_stripe_webhook_events', {
      target_limit: limit,
      target_worker_id: workerId,
    });
    if (error || !data) return [];
    return Promise.all(
      data.map(async (claim) => {
        const event = await this.input.provider.retrieveEvent(claim.stripe_event_id);
        if (event.livemode !== this.input.expectedLivemode || event.livemode !== claim.livemode) {
          throw new Error('Stripe event mode mismatch.');
        }
        return event;
      }),
    );
  }

  public async processClaimedEvent(
    event: StripeWebhookEventRecord,
  ): Promise<'ignored' | 'processed'> {
    if (event.livemode !== this.input.expectedLivemode)
      throw new Error('Stripe event mode mismatch.');
    if (!this.isRelevant(event.type)) return 'ignored';
    const customerId = webhookCustomerId(event);
    if (!customerId) return 'ignored';
    if (event.type === 'checkout.session.completed') {
      const mode = textField(event.object, 'mode');
      const subscriptionId = webhookSubscriptionId(event);
      if (mode !== 'subscription' || !subscriptionId || !event.objectId) return 'ignored';
      const completed = await this.rpc.rpc('complete_billing_checkout_from_event', {
        target_customer_id: customerId,
        target_livemode: event.livemode,
        target_session_id: event.objectId,
        target_subscription_id: subscriptionId,
      });
      const context = completed.data?.[0];
      if (completed.error || !context) throw new Error('Stripe Checkout mapping is unavailable.');
      await this.reconcileCustomer(context.organization_id, context.stripe_customer_id, event);
      return 'processed';
    }
    const context = await this.customerContext(customerId, event.livemode);
    await this.reconcileCustomer(context.organization_id, context.stripe_customer_id, event);
    return 'processed';
  }

  public async completeEvent(eventId: string, status: 'ignored' | 'processed'): Promise<void> {
    const { error } = await this.rpc.rpc('complete_stripe_webhook_event', {
      target_event_id: eventId,
      target_status: status,
    });
    if (error) throw new Error('Stripe webhook completion could not be saved.');
  }

  public async failEvent(eventId: string, errorCode: string): Promise<void> {
    await this.rpc.rpc('fail_stripe_webhook_event', {
      target_error_code: errorCode.slice(0, 120),
      target_event_id: eventId,
    });
  }

  private isRelevant(type: string): boolean {
    return [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
    ].includes(type);
  }

  private async accountContext(accountId: string) {
    const { data, error } = await this.rpc.rpc('get_billing_account_execution_context', {
      target_account_id: accountId,
    });
    const context = data?.[0];
    if (error || !context || context.livemode !== this.input.expectedLivemode) {
      throw new Error('Billing is unavailable.');
    }
    return context;
  }

  private async customerContext(customerId: string, livemode: boolean) {
    const { data, error } = await this.rpc.rpc('get_billing_customer_execution_context', {
      target_customer_id: customerId,
      target_livemode: livemode,
    });
    const context = data?.[0];
    if (error || !context || context.livemode !== this.input.expectedLivemode) {
      throw new Error('Stripe customer mapping is unavailable.');
    }
    return context;
  }

  private async reconcileCustomer(
    organizationId: string,
    customerId: string,
    deletedEvent?: StripeWebhookEventRecord,
  ): Promise<void> {
    let subscriptions: readonly StripeSubscriptionRecord[];
    try {
      subscriptions = await this.input.provider.listSubscriptions(customerId);
    } catch (error) {
      const fallback = deletedEvent ? fallbackDeletedSubscription(deletedEvent) : null;
      if (!fallback) throw error;
      subscriptions = [fallback];
    }
    const subscriptionIds: string[] = [];
    for (const subscription of subscriptions) {
      if (
        subscription.customerId !== customerId ||
        subscription.livemode !== this.input.expectedLivemode
      ) {
        throw new Error('Stripe subscription identity is unavailable.');
      }
      subscriptionIds.push(subscription.id);
      const projection = projectStripeSubscription(subscription, this.input.catalog);
      const saved = await this.rpc.rpc('project_stripe_billing_subscription', {
        target_cancel_at_period_end: projection.cancelAtPeriodEnd,
        target_customer_id: customerId,
        target_ended_at: asIso(projection.endedAt),
        target_is_supported: projection.isSupported,
        target_livemode: subscription.livemode,
        target_organization_id: organizationId,
        target_period_end: asIso(projection.periodEnd),
        target_period_start: asIso(projection.periodStart),
        target_plan_key: projection.planKey,
        target_price_id: projection.priceId,
        target_product_id: projection.productId,
        target_status: projection.status,
        target_subscription_id: subscription.id,
        target_trial_end: asIso(projection.trialEnd),
      });
      if (saved.error) throw new Error('Stripe subscription projection could not be saved.');
    }
    const complete = await this.rpc.rpc('mark_missing_stripe_billing_subscriptions_terminal', {
      target_customer_id: customerId,
      target_livemode: this.input.expectedLivemode,
      target_organization_id: organizationId,
      target_subscription_ids: subscriptionIds,
    });
    if (complete.error) throw new Error('Stripe subscription reconciliation could not be saved.');
  }
}
