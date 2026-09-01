import { describe, expect, it, vi } from 'vitest';

import { veterinaryPack } from '@avenlyo/industries';
import {
  FakeRealtimeCallControlProvider,
  FakeRealtimeSocket,
  VoiceSessionManager,
  type VoiceSchedulingServices,
} from '@avenlyo/voice';

import { VoiceSidebandRuntime } from './sideband-runtime.js';
import type { CustomerSchedulingCapabilities } from '../scheduling/customer-scheduling-capabilities.js';
import type { VoiceStore } from './store.js';

function testStore() {
  const finalizeCall = vi.fn().mockResolvedValue(undefined);
  const recordToolExecution = vi.fn().mockResolvedValue(undefined);
  const recordTranscript = vi.fn().mockResolvedValue('00000000-0000-4000-8000-000000000099');
  const requestHandoff = vi.fn().mockResolvedValue(true);
  const searchKnowledge = vi
    .fn()
    .mockResolvedValue([
      { content: 'We open at nine.', similarity: 0.93, sourceUrl: null, title: 'Hours' },
    ]);
  return {
    finalizeCall,
    recordToolExecution,
    recordTranscript,
    requestHandoff,
    searchKnowledge,
    store: {
      bootstrapIncomingCall: vi.fn(),
      finalizeCall,
      markCallActive: vi.fn(),
      recordToolExecution,
      recordTranscript,
      requestHandoff,
      searchKnowledge,
    } satisfies VoiceStore,
  };
}

function runtimeFor(input?: {
  readonly callId?: string;
  readonly configuration?: {
    readonly providerTransferEnabled: boolean;
    readonly transferEnabled: boolean;
    readonly transferTargetE164: string | null;
  };
  readonly scheduling?: VoiceSchedulingServices;
  readonly schedulingCapabilities?: CustomerSchedulingCapabilities;
}) {
  const callId = input?.callId ?? 'rtc_test';
  const control = new FakeRealtimeCallControlProvider();
  const socket = new FakeRealtimeSocket();
  const storeFixture = testStore();
  const sessions = new VoiceSessionManager({
    control,
    finalizer: {
      finalize: async ({ callId: finalizedCallId, endReason, status }) => {
        await storeFixture.store.finalizeCall({
          externalCallId: finalizedCallId,
          endReason,
          status,
        });
      },
    },
  });
  sessions.start(callId, socket);
  const runtime = new VoiceSidebandRuntime({
    configuration: {
      enabled: true,
      providerTransferEnabled: input?.configuration?.providerTransferEnabled ?? false,
      transferEnabled: input?.configuration?.transferEnabled ?? false,
      transferTargetE164: input?.configuration?.transferTargetE164 ?? null,
      voice: 'marin',
    },
    context: {
      callId,
      contactId: null,
      conversationId: '00000000-0000-0000-0000-000000000010',
      industry: veterinaryPack,
      locationId: '00000000-0000-0000-0000-000000000011',
      organizationId: '00000000-0000-0000-0000-000000000012',
      phoneNumberId: '00000000-0000-0000-0000-000000000013',
    },
    control,
    embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    ...(input?.scheduling ? { scheduling: input.scheduling } : {}),
    ...(input?.schedulingCapabilities
      ? { schedulingCapabilities: input.schedulingCapabilities }
      : {}),
    sessions,
    socket,
    store: storeFixture.store,
  });
  runtime.attach();
  return { control, runtime, sessions, socket, ...storeFixture };
}

async function flushQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function sentOfType(socket: FakeRealtimeSocket, type: string) {
  return socket.sent.filter((event) => event.type === type);
}

