import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

export interface EzyVetConfigurationRow {
  readonly appointment_type_active: boolean | null;
  readonly appointment_type_bookable: boolean | null;
  readonly appointment_type_id: string | null;
  readonly appointment_type_name: string | null;
  readonly environment: string | null;
  readonly integration_id: string | null;
  readonly last_catalog_synced_at: string | null;
  readonly resource_active: boolean | null;
  readonly resource_bookable: boolean | null;
  readonly resource_id: string | null;
  readonly resource_name: string | null;
  readonly site_timezone: string | null;
  readonly status: string | null;
}

export interface SchedulingAppointmentRow {
  readonly appointment_id: string;
  readonly provider: string | null;
  readonly provider_status: string | null;
  readonly starts_at: string | null;
  readonly status: string;
  readonly title: string;
}

interface SchedulingRpcCaller {
  (
    name: 'get_my_ezyvet_integration_configuration',
    args: { readonly target_location_id: string },
  ): PromiseLike<{
    readonly data: readonly EzyVetConfigurationRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'update_my_ezyvet_booking_policy',
    args: {
      readonly selected_appointment_type_ids: readonly string[];
      readonly selected_resource_ids: readonly string[];
      readonly target_location_id: string;
    },
  ): PromiseLike<{ readonly data: null; readonly error: { readonly message: string } | null }>;
  (
    name: 'get_my_scheduling_appointments',
    args: { readonly target_location_id: string },
  ): PromiseLike<{
    readonly data: readonly SchedulingAppointmentRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
}

/** Keeps the older SSR generic binding aligned with newly added database RPCs. */
export function schedulingRpc(client: AvenlyoSupabaseClient): SchedulingRpcCaller {
  return client.rpc.bind(client);
}
