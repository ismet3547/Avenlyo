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

export interface AppointmentReminderSettingsRow {
  readonly sms_enabled: boolean;
  readonly reminder_24h_enabled: boolean;
  readonly reminder_2h_enabled: boolean;
  readonly quiet_hours_start: string;
  readonly quiet_hours_end: string;
  readonly sms_sender_available: boolean;
  readonly timezone: string;
}

export interface AppointmentReminderRow {
  readonly appointment_id: string;
  readonly reminder_type: 'appointment_24h' | 'appointment_2h';
  readonly scheduled_for: string;
  readonly status: 'scheduled' | 'processing' | 'sent' | 'skipped' | 'failed';
  readonly last_error_code: string | null;
  readonly message_id: string | null;
}

export interface GoogleCalendarConfigurationRow {
  readonly integration_id: string | null;
  readonly status: string | null;
  readonly last_verified_at: string | null;
  readonly is_active: boolean | null;
  readonly minimum_lead_minutes: number | null;
  readonly appointment_type_id: string | null;
  readonly appointment_type_name: string | null;
  readonly appointment_type_duration_minutes: number | null;
  readonly appointment_type_bookable: boolean | null;
  readonly resource_id: string | null;
  readonly resource_name: string | null;
  readonly resource_access_role: string | null;
  readonly resource_bookable: boolean | null;
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
  (
    name: 'get_my_appointment_reminder_settings',
    args: { readonly target_location_id: string },
  ): PromiseLike<{
    readonly data: readonly AppointmentReminderSettingsRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'get_my_appointment_reminders',
    args: { readonly target_location_id: string },
  ): PromiseLike<{
    readonly data: readonly AppointmentReminderRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'upsert_my_appointment_reminder_settings',
    args: {
      readonly target_location_id: string;
      readonly target_sms_enabled: boolean;
      readonly target_24h_enabled: boolean;
      readonly target_2h_enabled: boolean;
      readonly target_quiet_hours_start: string;
      readonly target_quiet_hours_end: string;
    },
  ): PromiseLike<{ readonly data: null; readonly error: { readonly message: string } | null }>;
  (
    name: 'get_my_google_scheduling_configuration',
    args: { readonly target_location_id: string },
  ): PromiseLike<{
    readonly data: readonly GoogleCalendarConfigurationRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'create_my_google_appointment_type',
    args: {
      readonly target_location_id: string;
      readonly target_name: string;
      readonly target_duration_minutes: number;
    },
  ): PromiseLike<{
    readonly data: readonly { readonly appointment_type_id: string }[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'update_my_google_booking_policy',
    args: {
      readonly target_location_id: string;
      readonly selected_appointment_type_ids: readonly string[];
      readonly selected_resource_ids: readonly string[];
      readonly mappings: unknown[];
    },
  ): PromiseLike<{ readonly data: null; readonly error: { readonly message: string } | null }>;
  (
    name: 'set_my_active_scheduling_integration',
    args: {
      readonly target_location_id: string;
      readonly target_integration_id: string;
      readonly target_minimum_lead_minutes: number;
    },
  ): PromiseLike<{ readonly data: null; readonly error: { readonly message: string } | null }>;
}

/** Keeps the older SSR generic binding aligned with newly added database RPCs. */
export function schedulingRpc(client: AvenlyoSupabaseClient): SchedulingRpcCaller {
  return client.rpc.bind(client);
}
