import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

export interface LeadFollowupSettingsRow {
  readonly automation_acknowledged_at: string | null;
  readonly business_hours_only: boolean;
  readonly delay_minutes: number;
  readonly lead_followup_enabled: boolean;
  readonly quiet_hours_end: string;
  readonly quiet_hours_start: string;
  readonly sender_available: boolean;
}

export interface LeadFollowupStateRow {
  readonly failure_reason: string | null;
  readonly scheduled_for: string | null;
  readonly skip_reason: string | null;
  readonly status:
    | 'awaiting_consent'
    | 'delivery_pending'
    | 'failed'
    | 'not_eligible'
    | 'processing'
    | 'scheduled'
    | 'sent'
    | 'skipped';
}

export interface FollowupsRpcCaller {
  (
    name: 'get_my_lead_followup_settings',
    args: { readonly target_location_id: string },
  ): PromiseLike<{
    readonly data: readonly LeadFollowupSettingsRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'get_my_lead_followup',
    args: { readonly target_lead_id: string },
  ): PromiseLike<{
    readonly data: readonly LeadFollowupStateRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'upsert_my_lead_followup_settings',
    args: {
      readonly target_acknowledge_sender: boolean;
      readonly target_business_hours_only: boolean;
      readonly target_delay_minutes: number;
      readonly target_enabled: boolean;
      readonly target_location_id: string;
      readonly target_quiet_hours_end: string;
      readonly target_quiet_hours_start: string;
    },
  ): PromiseLike<{ readonly data: null; readonly error: { readonly message: string } | null }>;
}

/** Keeps Phase 11 RPC contracts narrow until generated database types are refreshed. */
export function followupsRpc(client: AvenlyoSupabaseClient): FollowupsRpcCaller {
  return client.rpc.bind(client);
}
