import { describe, expect, it, vi } from 'vitest';

import { veterinaryPack } from '@avenlyo/industries';
import {
  FakeRealtimeCallControlProvider,
  FakeRealtimeSocket,
  VoiceSessionManager,
  type VoiceSchedulingServices,
} from '@avenlyo/voice';

import { VoiceSidebandRuntime } from './sideband-runtime.js';
import type { VoiceStore } from './store.js';

async function flushQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function fixture(handoffPersisted: boolean) {
  const control = new FakeRealtimeCallControlProvider();
  const socket = new FakeRealtimeSocket();
  let transcriptSequence = 0;
  const requestHandoff = vi.fn().mockResolvedValue(handoffPersisted);
  const recordToolExecution = vi.fn().mockResolvedValue(undefined);
  const recordTranscript = vi.fn().mockImplementation(() => {
    transcriptSequence += 1;
    return Promise.resolve(`transcript-${transcriptSequence}`);
  });
  const store = {
    bootstrapIncomingCall: vi.fn(),
    finalizeCall: vi.fn().mockResolvedValue(undefined),
    markCallActive: vi.fn().mockResolvedValue(undefined),
    recordToolExecution,
    recordTranscript,
    requestHandoff,
    searchKnowledge: vi.fn().mockResolvedValue([]),
  } satisfies VoiceStore;
  const getAvailableAppointments = vi.fn().mockResolvedValue([]);
  const bookAppointment = vi.fn().mockResolvedValue({ outcome: 'unknown' as const });
  const scheduling: VoiceSchedulingServices = {
    bookAppointment,
    getAvailableAppointments,
    isEnabledForCall: vi.fn().mockResolvedValue(true),
    prepareAppointmentBooking: vi.fn().mockResolvedValue({
      intent: {
        bookingIntentId: '00000000-0000-4000-8000-000000000501',
        startsAt: '2026-09-02T10:00:00.000Z',
        status: 'awaiting_confirmation',
        timezone: 'UTC',
        typeName: 'Wellness',
      },
      outcome: 'ready' as const,
    }),
  };
  const sessions = new VoiceSessionManager({
    control,
    finalizer: {
      finalize: async ({ callId, endReason, status }) => {
        await store.finalizeCall({ externalCallId: callId, endReason, status });
      },
    },
  });
  sessions.start('rtc_phase23_mutation', socket);
  const runtime = new VoiceSidebandRuntime({
    configuration: {
      enabled: true,
      providerTransferEnabled: false,
      transferEnabled: false,
      transferTargetE164: null,
      voice: 'marin',
    },
    context: {
      callId: 'rtc_phase23_mutation',
      contactId: null,
      conversationId: '00000000-0000-0000-0000-000000000010',
      industry: veterinaryPack,
      locationId: '00000000-0000-0000-0000-000000000011',
      organizationId: '00000000-0000-0000-0000-000000000012',
      phoneNumberId: '00000000-0000-0000-0000-000000000013',
    },
    control,
    embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    scheduling,
    schedulingCapabilities: { booking: true, cancel: true, lookup: true, reschedule: true },
    sessions,
    socket,
    store,
  });
  runtime.attach();
  return {
    bookAppointment,
    getAvailableAppointments,
    recordToolExecution,
    requestHandoff,
    runtime,
    socket,
  };
}

async function reachUnknownBooking(socket: FakeRealtimeSocket): Promise<void> {
  socket.emitMessage({
    event_id: 'evt_offer_request',
    item_id: 'item_offer_request',
    transcript: 'I want the wellness appointment.',
    type: 'conversation.item.input_audio_transcription.completed',
  });
  socket.emitMessage({
    arguments: '{"candidate_id":"00000000-0000-4000-8000-000000000401","subject_name":"Bella"}',
    call_id: 'prepare_booking_phase23',
    event_id: 'evt_prepare_booking',
    name: 'prepare_appointment_booking',
    type: 'response.function_call_arguments.done',
  });
  await flushQueue();

  socket.emitMessage({
    event_id: 'evt_booking_confirmation',
    item_id: 'item_booking_confirmation',
    transcript: 'Yes, book it.',
    type: 'conversation.item.input_audio_transcription.completed',
  });
  socket.emitMessage({
    arguments: '{}',
    call_id: 'execute_booking_phase23',
    event_id: 'evt_execute_booking',
    name: 'book_appointment',
    type: 'response.function_call_arguments.done',
  });
  await flushQueue();
}

describe('Phase 23 voice mutation handoff boundary', () => {
  it('creates durable human work for an unknown provider outcome and closes scheduling for the live call', async () => {
    const { bookAppointment, getAvailableAppointments, requestHandoff, socket } = fixture(true);

    await reachUnknownBooking(socket);

    expect(bookAppointment).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingIntentId: '00000000-0000-4000-8000-000000000501',
        confirmationText: 'Yes, book it.',
        toolCallId: 'execute_booking_phase23',
      }),
      expect.objectContaining({ callId: 'rtc_phase23_mutation' }),
    );
    expect(requestHandoff).toHaveBeenCalledOnce();
    expect(requestHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        externalCallId: 'rtc_phase23_mutation',
        reason: 'An appointment action requires human review before automated handling can continue.',
        toolCallId: expect.stringMatching(/^mutation-review-[0-9a-f]{48}$/),
        urgency: 'normal',
      }),
    );
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          audio: { input: { turn_detection: null } },
          tools: [],
        }),
        type: 'session.update',
      }),
    );
    expect(
      socket.sent.some(
        (event) =>
          event.type === 'response.create' &&
          JSON.stringify(event).includes('handoff_ack') &&
          JSON.stringify(event).includes("won't repeat it"),
      ),
    ).toBe(true);

    socket.emitMessage({
      arguments: '{"appointment_type":"Wellness","dates":["2026-09-03"]}',
      call_id: 'slots_after_unknown',
      event_id: 'evt_slots_after_unknown',
      name: 'get_available_appointments',
      type: 'response.function_call_arguments.done',
    });
    await flushQueue();

    expect(getAvailableAppointments).not.toHaveBeenCalled();
    const lateFunctionOutput = socket.sent.find(
      (event) =>
        event.type === 'conversation.item.create' &&
        (event.item as { call_id?: string } | undefined)?.call_id === 'slots_after_unknown',
    );
    expect(lateFunctionOutput).toBeUndefined();
  });

  it('still closes scheduling and tells the model not to retry when durable handoff persistence is unavailable', async () => {
    const { getAvailableAppointments, requestHandoff, socket } = fixture(false);

    await reachUnknownBooking(socket);

    expect(requestHandoff).toHaveBeenCalledOnce();
    const unknownOutput = socket.sent.find(
      (event) =>
        event.type === 'conversation.item.create' &&
        (event.item as { call_id?: string } | undefined)?.call_id === 'execute_booking_phase23',
    );
    expect(JSON.stringify(unknownOutput)).toContain('could not be notified automatically');
    expect(JSON.stringify(unknownOutput)).toContain('Do not retry this appointment action');

    socket.emitMessage({
      arguments: '{"appointment_type":"Wellness","dates":["2026-09-03"]}',
      call_id: 'slots_after_failed_handoff',
      event_id: 'evt_slots_after_failed_handoff',
      name: 'get_available_appointments',
      type: 'response.function_call_arguments.done',
    });
    await flushQueue();
    expect(getAvailableAppointments).not.toHaveBeenCalled();
  });
});