describe('voice sideband runtime', () => {
  it('persists final transcripts only and uses a sequential, idempotent normal tool loop', async () => {
    const { socket, recordToolExecution, recordTranscript, requestHandoff, searchKnowledge } =
      runtimeFor({ callId: 'rtc_normal' });

    socket.emitMessage({
      event_id: 'evt_partial',
      item_id: 'item_partial',
      transcript: 'partial words',
      type: 'response.output_audio_transcript.delta',
    });
    socket.emitMessage({
      event_id: 'evt_caller',
      item_id: 'item_caller',
      transcript: 'What time do you open?',
      type: 'conversation.item.input_audio_transcription.completed',
    });
    socket.emitMessage({
      event_id: 'evt_assistant',
      item_id: 'item_assistant',
      response_id: 'response_normal',
      transcript: 'We open at nine.',
      type: 'response.output_audio_transcript.done',
    });
    const knowledgeCall = {
      arguments: '{"query":"What are your hours?"}',
      call_id: 'function_1',
      event_id: 'evt_function',
      name: 'search_business_knowledge',
      type: 'response.function_call_arguments.done' as const,
    };
    socket.emitMessage(knowledgeCall);
    socket.emitMessage({ ...knowledgeCall, event_id: 'evt_function_replay' });
    await flushQueue();

    expect(recordTranscript).toHaveBeenCalledTimes(2);
    expect(requestHandoff).not.toHaveBeenCalled();
    expect(searchKnowledge).toHaveBeenCalledOnce();
    expect(recordToolExecution).toHaveBeenCalledOnce();
    expect(sentOfType(socket, 'conversation.item.create')).toHaveLength(1);
    expect(sentOfType(socket, 'response.create')).toHaveLength(1);
    expect(sentOfType(socket, 'session.update')).toHaveLength(0);
  });

  it('terminalizes a durable safety handoff, persists only its controlled acknowledgement, then hangs up after audio drains', async () => {
    const {
      control,
      finalizeCall,
      recordTranscript,
      requestHandoff,
      searchKnowledge,
      sessions,
      socket,
    } = runtimeFor({ callId: 'rtc_safety' });

    socket.emitMessage({
      event_id: 'evt_caller',
      item_id: 'item_caller',
      transcript: 'My dog ate chocolate and is shaking.',
      type: 'conversation.item.input_audio_transcription.completed',
    });
    await flushQueue();

    expect(requestHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'safety:item_caller', urgency: 'urgent' }),
    );
    expect(sentOfType(socket, 'session.update')).toEqual([
      {
        session: { audio: { input: { turn_detection: null } }, tools: [], type: 'realtime' },
        type: 'session.update',
      },
    ]);
    expect(sentOfType(socket, 'response.cancel')).toHaveLength(1);
    expect(sentOfType(socket, 'output_audio_buffer.clear')).toHaveLength(1);
    const acknowledgement = sentOfType(socket, 'response.create')[0];
    expect(acknowledgement).toMatchObject({
      response: { metadata: { avenlyo_control: 'handoff_ack' }, tools: [] },
      type: 'response.create',
    });
    expect(JSON.stringify(acknowledgement)).toContain("I've notified the team");

    // A late tool call and a canceled model transcript cannot resume normal AI ownership or become
    // customer-visible durable history after the handoff terminal boundary has started.
    socket.emitMessage({
      arguments: '{"query":"hours"}',
      call_id: 'late_tool',
      event_id: 'evt_late_tool',
      name: 'search_business_knowledge',
      type: 'response.function_call_arguments.done',
    });
    socket.emitMessage({
      event_id: 'evt_canceled_transcript',
      item_id: 'item_canceled_transcript',
      response_id: 'response_canceled',
      transcript: 'A canceled answer that the caller should not hear.',
      type: 'response.output_audio_transcript.done',
    });
    socket.emitMessage({
      event_id: 'evt_ack_created',
      response: {
        id: 'response_handoff_ack',
        metadata: { avenlyo_control: 'handoff_ack' },
      },
      type: 'response.created',
    });
    socket.emitMessage({
      event_id: 'evt_ack_transcript',
      item_id: 'item_ack_transcript',
      response_id: 'response_handoff_ack',
      transcript: "I've notified the team. I'll stop here so a person can follow up.",
      type: 'response.output_audio_transcript.done',
    });
    socket.emitMessage({
      event_id: 'evt_ack_stopped',
      response_id: 'response_handoff_ack',
      type: 'output_audio_buffer.stopped',
    });
    await flushQueue();

    expect(searchKnowledge).not.toHaveBeenCalled();
    expect(recordTranscript).toHaveBeenCalledTimes(2);
    expect(recordTranscript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: "I've notified the team. I'll stop here so a person can follow up.",
        direction: 'outbound',
      }),
    );
    expect(control.hungUp).toEqual(['rtc_safety']);
    expect(finalizeCall).toHaveBeenCalledWith({
      externalCallId: 'rtc_safety',
      endReason: 'handoff',
      status: 'completed',
    });
    expect(sessions.has('rtc_safety')).toBe(false);
  });

  it('never claims staff was notified when a deterministic handoff cannot be persisted', async () => {
    const fixture = runtimeFor({ callId: 'rtc_handoff_failure' });
    fixture.requestHandoff.mockResolvedValue(false);

    fixture.socket.emitMessage({
      event_id: 'evt_caller_failure',
      item_id: 'item_caller_failure',
      transcript: 'My dog ate chocolate and is shaking.',
      type: 'conversation.item.input_audio_transcription.completed',
    });
    await flushQueue();

    const acknowledgement = sentOfType(fixture.socket, 'response.create')[0];
    expect(JSON.stringify(acknowledgement)).toContain("couldn't notify the team automatically");
    expect(JSON.stringify(acknowledgement)).not.toContain("I've notified the team");
    expect(sentOfType(fixture.socket, 'session.update')).toHaveLength(1);
  });

  it('terminalizes one durable human-help tool request and suppresses its replay', async () => {
    const { socket, recordToolExecution, requestHandoff } = runtimeFor({ callId: 'rtc_human_help' });
    const humanHelp = {
      arguments: '{"reason":"Please connect me with a person.","urgency":"normal"}',
      call_id: 'function_handoff',
      event_id: 'evt_handoff',
      name: 'request_human_help',
      type: 'response.function_call_arguments.done' as const,
    };

    socket.emitMessage(humanHelp);
    socket.emitMessage({ ...humanHelp, event_id: 'evt_handoff_replay' });
    await flushQueue();

    expect(requestHandoff).toHaveBeenCalledOnce();
    expect(recordToolExecution).toHaveBeenCalledOnce();
    expect(sentOfType(socket, 'conversation.item.create')).toHaveLength(1);
    expect(sentOfType(socket, 'session.update')).toHaveLength(1);
    expect(sentOfType(socket, 'response.create')).toHaveLength(1);
  });

  it('keeps successful live transfer separate from terminal post-call handoff', async () => {
    const { control, finalizeCall, requestHandoff, socket } = runtimeFor({
      callId: 'rtc_transfer_success',
      configuration: {
        providerTransferEnabled: true,
        transferEnabled: true,
        transferTargetE164: '+14155550124',
      },
    });
    const transfer = {
      arguments: '{"reason":"Please transfer me to a person."}',
      call_id: 'function_transfer',
      event_id: 'evt_transfer',
      name: 'transfer_call',
      type: 'response.function_call_arguments.done' as const,
    };

    socket.emitMessage(transfer);
    socket.emitMessage({ ...transfer, event_id: 'evt_transfer_replay' });
    await flushQueue();

    expect(control.referred).toEqual([
      { callId: 'rtc_transfer_success', target: '+14155550124' },
    ]);
    expect(control.hungUp).toEqual([]);
    expect(requestHandoff).toHaveBeenCalledOnce();
    expect(finalizeCall).toHaveBeenCalledWith({
      externalCallId: 'rtc_transfer_success',
      endReason: 'transfer',
      status: 'transferred',
    });
    expect(sentOfType(socket, 'session.update')).toHaveLength(0);
    expect(sentOfType(socket, 'response.create')).toHaveLength(0);
  });

  it('turns a failed live transfer into a truthful durable post-call handoff instead of claiming transfer', async () => {
    const fixture = runtimeFor({
      callId: 'rtc_transfer_failure',
      configuration: {
        providerTransferEnabled: true,
        transferEnabled: true,
        transferTargetE164: '+14155550124',
      },
    });
    vi.spyOn(fixture.control, 'referCall').mockRejectedValue(new Error('refer unavailable'));

    fixture.socket.emitMessage({
      arguments: '{"reason":"Please transfer me to a person."}',
      call_id: 'function_transfer_failed',
      event_id: 'evt_transfer_failed',
      name: 'transfer_call',
      type: 'response.function_call_arguments.done',
    });
    await flushQueue();

    expect(fixture.requestHandoff).toHaveBeenCalledTimes(2);
    expect(sentOfType(fixture.socket, 'session.update')).toHaveLength(1);
    const acknowledgement = sentOfType(fixture.socket, 'response.create')[0];
    expect(JSON.stringify(acknowledgement)).toContain("I've notified the team");
    expect(JSON.stringify(acknowledgement)).not.toContain('transferred');
  });

  it('terminalizes provider-unknown booking only after durable mutation review work exists', async () => {
    const bookingIntentId = '00000000-0000-4000-8000-000000000501';
    const prepareAppointmentBooking = vi.fn().mockResolvedValue({
      intent: {
        bookingIntentId,
        startsAt: '2026-09-02T10:00:00.000Z',
        status: 'awaiting_confirmation',
        timezone: 'UTC',
        typeName: 'Wellness',
      },
      outcome: 'ready' as const,
    });
    const bookAppointment = vi.fn().mockResolvedValue({ outcome: 'unknown' as const });
    const scheduling: VoiceSchedulingServices = {
      bookAppointment,
      getAvailableAppointments: vi.fn().mockResolvedValue([]),
      isEnabledForCall: vi.fn().mockResolvedValue(true),
      prepareAppointmentBooking,
    };
    const fixture = runtimeFor({
      callId: 'rtc_booking_unknown',
      scheduling,
      schedulingCapabilities: { booking: true, cancel: false, lookup: false, reschedule: false },
    });

    fixture.socket.emitMessage({
      arguments:
        '{"candidate_id":"00000000-0000-4000-8000-000000000502","subject_name":"Bella"}',
      call_id: 'prepare_booking',
      event_id: 'evt_prepare_booking',
      name: 'prepare_appointment_booking',
      type: 'response.function_call_arguments.done',
    });
    fixture.socket.emitMessage({
      arguments: '{}',
      call_id: 'commit_booking',
      event_id: 'evt_commit_booking',
      name: 'book_appointment',
      type: 'response.function_call_arguments.done',
    });
    await flushQueue();

    expect(prepareAppointmentBooking).toHaveBeenCalledOnce();
    expect(bookAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ bookingIntentId }),
      expect.anything(),
    );
    expect(fixture.requestHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('appointment action requires human review'),
      }),
    );
    expect(sentOfType(fixture.socket, 'session.update')).toHaveLength(1);
    const terminalAcknowledgements = sentOfType(fixture.socket, 'response.create').filter((event) =>
      JSON.stringify(event).includes('handoff_ack'),
    );
    expect(terminalAcknowledgements).toHaveLength(1);
    expect(JSON.stringify(terminalAcknowledgements[0])).toContain("won't repeat it");
  });
});
