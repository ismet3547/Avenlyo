import type { Database } from '@avenlyo/database';
import type { BookingConnector } from '@avenlyo/integrations';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { ApiSchedulingConnectorRegistry } from '../scheduling/connector-registry.js';

import { AppointmentReminderWorker } from './appointment-reminder-worker.js';

const providerContext = {
  appointment_id: 'appointment-1',
  appointment_type_key: 'type-1',
  booking_intent_id: 'intent-1',
  ends_at: '2026-08-20T10:30:00.000Z',
  external_appointment_id: 'external-1',
  external_contact_uid: 'contact-1',
  external_subject_uid: 'subject-1',
  integration_id: 'integration-1',
  integration_status: 'connected',
  location_id: 'location-1',
  organization_id: 'organization-1',
  provider: 'ezyvet' as const,
  provider_resource_key: 'resource-1',
  reminder_id: 'reminder-1',
  starts_at: '2026-08-20T10:00:00.000Z',
  timezone: 'UTC',
  trusted_sms_recipient_e164: '+14155550101',
};

function workerFor(input: {
  readonly connector?: BookingConnector;
  readonly context?: Record<string, unknown>;
}) {
  const rpc = vi.fn((name: string) => {
    if (name === 'get_appointment_reminder_execution_context') {
      return Promise.resolve({ data: [input.context ?? providerContext], error: null });
    }
    return Promise.resolve({ data: [], error: null });
  });
  const forIntegration = vi.fn().mockResolvedValue(input.connector);
  const worker = new AppointmentReminderWorker({
    connectors: { forIntegration } as unknown as ApiSchedulingConnectorRegistry,
    supabase: { rpc } as unknown as SupabaseClient<Database>,
  });
  return { forIntegration, rpc, worker };
}

describe('AppointmentReminderWorker', () => {
  it('uses read-only reconciliation before materialising a provider-backed reminder', async () => {
    const reconcileBooking = vi.fn().mockResolvedValue({
      appointment: { appointmentKey: 'external-1', providerStatus: 'confirmed' },
      kind: 'found',
    });
    const { forIntegration, rpc, worker } = workerFor({
      connector: {
        createBooking: vi.fn(),
        getAvailability: vi.fn(),
        provider: 'ezyvet',
        reconcileBooking,
        resolveBookingParty: vi.fn(),
      },
    });

    await (worker as unknown as { process(reminderId: string): Promise<void> }).process(
      'reminder-1',
    );

    expect(forIntegration).toHaveBeenCalledWith('ezyvet', 'integration-1');
    expect(reconcileBooking).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('record_appointment_reminder_revalidation', {
      target_outcome: 'confirmed',
      target_reminder_id: 'reminder-1',
    });
    expect(rpc).toHaveBeenCalledWith('create_appointment_reminder_message', {
      target_reminder_id: 'reminder-1',
    });
  });

  it('does not construct a connector or send a reminder after a provider becomes unavailable', async () => {
    const { forIntegration, rpc, worker } = workerFor({
      context: { ...providerContext, integration_status: 'disabled' },
    });

    await (worker as unknown as { process(reminderId: string): Promise<void> }).process(
      'reminder-1',
    );

    expect(forIntegration).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('record_appointment_reminder_revalidation', {
      target_outcome: 'provider_unavailable',
      target_reminder_id: 'reminder-1',
    });
    expect(rpc).not.toHaveBeenCalledWith('create_appointment_reminder_message', expect.anything());
  });

  it('allows a confirmed local appointment with no provider identity without any provider call', async () => {
    const { forIntegration, rpc, worker } = workerFor({
      context: {
        ...providerContext,
        external_appointment_id: null,
        integration_id: null,
        integration_status: null,
        provider: null,
      },
    });

    await (worker as unknown as { process(reminderId: string): Promise<void> }).process(
      'reminder-1',
    );

    expect(forIntegration).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('record_appointment_reminder_revalidation', {
      target_outcome: 'not_required',
      target_reminder_id: 'reminder-1',
    });
    expect(rpc).toHaveBeenCalledWith('create_appointment_reminder_message', {
      target_reminder_id: 'reminder-1',
    });
  });
});
