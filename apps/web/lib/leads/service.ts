import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

export interface LeadListRow {
  readonly created_at: string;
  readonly customer_goal: string | null;
  readonly customer_name: string | null;
  readonly lead_id: string;
  readonly location_id: string | null;
  readonly qualification_reason: string | null;
  readonly qualified_at: string | null;
  readonly converted_at: string | null;
  readonly service_category: string | null;
  readonly source_channel: string | null;
  readonly status: string;
  readonly urgency: string;
}

export interface LeadDetailRow extends LeadListRow {
  readonly conversion_appointment_id: string | null;
  readonly details: Record<string, unknown>;
  readonly updated_at: string;
}

export interface InboxLeadIndicatorRow {
  readonly conversation_id: string;
  readonly lead_status: string;
  readonly service_category: string | null;
  readonly urgency: string;
}

export interface LeadsRpcCaller {
  (
    name: 'get_my_leads',
    args: {
      readonly target_location_id: string | null;
      readonly target_source_channel: string | null;
      readonly target_status: string | null;
      readonly target_urgency: string | null;
    },
  ): PromiseLike<{
    readonly data: readonly LeadListRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'get_my_lead_detail',
    args: { readonly target_lead_id: string },
  ): PromiseLike<{
    readonly data: readonly LeadDetailRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'get_my_inbox_lead_indicators',
    args: { readonly target_location_id: string | null },
  ): PromiseLike<{
    readonly data: readonly InboxLeadIndicatorRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
}

/** Keeps dashboard lead RPC calls strict without widening the generated Supabase client. */
export function leadsRpc(client: AvenlyoSupabaseClient): LeadsRpcCaller {
  return client.rpc.bind(client);
}
