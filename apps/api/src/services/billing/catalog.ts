export const billingPlanKeys = ['core'] as const;

export type BillingPlanKey = (typeof billingPlanKeys)[number];

export interface BillingPlanCatalogEntry {
  readonly features: readonly [
    'voice',
    'sms',
    'web_chat',
    'appointments',
    'lead_capture',
    'reminders',
    'lead_followups',
  ];
  readonly key: BillingPlanKey;
  readonly name: 'Avenlyo Core';
  readonly productId: string;
  readonly monthlyPriceId: string;
  /** Null means intentionally unlimited in Phase 12. */
  readonly usageLimits: Readonly<
    Record<'voice_seconds' | 'outbound_sms' | 'ai_text_turn' | 'appointment_booked', null>
  >;
}

export interface BillingCatalogEnvironment {
  readonly STRIPE_PRICE_CORE_MONTHLY?: string | undefined;
  readonly STRIPE_PRODUCT_CORE?: string | undefined;
}

export function createBillingCatalog(
  environment: BillingCatalogEnvironment,
): Readonly<Record<BillingPlanKey, BillingPlanCatalogEntry>> | null {
  const productId = environment.STRIPE_PRODUCT_CORE?.trim();
  const monthlyPriceId = environment.STRIPE_PRICE_CORE_MONTHLY?.trim();
  if (!productId || !monthlyPriceId) return null;
  return {
    core: {
      features: [
        'voice',
        'sms',
        'web_chat',
        'appointments',
        'lead_capture',
        'reminders',
        'lead_followups',
      ],
      key: 'core',
      monthlyPriceId,
      name: 'Avenlyo Core',
      productId,
      usageLimits: {
        ai_text_turn: null,
        appointment_booked: null,
        outbound_sms: null,
        voice_seconds: null,
      },
    },
  };
}

export function isBillingPlanKey(value: string): value is BillingPlanKey {
  return value === 'core';
}
