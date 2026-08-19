import { env, expectedStripeLivemode, isStripeBillingConfigured } from '../../env.js';
import { createServiceSupabaseClient } from '../../lib/supabase.js';

import { createBillingCatalog } from './catalog.js';
import { BillingEventWorker } from './event-worker.js';
import { BillingService } from './billing-service.js';
import { StripeSdkBillingProvider } from './stripe-provider.js';

export interface BillingRuntime {
  readonly service: BillingService;
  start(): void;
  stop(): Promise<void>;
}

/** No Stripe client is constructed unless every server-only billing setting is present. */
export function createBillingRuntime(): BillingRuntime | null {
  const supabase = createServiceSupabaseClient();
  const catalog = createBillingCatalog(env);
  if (
    !supabase ||
    !catalog ||
    !isStripeBillingConfigured ||
    !env.STRIPE_SECRET_KEY ||
    !env.STRIPE_WEBHOOK_SECRET
  ) {
    return null;
  }
  const service = new BillingService({
    catalog: catalog.core,
    expectedLivemode: expectedStripeLivemode,
    provider: new StripeSdkBillingProvider({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    }),
    supabase,
    webOrigin: env.API_CORS_ORIGIN,
  });
  const worker = new BillingEventWorker(service);
  return { service, start: () => worker.start(), stop: () => worker.stop() };
}
