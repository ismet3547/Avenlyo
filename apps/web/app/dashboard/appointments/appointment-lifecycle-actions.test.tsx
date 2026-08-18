import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { appointmentLifecycleCapabilities } from './appointment-lifecycle-capabilities';
import { AppointmentLifecycleActions } from './appointment-lifecycle-actions';

function render(provider: 'ezyvet' | 'google_calendar'): string {
  const capabilities = appointmentLifecycleCapabilities(provider);
  return renderToStaticMarkup(
    <AppointmentLifecycleActions
      appointmentId="11111111-1111-4111-8111-111111111111"
      canCancel={capabilities.canCancel}
      canReschedule={capabilities.canReschedule}
      currentTime="Sep 1, 2026, 10:00 AM"
      provider={provider}
      rescheduleUnavailableMessage={capabilities.rescheduleUnavailableMessage}
    />,
  );
}

describe('AppointmentLifecycleActions provider capabilities', () => {
  it('shows Google Calendar staff cancellation and reschedule controls', () => {
    const markup = render('google_calendar');

    expect(markup).toContain('Cancel appointment');
    expect(markup).toContain('Review reschedule (UTC)');
    expect(markup).toContain('New start time in UTC');
  });

  it('shows ezyVet cancellation only and does not render a reschedule submission path', () => {
    const markup = render('ezyvet');

    expect(markup).toContain('Cancel appointment');
    expect(markup).toContain('Reschedule requires clinic handling.');
    expect(markup).not.toContain('Review reschedule (UTC)');
    expect(markup).not.toContain('Confirm reschedule');
    expect(markup).not.toContain('New start time in UTC');
  });
});
