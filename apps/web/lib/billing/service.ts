import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

export interface BillingOverviewRow {
  readonly billing_attention: boolean;
  readonly billing_state: 'active' | 'attention' | 'inactive' | 'review_required' | 'unconfigured';
  readonly cancel_at_period_end: boolean | null;
  readonly current_period_end: string | null;
  readonly current_period_start: string | null;
  readonly plan_key: 'core' | null;
  readonly can_manage_billing: boolean;
  readonly can_subscribe: boolean;
  readonly has_authoritative_period: boolean;
  readonly has_current_subscription: boolean;
  readonly stripe_status: string | null;
  readonly trial_end: string | null;
}

export interface BillingUsageSummaryRow {
  readonly ai_text_turns: number;
  readonly appointments_booked: number;
  readonly outbound_sms: number;
  readonly period_kind: 'current_month_preview' | 'stripe_billing_period';
  readonly period_end: string;
  readonly period_start: string;
  readonly voice_seconds: number;
}

interface BillingRpcCaller {
  (
    name: 'get_my_billing_overview',
    args: { readonly target_organization_id: string },
  ): PromiseLike<{
    readonly data: readonly BillingOverviewRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'get_my_billing_usage_summary',
    args: { readonly target_organization_id: string },
  ): PromiseLike<{
    readonly data: readonly BillingUsageSummaryRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
}

/** Keeps the generated Supabase type boundary narrow while billing RPCs are additive. */
export function billingRpc(client: AvenlyoSupabaseClient): BillingRpcCaller {
  return client.rpc.bind(client);
}
