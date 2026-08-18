'use client';

import { useState } from 'react';

import { cancelAppointmentAsStaffAction, rescheduleAppointmentAsStaffAction } from './actions';

interface AppointmentLifecycleActionsProps {
  readonly appointmentId: string;
  readonly currentTime: string | null;
}

/**
 * Server actions are only attached to the explicit confirm forms. Closing either dialog does not
 * create a durable intent or contact a scheduling provider.
 */
export function AppointmentLifecycleActions({
  appointmentId,
  currentTime,
}: AppointmentLifecycleActionsProps) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const hasTarget = startsAt.trim().length > 0 && endsAt.trim().length > 0;

  return (
    <div className="grid gap-2">
      <button
        className="w-fit rounded-md border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/5"
        onClick={() => setCancelOpen(true)}
        type="button"
      >
        Cancel appointment
      </button>
      <div className="grid gap-1">
        <input
          name="startsAt"
          aria-label="New start time in UTC"
          className="w-40 rounded border border-border px-2 py-1 text-xs"
          onChange={(event) => setStartsAt(event.target.value)}
          placeholder="2026-09-01T11:00:00Z"
          required
          value={startsAt}
        />
        <input
          name="endsAt"
          aria-label="New end time in UTC"
          className="w-40 rounded border border-border px-2 py-1 text-xs"
          onChange={(event) => setEndsAt(event.target.value)}
          placeholder="2026-09-01T11:30:00Z"
          required
          value={endsAt}
        />
        <button
          className="w-fit rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-ink hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!hasTarget}
          onClick={() => setRescheduleOpen(true)}
          type="button"
        >
          Review reschedule (UTC)
        </button>
      </div>

      {cancelOpen ? (
        <div
          aria-labelledby={`cancel-title-${appointmentId}`}
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4"
          role="dialog"
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-white p-5 shadow-xl">
            <h2
              className="font-display text-lg font-semibold text-ink"
              id={`cancel-title-${appointmentId}`}
            >
              Cancel this appointment?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This sends one durable cancellation request to the configured provider.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted"
                onClick={() => setCancelOpen(false)}
                type="button"
              >
                Keep appointment
              </button>
              <form action={cancelAppointmentAsStaffAction}>
                <input name="appointmentId" type="hidden" value={appointmentId} />
                <button
                  className="rounded-md bg-destructive px-3 py-2 text-sm font-semibold text-white hover:bg-destructive/90"
                  type="submit"
                >
                  Confirm cancellation
                </button>
              </form>
            </div>
          </div>
        </div>
      ) : null}

      {rescheduleOpen ? (
        <div
          aria-labelledby={`reschedule-title-${appointmentId}`}
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4"
          role="dialog"
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-white p-5 shadow-xl">
            <h2
              className="font-display text-lg font-semibold text-ink"
              id={`reschedule-title-${appointmentId}`}
            >
              Confirm reschedule
            </h2>
            <dl className="mt-3 grid gap-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Current (local display)</dt>
                <dd className="font-medium text-ink">{currentTime ?? 'Time pending'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">New start (UTC)</dt>
                <dd className="font-medium text-ink">{startsAt}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">New end (UTC)</dt>
                <dd className="font-medium text-ink">{endsAt}</dd>
              </div>
            </dl>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted"
                onClick={() => setRescheduleOpen(false)}
                type="button"
              >
                Keep appointment
              </button>
              <form action={rescheduleAppointmentAsStaffAction}>
                <input name="appointmentId" type="hidden" value={appointmentId} />
                <input name="startsAt" type="hidden" value={startsAt} />
                <input name="endsAt" type="hidden" value={endsAt} />
                <button
                  className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary/90"
                  type="submit"
                >
                  Confirm reschedule
                </button>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
