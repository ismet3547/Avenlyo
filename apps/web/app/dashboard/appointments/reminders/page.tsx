import Link from 'next/link';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { schedulingRpc } from '@/lib/scheduling/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

import { saveAppointmentReminderSettingsAction } from './actions';

function asTime(value: string): string {
  return value.slice(0, 5);
}

export default async function AppointmentRemindersPage() {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const settings =
    auth && workspace.locationId
      ? (
          await schedulingRpc(auth.supabase)('get_my_appointment_reminder_settings', {
            target_location_id: workspace.locationId,
          })
        ).data?.[0]
      : null;

  if (workspace.role === 'member' || !workspace.locationId) {
    return (
      <section className="max-w-3xl">
        <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Appointments
        </p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
          Appointment reminders
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Reminder settings are managed by an organization owner or admin.
        </p>
        <Link
          className="mt-6 inline-flex text-sm font-semibold text-primary hover:underline"
          href="/dashboard/appointments"
        >
          Back to appointments
        </Link>
      </section>
    );
  }

  const configured = settings ?? {
    quiet_hours_end: '08:00',
    quiet_hours_start: '20:00',
    reminder_24h_enabled: true,
    reminder_2h_enabled: true,
    sms_enabled: false,
    sms_sender_available: false,
    timezone: 'your location timezone',
  };

  return (
    <section className="max-w-3xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Appointments
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Appointment reminders
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Deterministic SMS reminders are disabled by default. Eligible confirmed appointments use the
        phone number captured when the booking was made, not a later contact edit.
      </p>

      <form
        action={saveAppointmentReminderSettingsAction}
        className="mt-8 space-y-6 rounded-2xl border border-border bg-white p-6 shadow-sm"
      >
        {!configured.sms_sender_available ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            An active SMS-enabled business number is required before a reminder can be sent.
          </p>
        ) : null}
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            className="mt-1 size-4 accent-primary"
            defaultChecked={configured.sms_enabled && configured.sms_sender_available}
            disabled={!configured.sms_sender_available}
            name="smsEnabled"
            type="checkbox"
          />
          <span>
            <strong className="font-semibold text-ink">Enable appointment SMS reminders</strong>
            <br />
            <span className="text-muted-foreground">
              Only confirmed future appointments within 30 days are considered.
            </span>
          </span>
        </label>
        <fieldset className="space-y-3 border-t border-border pt-5">
          <legend className="text-sm font-semibold text-ink">Reminder timing</legend>
          <label className="flex items-center gap-3 text-sm text-ink">
            <input
              className="size-4 accent-primary"
              defaultChecked={configured.reminder_24h_enabled}
              name="reminder24hEnabled"
              type="checkbox"
            />{' '}
            Send 24 hours before
          </label>
          <label className="flex items-center gap-3 text-sm text-ink">
            <input
              className="size-4 accent-primary"
              defaultChecked={configured.reminder_2h_enabled}
              name="reminder2hEnabled"
              type="checkbox"
            />{' '}
            Send 2 hours before
          </label>
        </fieldset>
        <fieldset className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
          <legend className="col-span-full text-sm font-semibold text-ink">
            Quiet hours ({configured.timezone})
          </legend>
          <label className="grid gap-2 text-sm font-medium text-ink">
            Start
            <input
              className="rounded-md border border-input bg-background px-3 py-2"
              defaultValue={asTime(configured.quiet_hours_start)}
              name="quietHoursStart"
              type="time"
              required
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-ink">
            End
            <input
              className="rounded-md border border-input bg-background px-3 py-2"
              defaultValue={asTime(configured.quiet_hours_end)}
              name="quietHoursEnd"
              type="time"
              required
            />
          </label>
          <p className="col-span-full text-xs leading-5 text-muted-foreground">
            When a reminder falls in quiet hours, it is moved to the closest earlier permitted local
            time only when it remains in its useful send window. It is never delayed closer to the
            appointment.
          </p>
        </fieldset>
        <div className="flex items-center gap-4 border-t border-border pt-5">
          <button
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            type="submit"
          >
            Save reminders
          </button>
          <Link
            className="text-sm font-semibold text-muted-foreground hover:text-ink"
            href="/dashboard/appointments"
          >
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}
