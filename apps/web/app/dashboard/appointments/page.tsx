import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { schedulingRpc } from '@/lib/scheduling/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

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
  return (
    <section className="max-w-5xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Appointments
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        Scheduled appointments
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Confirmed local records from approved scheduling connectors. Rescheduling and cancellation
        are not available in this phase.
      </p>
      <section className="mt-8 overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
        {appointments.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Appointment</th>
                  <th className="px-4 py-3">Starts</th>
                  <th className="px-4 py-3">Status</th>
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
                    <td className="px-4 py-3 capitalize text-ink">{appointment.status}</td>
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
