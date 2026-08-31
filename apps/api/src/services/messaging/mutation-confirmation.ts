import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

export type MutationConfirmationIntent =
  | 'APPOINTMENT_BOOK'
  | 'APPOINTMENT_CANCEL'
  | 'APPOINTMENT_RESCHEDULE';

export interface MutationConfirmationAuthority {
  readonly actionIntentId: string;
  readonly intent: MutationConfirmationIntent;
}

interface BookingSnapshotRow {
  readonly appointment_type_name: string;
  readonly booking_intent_id: string;
  readonly location_name: string;
  readonly starts_at: string;
  readonly subject_name: string;
  readonly timezone: string;
}

interface ChangeSnapshotRow {
  readonly appointment_title: string;
  readonly change_intent_id: string;
  readonly location_name: string;
  readonly operation: 'cancel' | 'reschedule';
  readonly original_starts_at: string;
  readonly target_starts_at: string | null;
  readonly timezone: string;
}

interface ConfirmationSnapshotRpc {
  (
    name: 'get_customer_booking_confirmation_snapshot',
    args: { target_booking_intent_id: string },
  ): PromiseLike<{ data: BookingSnapshotRow[] | null; error: unknown }>;
  (
    name: 'get_customer_appointment_change_confirmation_snapshot',
    args: { target_change_intent_id: string },
  ): PromiseLike<{ data: ChangeSnapshotRow[] | null; error: unknown }>;
}

function safeLabel(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 120);
  return normalized || fallback;
}

function formattedInstant(value: string, timezone: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error('Prepared confirmation time is invalid.');
  try {
    return new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
      timeZone: timezone,
      timeZoneName: 'short',
      year: 'numeric',
    }).format(instant);
  } catch {
    throw new Error('Prepared confirmation timezone is invalid.');
  }
}

/**
 * Builds the exact customer-facing confirmation from a trusted prepared-action snapshot.
 * No model text or model-selected identifier participates in this summary.
 */
export async function buildMutationConfirmationText(
  supabase: SupabaseClient<Database>,
  authority: MutationConfirmationAuthority,
): Promise<string> {
  const rpc = supabase.rpc.bind(supabase) as unknown as ConfirmationSnapshotRpc;

  if (authority.intent === 'APPOINTMENT_BOOK') {
    const { data, error } = await rpc('get_customer_booking_confirmation_snapshot', {
      target_booking_intent_id: authority.actionIntentId,
    });
    const row = data?.[0];
    if (error || !row || row.booking_intent_id !== authority.actionIntentId) {
      throw new Error('Prepared booking confirmation is unavailable.');
    }
    const subject = safeLabel(row.subject_name, 'customer');
    const type = safeLabel(row.appointment_type_name, 'appointment');
    const location = safeLabel(row.location_name, 'this location');
    const when = formattedInstant(row.starts_at, row.timezone);
    return `Please confirm: book ${type} for ${subject} at ${location} on ${when}. Reply YES to confirm.`;
  }

  const { data, error } = await rpc('get_customer_appointment_change_confirmation_snapshot', {
    target_change_intent_id: authority.actionIntentId,
  });
  const row = data?.[0];
  if (error || !row || row.change_intent_id !== authority.actionIntentId) {
    throw new Error('Prepared appointment-change confirmation is unavailable.');
  }
  const title = safeLabel(row.appointment_title, 'appointment');
  const location = safeLabel(row.location_name, 'this location');
  const original = formattedInstant(row.original_starts_at, row.timezone);

  if (authority.intent === 'APPOINTMENT_CANCEL') {
    if (row.operation !== 'cancel') throw new Error('Prepared cancellation confirmation conflicts.');
    return `Please confirm: cancel ${title} at ${location}, currently scheduled for ${original}. Reply YES to confirm.`;
  }

  if (row.operation !== 'reschedule' || !row.target_starts_at) {
    throw new Error('Prepared reschedule confirmation conflicts.');
  }
  const target = formattedInstant(row.target_starts_at, row.timezone);
  return `Please confirm: move ${title} at ${location} from ${original} to ${target}. Reply YES to confirm.`;
}
