import type { Database } from '@avenlyo/database';
import { BookingProviderError, type BookingConnector } from '@avenlyo/integrations';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { ApiSchedulingConnectorRegistry } from './connector-registry.js';
import { VoiceBookingService } from './voice-booking-service.js';

const execution = {
  appointment_type_name: 'Consultation',
  appointment_type_uid: 'type_1',
  booking_intent_id: 'intent_1',
  business_hours: { monday: { closed: false, close: '17:00', open: '09:00' } },
  contact_id: null,
  conversation_id: 'conversation_1',
  current_write_eligible: true,
  customer_display_name: 'Jamie',
  default_duration_minutes: 30,
  ends_at: '2026-09-01T10:30:00.000Z',
  external_contact_uid: null,
  external_subject_uid: null,
  intent_status: 'booking',
  integration_id: 'integration_1',
  location_id: 'location_1',
  minimum_lead_minutes: 60,
  organization_id: 'organization_1',
  provider: 'google_calendar' as const,
  provider_appointment_id: null,
  provider_booking_status: null,
  resource_name: 'Room One',
  resource_uid: 'calendar_1',
  starts_at: '2026-09-01T10:00:00.000Z',
  subject_name: null,
  timezone: 'UTC',
  trusted_phone_e164: '+14155550123',
};

type ExecutionRow = Omit<typeof execution, 'provider'> & {
  readonly provider: 'ezyvet' | 'google_calendar';
};

function bookingInput() {
  return {
    bookingIntentId: 'intent_1',
    confirmationText: 'Yes, please book it.',
    toolCallId: 'tool_1',
  };
}

function serviceFor(input: {
  readonly claimState: string;
  readonly connector: BookingConnector;
  readonly executionRow?: ExecutionRow;
}) {
  const forIntegration = vi.fn().mockResolvedValue(input.connector);
  const rpc = vi.fn((name: string) => {
    if (name === 'claim_voice_scheduling_booking_intent') {
      return Promise.resolve({
        data: [
          {
            booking_intent_id: 'intent_1',
            confirmed_message_id: 'message_1',
            state: input.claimState,
          },
        ],
        error: null,
      });
    }
    if (name === 'get_voice_booking_execution_context')
      return Promise.resolve({ data: [input.executionRow ?? execution], error: null });
    if (name === 'claim_booking_slot_lease')
      return Promise.resolve({ data: [{ lease_id: 'lease_1' }], error: null });
    return Promise.resolve({ data: null, error: null });
  });
  return {
    forIntegration,
    rpc,
    service: new VoiceBookingService({
      connectors: {
        forIntegration,
      } as unknown as ApiSchedulingConnectorRegistry,
      supabase: { rpc } as unknown as SupabaseClient<Database>,
    }),
  };
}

