import Link from 'next/link';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { schedulingRpc } from '@/lib/scheduling/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { cancelAppointmentAsStaffAction, rescheduleAppointmentAsStaffAction } from './actions';

function date(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : 'Time pending';
}

export default async function AppointmentsPage() {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const appointments =
    auth && workspace.locationId
      ? ((
          await schedulingRpc(auth.supabase)('get_my_scheduling_appointments', {
            target_location_id: workspace.locationId,
          })
        ).data ?? [])
      : [];
  const reminders =
    auth && workspace.locationId
      ? ((
          await schedulingRpc(auth.supabase)('get_my_appointment_reminders', {
            target_location_id: workspace.locationId,
          })
        ).data ?? [])
      : [];
  const remindersByAppointment = new Map<string, string[]>();
  for (const reminder of reminders) {
    const timing = reminder.reminder_type === 'appointment_24h' ? '24h' : '2h';
    const state = reminder.status === 'sent' ? 'queued for delivery' : reminder.status;
    remindersByAppointment.set(reminder.appointment_id, [
      ...(remindersByAppointment.get(reminder.appointment_id) ?? []),
      `${timing}: ${state}`,
    ]);
  }
  return (
    <section className="max-w-5xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Appointments
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        Scheduled appointments
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Confirmed local records from approved scheduling connectors. Owners and admins can safely
        cancel a future appointment after confirming the action; all changes use the durable
        provider lifecycle path.
      </p>
      <Link
        className="mt-4 inline-flex text-sm font-semibold text-primary hover:underline"
        href="/dashboard/appointments/reminders"
      >
        Manage appointment reminders
      </Link>
      <section className="mt-8 overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
        {appointments.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Appointment</th>
                  <th className="px-4 py-3">Starts</th>
                  <th className="px-4 py-3">Actions</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Reminders</th>
                  <th className="px-4 py-3">Provider</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {appointments.map((appointment) => (
                  <tr key={appointment.appointment_id}>
                    <td className="px-4 py-3 font-medium text-ink">{appointment.title}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {date(appointment.starts_at)}
                    </td>
                    <td className="px-4 py-3">
                      {workspace.role !== 'member' && appointment.status === 'confirmed' ? (
                        <>
                          <form action={cancelAppointmentAsStaffAction}>
                            <input name="appointmentId" type="hidden" value={appointment.appointment_id} />
                            <button
                              className="rounded-md border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/5"
                              type="submit"
                            >
                              Cancel appointment
                            </button>
                          </form>
                          <form action={rescheduleAppointmentAsStaffAction} className="mt-2 grid gap-1">
                            <input name="appointmentId" type="hidden" value={appointment.appointment_id} />
                            <input aria-label="New start time in UTC" className="w-40 rounded border border-border px-2 py-1 text-xs" name="startsAt" placeholder="2026-09-01T11:00:00Z" required />
                            <input aria-label="New end time in UTC" className="w-40 rounded border border-border px-2 py-1 text-xs" name="endsAt" placeholder="2026-09-01T11:30:00Z" required />
                            <button className="w-fit rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-ink hover:bg-muted" type="submit">Reschedule (UTC)</button>
                          </form>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">No action available</span>
                      )}
                    </td>
                    <td className="px-4 py-3 capitalize text-ink">{appointment.status}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {remindersByAppointment.get(appointment.appointment_id)?.join(' · ') ??
                        'Not scheduled'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {appointment.provider === 'ezyvet'
                        ? `ezyVet · ${appointment.provider_status ?? 'pending'}`
                        : 'Internal'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-6 text-sm leading-6 text-muted-foreground">
            No connector-created appointments have been recorded for this location yet.
          </p>
        )}
      </section>
    </section>
  );
}
