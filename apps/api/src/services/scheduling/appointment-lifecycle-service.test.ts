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
  intent_status: 'executing',
  minimum_lead_minutes: 30,
  operation: 'cancel',
  original_ends_at: '2026-09-01T10:30:00.000Z',
  original_resource_name: 'Dr Ray',
  original_resource_uid: 'resource-1',
  original_starts_at: '2026-09-01T10:00:00.000Z',
  provider: 'ezyvet',
  provider_mutation_target_id: null,
  target_ends_at: '2026-09-01T11:30:00.000Z',
  target_starts_at: '2026-09-01T11:00:00.000Z',
  timezone: 'UTC',
} as const;

function serviceFor(result: 'ambiguous' | 'cancelled') {
  const rpc = vi.fn((name: string) => {
    if (name === 'claim_presented_appointment_change_intent')
      return { data: [{ state: 'claimed' }], error: null };
    if (name === 'get_appointment_change_execution_context_v2')
      return { data: [execution], error: null };
    return { data: [], error: null };
  });
  const connector = {
    appointmentLifecycle: { canCancel: true, canReschedule: true },
    cancelAppointment: vi
      .fn()
      .mockResolvedValue({ kind: result, appointmentKey: 'provider-appointment-1' }),
    resolveAppointmentMutationTarget: vi
      .fn()
      .mockResolvedValue({ kind: 'resolved', targetId: '123' }),
  } as unknown as BookingConnector;
  const connectors = { forIntegration: vi.fn().mockResolvedValue(connector) };
  return {
    connector,
    rpc,
    service: new AppointmentLifecycleService({
      connectors: connectors as never,
      supabase: { rpc } as never,
    }),
  };
}

type StaffOperation = 'cancel' | 'reschedule';
type StaffStatus =
  'completed' | 'executing' | 'provider_state_unknown' | 'provider_success_pending_persistence';
type ReconciliationResult = 'not_found' | 'succeeded';

function staffServiceFor(input: {
  readonly operation: StaffOperation;
  readonly provider?: 'ezyvet' | 'google_calendar';
  readonly status: StaffStatus;
  readonly targetId: string | null;
  readonly reconciliation?: ReconciliationResult;
  readonly canReschedule?: boolean;
}) {
  const row = {
    ...execution,
    intent_status: input.status,
    operation: input.operation,
    provider: input.provider ?? 'google_calendar',
    provider_mutation_target_id: input.targetId,
  };
  const rpc = vi.fn((name: string) => {
    if (name === 'get_appointment_change_execution_context_v2') return { data: [row], error: null };
    if (name === 'claim_appointment_change_slot_lease')
      return { data: [{ lease_id: 'lease-1' }], error: null };
    return { data: [], error: null };
  });
  const succeededKind = input.operation === 'cancel' ? 'cancelled' : 'rescheduled';
  const connector = {
    appointmentLifecycle: { canCancel: true, canReschedule: input.canReschedule ?? true },
    cancelAppointment: vi
      .fn()
      .mockResolvedValue({ appointmentKey: row.external_appointment_id, kind: 'cancelled' }),
    getAppointmentState: vi.fn().mockResolvedValue({
      appointmentKey: row.external_appointment_id,
      kind: input.reconciliation === 'not_found' ? 'not_found' : succeededKind,
    }),
    getAvailability: vi.fn().mockResolvedValue([
      {
        endAt: row.target_ends_at,
        resourceKey: row.original_resource_uid,
        startAt: row.target_starts_at,
      },
    ]),
    resolveAppointmentMutationTarget: vi
      .fn()
      .mockResolvedValue({ kind: 'resolved', targetId: 'provider-target-1' }),
    rescheduleAppointment: vi
      .fn()
      .mockResolvedValue({ appointmentKey: row.external_appointment_id, kind: 'rescheduled' }),
  };
  const connectors = { forIntegration: vi.fn().mockResolvedValue(connector) };
  return {
    connector,
    connectors,
    rpc,
    service: new AppointmentLifecycleService({
      connectors: connectors as never,
      supabase: { rpc } as never,
    }),
  };
}

function executeStaff(service: AppointmentLifecycleService, operation: StaffOperation) {
  return operation === 'cancel'
    ? service.executeStaffCancellation('change-1')
    : service.executeStaffReschedule('change-1');
}

function providerWriteCount(connector: ReturnType<typeof staffServiceFor>['connector']): number {
  return (
    connector.cancelAppointment.mock.calls.length +
    connector.rescheduleAppointment.mock.calls.length
  );
}

describe('AppointmentLifecycleService provider confirmation', () => {
  it('never records provider success when a cancellation result is ambiguous', async () => {
    const { rpc, service } = serviceFor('ambiguous');
    await expect(
      service.execute(
        { changeIntentId: 'change-1', toolCallId: 'tool-1' },
        { conversationId: 'conversation-1', triggeringInboundMessageId: 'message-1' },
      ),
    ).resolves.toEqual({ outcome: 'unknown' });
    expect(rpc).toHaveBeenCalledWith(
      'claim_presented_appointment_change_intent',
      expect.objectContaining({
        target_change_intent_id: 'change-1',
        target_conversation_id: 'conversation-1',
        target_inbound_message_id: 'message-1',
        target_tool_call_id: 'tool-1',
      }),
    );
    expect(rpc).not.toHaveBeenCalledWith('claim_appointment_change_intent', expect.any(Object));
    expect(rpc).toHaveBeenCalledWith(
      'persist_appointment_change_mutation_target',
      expect.any(Object),
    );
    expect(rpc).toHaveBeenCalledWith(
      'fail_appointment_change_intent',
      expect.objectContaining({
        target_error_category: 'provider_result_ambiguous',
        target_status: 'provider_state_unknown',
      }),
    );
    expect(rpc).not.toHaveBeenCalledWith(
      'record_appointment_change_provider_success',
      expect.any(Object),
    );
  });

  it('records and completes only an exact cancelled provider result', async () => {
    const { rpc, service } = serviceFor('cancelled');
    await expect(
      service.execute(
        { changeIntentId: 'change-1', toolCallId: 'tool-1' },
        { conversationId: 'conversation-1', triggeringInboundMessageId: 'message-1' },
      ),
    ).resolves.toEqual({ outcome: 'completed' });
    expect(rpc).toHaveBeenCalledWith(
      'record_appointment_change_provider_success',
      expect.objectContaining({ target_provider_state: 'confirmed' }),
    );
    expect(rpc).toHaveBeenCalledWith('complete_appointment_change_intent', expect.any(Object));
  });
});

