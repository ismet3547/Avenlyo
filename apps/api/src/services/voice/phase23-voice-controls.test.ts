import { medspaPack, veterinaryPack, type IndustryPack } from '@avenlyo/industries';
import {
  activeVoiceTools,
  FakeRealtimeCallControlProvider,
  FakeRealtimeSocket,
  VoiceSessionManager,
  type VoiceSchedulingServices,
} from '@avenlyo/voice';
import { describe, expect, it, vi } from 'vitest';

import { VoiceSidebandRuntime } from './sideband-runtime.js';
import type { VoiceStore } from './store.js';
import { customerVisibleVoiceTools, VoiceToolAuthorityState } from './tool-authority.js';

const capabilities = {
  booking: true,
  cancel: false,
  lookup: true,
  reschedule: false,
} as const;

function testStore() {
  const recordToolExecution = vi.fn().mockResolvedValue(undefined);
  const recordTranscript = vi
    .fn()
    .mockImplementation(async ({ externalItemId }: { readonly externalItemId: string }) =>
      externalItemId === 'item_missing' ? null : '00000000-0000-4000-8000-000000000014',
    );
  const requestHandoff = vi.fn().mockResolvedValue(true);
  return {
    recordToolExecution,
    requestHandoff,
    store: {
      bootstrapIncomingCall: vi.fn(),
      finalizeCall: vi.fn().mockResolvedValue(undefined),
      markCallActive: vi.fn().mockResolvedValue(undefined),
      recordToolExecution,
      recordTranscript,
      requestHandoff,
      searchKnowledge: vi.fn().mockResolvedValue([]),
    } satisfies VoiceStore,
  };
}

function context(industry: IndustryPack, callId: string) {
  return {
    callId,
    contactId: null,
    conversationId: '00000000-0000-4000-8000-000000000010',
    industry,
    locationId: '00000000-0000-4000-8000-000000000011',
    organizationId: '00000000-0000-4000-8000-000000000012',
    phoneNumberId: '00000000-0000-4000-8000-000000000013',
  } as const;
}

function runtime(
  industry: IndustryPack,
  callId: string,
  store: VoiceStore,
  input: {
    readonly scheduling?: VoiceSchedulingServices;
    readonly schedulingCapabilities?: typeof capabilities;
  } = {},
) {
  const control = new FakeRealtimeCallControlProvider();
  const socket = new FakeRealtimeSocket();
  const sessions = new VoiceSessionManager({
    control,
    finalizer: { finalize: vi.fn().mockResolvedValue(undefined) },
  });
  sessions.start(callId, socket);
  const instance = new VoiceSidebandRuntime({
    configuration: {
      enabled: true,
      providerTransferEnabled: false,
      transferEnabled: false,
      transferTargetE164: null,
      voice: 'marin',
    },
    context: context(industry, callId),
    control,
    embed: vi.fn().mockResolvedValue([0.1]),
    sessions,
    socket,
    store,
    ...input,
  });
  instance.attach();
  return { socket };
}

async function flushQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Phase 23 voice controls', () => {
  it('hides unsupported lifecycle tools and rejects a stale forged call before scheduling services', async () => {
    const visibleNames = customerVisibleVoiceTools(
      activeVoiceTools({
        industry: veterinaryPack,
        schedulingEnabled: true,
        transferEnabled: false,
      }),
      capabilities,
    ).map(({ name }) => name);

    expect(visibleNames).toContain('get_available_appointments');
    expect(visibleNames).toContain('book_appointment');
    expect(visibleNames).toContain('get_upcoming_appointments');
    expect(visibleNames).not.toContain('get_reschedule_options');
    expect(visibleNames).not.toContain('prepare_appointment_reschedule');
    expect(visibleNames).not.toContain('reschedule_appointment');
    expect(visibleNames).not.toContain('prepare_appointment_cancellation');
    expect(visibleNames).not.toContain('cancel_appointment');

    const authority = new VoiceToolAuthorityState(capabilities);
    expect(authority.allows('cancel_appointment')).toBe(false);
    expect(authority.allows('reschedule_appointment')).toBe(false);

    const executeAppointmentChange = vi.fn().mockResolvedValue({ outcome: 'completed' });
    const scheduling: VoiceSchedulingServices = {
      bookAppointment: vi.fn().mockResolvedValue({ outcome: 'unavailable' }),
      executeAppointmentChange,
      getAvailableAppointments: vi.fn().mockResolvedValue([]),
      isEnabledForCall: vi.fn().mockResolvedValue(true),
      prepareAppointmentBooking: vi.fn().mockResolvedValue({ intent: null, outcome: 'not_found' }),
    };
    const { store, recordToolExecution } = testStore();
    const { socket } = runtime(veterinaryPack, 'rtc_capability', store, {
      scheduling,
      schedulingCapabilities: capabilities,
    });

    socket.emitMessage({
      arguments: '{"change_intent_id":"11111111-1111-4111-8111-111111111111"}',
      call_id: 'forged_cancel',
      event_id: 'evt_forged_cancel',
      name: 'cancel_appointment',
      type: 'response.function_call_arguments.done',
    });
    await flushQueue();

    expect(executeAppointmentChange).not.toHaveBeenCalled();
    expect(recordToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', toolCallId: 'forged_cancel' }),
    );
    expect(
      socket.sent.find((event) => event.type === 'conversation.item.create'),
    ).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ output: expect.stringContaining('unavailable') }),
      }),
    );
  });

  it('opens deterministic human handoff from the trusted final transcript without a model tool call', async () => {
    const { store, requestHandoff } = testStore();
    const { socket } = runtime(veterinaryPack, 'rtc_human', store);

    socket.emitMessage({
      event_id: 'evt_human',
      item_id: 'item_human',
      transcript: 'I want to speak with a person.',
      type: 'conversation.item.input_audio_transcription.completed',
    });
    await flushQueue();

    expect(requestHandoff).toHaveBeenCalledOnce();
    expect(requestHandoff).toHaveBeenCalledWith({
      externalCallId: 'rtc_human',
      reason: 'Customer explicitly requested human assistance.',
      toolCallId: 'human-request:item_human',
      urgency: 'normal',
    });
  });

  it('keeps safety identity separate from urgency for normal-urgency clinical escalation', async () => {
    const { store, requestHandoff } = testStore();
    const { socket } = runtime(medspaPack, 'rtc_medspa_safety', store);

    socket.emitMessage({
      event_id: 'evt_safety',
      item_id: 'item_safety',
      transcript: 'Is this treatment safe for me?',
      type: 'conversation.item.input_audio_transcription.completed',
    });
    await flushQueue();

    expect(requestHandoff).toHaveBeenCalledOnce();
    expect(requestHandoff).toHaveBeenCalledWith({
      externalCallId: 'rtc_medspa_safety',
      reason: 'Clinical eligibility or contraindication question.',
      toolCallId: 'safety:item_safety',
      urgency: 'normal',
    });
  });
});
