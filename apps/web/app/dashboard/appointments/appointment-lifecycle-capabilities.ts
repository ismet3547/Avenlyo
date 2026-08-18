export interface AppointmentLifecycleCapabilities {
  readonly canCancel: boolean;
  readonly canReschedule: boolean;
  readonly rescheduleUnavailableMessage: string | null;
}

/** Mirrors the provider lifecycle contract used by the trusted API, without exposing credentials. */
export function appointmentLifecycleCapabilities(
  provider: string | null,
): AppointmentLifecycleCapabilities {
  if (provider === 'google_calendar') {
    return { canCancel: true, canReschedule: true, rescheduleUnavailableMessage: null };
  }
  if (provider === 'ezyvet') {
    return {
      canCancel: true,
      canReschedule: false,
      rescheduleUnavailableMessage: 'Reschedule requires clinic handling.',
    };
  }
  return {
    canCancel: false,
    canReschedule: false,
    rescheduleUnavailableMessage: 'Appointment changes are unavailable for this provider.',
  };
}