describe('AppointmentLifecycleService staff recovery', () => {
  it.each<StaffOperation>(['cancel', 'reschedule'])(
    'permits exactly one fresh %s provider mutation before a mutation target exists',
    async (operation) => {
      const { connector, service } = staffServiceFor({
        operation,
        status: 'executing',
        targetId: null,
      });

      await expect(executeStaff(service, operation)).resolves.toEqual({ outcome: 'completed' });

      expect(providerWriteCount(connector)).toBe(1);
      expect(connector.getAppointmentState).not.toHaveBeenCalled();
      expect(connector.resolveAppointmentMutationTarget).toHaveBeenCalledOnce();
    },
  );

  it.each<StaffOperation>(['cancel', 'reschedule'])(
    'reconciles, but never rewrites, a persisted %s target after a pre-call crash',
    async (operation) => {
      const { connector, service } = staffServiceFor({
        operation,
        reconciliation: 'not_found',
        status: 'executing',
        targetId: 'provider-target-1',
      });

      await expect(executeStaff(service, operation)).resolves.toEqual({ outcome: 'unknown' });

      expect(providerWriteCount(connector)).toBe(0);
      expect(connector.getAppointmentState).toHaveBeenCalledOnce();
      expect(connector.resolveAppointmentMutationTarget).not.toHaveBeenCalled();
      expect(connector.getAvailability).not.toHaveBeenCalled();
    },
  );

  it.each<StaffOperation>(['cancel', 'reschedule'])(
    'reconciles a successful %s provider call after a crash before provider success is recorded',
    async (operation) => {
      const { connector, rpc, service } = staffServiceFor({
        operation,
        reconciliation: 'succeeded',
        status: 'executing',
        targetId: 'provider-target-1',
      });

      await expect(executeStaff(service, operation)).resolves.toEqual({ outcome: 'completed' });

      expect(providerWriteCount(connector)).toBe(0);
      expect(connector.getAppointmentState).toHaveBeenCalledOnce();
      expect(rpc).toHaveBeenCalledWith(
        'record_appointment_change_provider_success',
        expect.objectContaining({ target_provider_state: 'reconciled' }),
      );
    },
  );

  it.each<StaffOperation>(['cancel', 'reschedule'])(
    'locally completes a %s intent whose provider success is already durable',
    async (operation) => {
      const { connector, connectors, rpc, service } = staffServiceFor({
        operation,
        status: 'provider_success_pending_persistence',
        targetId: 'provider-target-1',
      });

      await expect(executeStaff(service, operation)).resolves.toEqual({ outcome: 'completed' });

      expect(providerWriteCount(connector)).toBe(0);
      expect(connector.getAppointmentState).not.toHaveBeenCalled();
      expect(connectors.forIntegration).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledWith('complete_appointment_change_intent', expect.any(Object));
    },
  );

  it.each<StaffOperation>(['cancel', 'reschedule'])(
    'uses reconciliation only for a %s intent in provider_state_unknown',
    async (operation) => {
      const { connector, service } = staffServiceFor({
        operation,
        reconciliation: 'succeeded',
        status: 'provider_state_unknown',
        targetId: 'provider-target-1',
      });

      await expect(executeStaff(service, operation)).resolves.toEqual({ outcome: 'completed' });

      expect(providerWriteCount(connector)).toBe(0);
      expect(connector.getAppointmentState).toHaveBeenCalledOnce();
      expect(connector.resolveAppointmentMutationTarget).not.toHaveBeenCalled();
    },
  );

  it.each<StaffOperation>(['cancel', 'reschedule'])(
    'returns a completed %s retry without opening a connector or issuing a second provider mutation',
    async (operation) => {
      const { connector, connectors, service } = staffServiceFor({
        operation,
        status: 'completed',
        targetId: 'provider-target-1',
      });

      await expect(executeStaff(service, operation)).resolves.toEqual({ outcome: 'completed' });

      expect(connectors.forIntegration).not.toHaveBeenCalled();
      expect(providerWriteCount(connector)).toBe(0);
    },
  );

  it('rejects an ezyVet staff reschedule without resolving or mutating a provider target', async () => {
    const { connector, service } = staffServiceFor({
      canReschedule: false,
      operation: 'reschedule',
      provider: 'ezyvet',
      status: 'executing',
      targetId: null,
    });

    await expect(service.executeStaffReschedule('change-1')).resolves.toEqual({
      outcome: 'handoff_required',
    });

    expect(providerWriteCount(connector)).toBe(0);
    expect(connector.resolveAppointmentMutationTarget).not.toHaveBeenCalled();
    expect(connector.getAvailability).not.toHaveBeenCalled();
  });
});
