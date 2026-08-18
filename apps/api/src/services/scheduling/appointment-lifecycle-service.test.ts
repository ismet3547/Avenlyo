import { describe, expect, it, vi } from 'vitest';

import type { BookingConnector } from '@avenlyo/integrations';

import { AppointmentLifecycleService } from './appointment-lifecycle-service.js';

const execution = {
  appointment_type_name: 'Wellness',
  appointment_type_uid: 'wellness',
  booking_intent_id: 'booking-1',
  business_hours: {},
  current_write_eligible: true,
  default_duration_minutes: 30,
  external_appointment_id: 'provider-appointment-1',
  integration_id: 'integration-1',
  minimum_lead_minutes: 30,
  operation: 'cancel',
  original_ends_at: '2026-09-01T10:30:00.000Z',
  original_resource_name: 'Dr Ray',
  original_resource_uid: 'resource-1',
  original_starts_at: '2026-09-01T10:00:00.000Z',
  provider: 'ezyvet',
  provider_mutation_target_id: null,
  timezone: 'UTC',
} as const;

function serviceFor(result: 'ambiguous' | 'cancelled') {
  const rpc = vi.fn((name: string) => {
    if (name === 'claim_appointment_change_intent') return { data: [{ state: 'claimed' }], error: null };
    if (name === 'get_appointment_change_execution_context_v2') return { data: [execution], error: null };
    return { data: [], error: null };
  });
  const connector = {
    appointmentLifecycle: { canCancel: true, canReschedule: true },
    cancelAppointment: vi.fn().mockResolvedValue({ kind: result, appointmentKey: 'provider-appointment-1' }),
    resolveAppointmentMutationTarget: vi.fn().mockResolvedValue({ kind: 'resolved', targetId: '123' }),
  } as unknown as BookingConnector;
  const connectors = { forIntegration: vi.fn().mockResolvedValue(connector) };
  return {
    connector,
    rpc,
    service: new AppointmentLifecycleService({ connectors: connectors as never, supabase: { rpc } as never }),
  };
}

describe('AppointmentLifecycleService provider confirmation', () => {
  it('never records provider success when a cancellation result is ambiguous', async () => {
    const { rpc, service } = serviceFor('ambiguous');
    await expect(service.execute({ changeIntentId: 'change-1', toolCallId: 'tool-1' }, { conversationId: 'conversation-1', triggeringInboundMessageId: 'message-1' })).resolves.toEqual({ outcome: 'unknown' });
    expect(rpc).toHaveBeenCalledWith('persist_appointment_change_mutation_target', expect.any(Object));
    expect(rpc).toHaveBeenCalledWith('fail_appointment_change_intent', expect.objectContaining({ target_error_category: 'provider_result_ambiguous', target_status: 'provider_state_unknown' }));
    expect(rpc).not.toHaveBeenCalledWith('record_appointment_change_provider_success', expect.any(Object));
  });

  it('records and completes only an exact cancelled provider result', async () => {
    const { rpc, service } = serviceFor('cancelled');
    await expect(service.execute({ changeIntentId: 'change-1', toolCallId: 'tool-1' }, { conversationId: 'conversation-1', triggeringInboundMessageId: 'message-1' })).resolves.toEqual({ outcome: 'completed' });
    expect(rpc).toHaveBeenCalledWith('record_appointment_change_provider_success', expect.objectContaining({ target_provider_state: 'confirmed' }));
    expect(rpc).toHaveBeenCalledWith('complete_appointment_change_intent', expect.any(Object));
  });
});
