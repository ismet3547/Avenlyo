import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import type { BillingExecutionSummary } from './execution';

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
  (
    name: 'get_my_billing_execution_summary',
    args: { readonly target_organization_id: string },
  ): PromiseLike<{
    readonly data: readonly BillingExecutionSummary[] | null;
    readonly error: { readonly message: string } | null;
  }>;
}

/**
 * The execution summary any authorized member may read. A failure returns null rather than
 * throwing: a billing read must never be able to take the dashboard down, and "we do not know"
 * is safely rendered as no banner at all.
 */
export async function loadBillingExecutionSummary(
  client: AvenlyoSupabaseClient,
  organizationId: string,
): Promise<BillingExecutionSummary | null> {
  const response = await billingRpc(client)('get_my_billing_execution_summary', {
    target_organization_id: organizationId,
  });
  return response.error ? null : (response.data?.[0] ?? null);
}

/** Keeps the generated Supabase type boundary narrow while billing RPCs are additive. */
export function billingRpc(client: AvenlyoSupabaseClient): BillingRpcCaller {
  return client.rpc.bind(client);
}