describe('VoiceBookingService booking reliability', () => {
  it('reconciles after a simulated post-write crash and never sends another provider POST', async () => {
    const createBooking = vi.fn();
    const reconcileBooking = vi.fn().mockResolvedValue({
      appointment: { appointmentKey: 'event_1', providerStatus: 'confirmed' },
      kind: 'found',
    });
    const { forIntegration, rpc, service } = serviceFor({
      claimState: 'booking_recovery',
      connector: { createBooking, reconcileBooking } as unknown as BookingConnector,
      executionRow: { ...execution, current_write_eligible: false },
    });

    await expect(service.bookAppointment(bookingInput(), { callId: 'call_1' })).resolves.toEqual({
      outcome: 'booked',
    });

    expect(reconcileBooking).toHaveBeenCalledOnce();
    expect(createBooking).not.toHaveBeenCalled();
    expect(forIntegration).toHaveBeenCalledWith('google_calendar', 'integration_1');
    expect(rpc).toHaveBeenCalledWith('record_voice_booking_provider_success', expect.any(Object));
    expect(rpc).toHaveBeenCalledWith('complete_voice_booking_intent', {
      target_booking_intent_id: 'intent_1',
    });
  });

  it('recovers a disconnected ezyVet booking without sending another provider POST', async () => {
    const createBooking = vi.fn();
    const reconcileBooking = vi.fn().mockResolvedValue({
      appointment: { appointmentKey: 'ezyvet-appointment-1', providerStatus: 'unconfirmed' },
      kind: 'found',
    });
    const { forIntegration, rpc, service } = serviceFor({
      claimState: 'booking_recovery',
      connector: { createBooking, reconcileBooking } as unknown as BookingConnector,
      executionRow: { ...execution, current_write_eligible: false, provider: 'ezyvet' },
    });

    await expect(service.bookAppointment(bookingInput(), { callId: 'call_1' })).resolves.toEqual({
      outcome: 'booked',
    });

    expect(reconcileBooking).toHaveBeenCalledOnce();
    expect(createBooking).not.toHaveBeenCalled();
    expect(forIntegration).toHaveBeenCalledWith('ezyvet', 'integration_1');
    expect(rpc).toHaveBeenCalledWith('record_voice_booking_provider_success', expect.any(Object));
    expect(rpc).toHaveBeenCalledWith('complete_voice_booking_intent', {
      target_booking_intent_id: 'intent_1',
    });
  });

  it('persists a durable ezyVet provider result after disconnect without calling the provider', async () => {
    const createBooking = vi.fn();
    const reconcileBooking = vi.fn();
    const { forIntegration, rpc, service } = serviceFor({
      claimState: 'provider_success_pending_persistence',
      connector: { createBooking, reconcileBooking } as unknown as BookingConnector,
      executionRow: { ...execution, current_write_eligible: false, provider: 'ezyvet' },
    });

    await expect(service.bookAppointment(bookingInput(), { callId: 'call_1' })).resolves.toEqual({
      outcome: 'booked',
    });

    expect(createBooking).not.toHaveBeenCalled();
    expect(reconcileBooking).not.toHaveBeenCalled();
    expect(forIntegration).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('complete_voice_booking_intent', {
      target_booking_intent_id: 'intent_1',
    });
  });

  it.each([
    'resource disabled after availability',
    'active provider switched after availability',
    'Google type-resource mapping removed after availability',
  ])('blocks a new write when %s', async () => {
    const createBooking = vi.fn();
    const { service } = serviceFor({
      claimState: 'claimed',
      connector: { createBooking } as unknown as BookingConnector,
      executionRow: { ...execution, current_write_eligible: false },
    });

    await expect(service.bookAppointment(bookingInput(), { callId: 'call_1' })).resolves.toEqual({
      outcome: 'unavailable',
    });
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('blocks a fresh ezyVet write after disconnect without creating or reconciling', async () => {
    const createBooking = vi.fn();
    const reconcileBooking = vi.fn();
    const { forIntegration, service } = serviceFor({
      claimState: 'claimed',
      connector: { createBooking, reconcileBooking } as unknown as BookingConnector,
      executionRow: { ...execution, current_write_eligible: false, provider: 'ezyvet' },
    });

    await expect(service.bookAppointment(bookingInput(), { callId: 'call_1' })).resolves.toEqual({
      outcome: 'unavailable',
    });

    expect(createBooking).not.toHaveBeenCalled();
    expect(reconcileBooking).not.toHaveBeenCalled();
    expect(forIntegration).not.toHaveBeenCalled();
  });

  it('blocks confirmation before execution when the database reports a changed provider policy', async () => {
    const createBooking = vi.fn();
    const { service } = serviceFor({
      claimState: 'configuration_changed',
      connector: { createBooking } as unknown as BookingConnector,
    });

    await expect(service.bookAppointment(bookingInput(), { callId: 'call_1' })).resolves.toEqual({
      outcome: 'unavailable',
    });
    expect(createBooking).not.toHaveBeenCalled();
  });

  it.each([
    ['timeout', new BookingProviderError('timeout')],
    ['network reset', new BookingProviderError('network')],
    ['ambiguous 500', new BookingProviderError('provider_state_unknown')],
    ['409 with an exact existing event', new BookingProviderError('provider_conflict')],
  ])('reconciles a Google %s without a second provider write', async (_label, failure) => {
    const createBooking = vi.fn().mockRejectedValue(failure);
    const reconcileBooking = vi.fn().mockResolvedValue({
      appointment: { appointmentKey: 'event_1', providerStatus: 'confirmed' },
      kind: 'found',
    });
    const getAvailability = vi.fn().mockResolvedValue([
      {
        appointmentTypeKey: 'type_1',
        endAt: execution.ends_at,
        providerDisplayName: 'Room One',
        resourceKey: 'calendar_1',
        startAt: execution.starts_at,
        timezone: 'UTC',
      },
    ]);
    const { service } = serviceFor({
      claimState: 'claimed',
      connector: {
        createBooking,
        getAvailability,
        reconcileBooking,
      } as unknown as BookingConnector,
    });

    await expect(service.bookAppointment(bookingInput(), { callId: 'call_1' })).resolves.toEqual({
      outcome: 'booked',
    });
    expect(createBooking).toHaveBeenCalledOnce();
    expect(reconcileBooking).toHaveBeenCalledOnce();
  });

  it('does not repost after a 409 whose deterministic event is cancelled or mismatched', async () => {
    const createBooking = vi.fn().mockRejectedValue(new BookingProviderError('provider_conflict'));
    const reconcileBooking = vi
      .fn()
      .mockRejectedValue(new BookingProviderError('provider_conflict'));
    const getAvailability = vi.fn().mockResolvedValue([
      {
        appointmentTypeKey: 'type_1',
        endAt: execution.ends_at,
        providerDisplayName: 'Room One',
        resourceKey: 'calendar_1',
        startAt: execution.starts_at,
        timezone: 'UTC',
      },
    ]);
    const { service } = serviceFor({
      claimState: 'claimed',
      connector: {
        createBooking,
        getAvailability,
        reconcileBooking,
      } as unknown as BookingConnector,
    });

    await expect(service.bookAppointment(bookingInput(), { callId: 'call_1' })).resolves.toEqual({
      outcome: 'unknown',
    });
    expect(createBooking).toHaveBeenCalledOnce();
    expect(reconcileBooking).toHaveBeenCalledOnce();
  });

  it('does not reopen a completed intent when the active provider has since changed', async () => {
    const createBooking = vi.fn();
    const { service } = serviceFor({
      claimState: 'completed',
      connector: { createBooking } as unknown as BookingConnector,
    });

    await expect(service.bookAppointment(bookingInput(), { callId: 'call_1' })).resolves.toEqual({
      outcome: 'booked',
    });
    expect(createBooking).not.toHaveBeenCalled();
  });
});
