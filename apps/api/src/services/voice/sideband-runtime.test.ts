import { describe, expect, it, vi } from 'vitest';

import { veterinaryPack } from '@avenlyo/industries';
import {
  FakeRealtimeCallControlProvider,
  FakeRealtimeSocket,
  VoiceSessionManager,
} from '@avenlyo/voice';

import { VoiceSidebandRuntime } from './sideband-runtime.js';
import type { VoiceStore } from './store.js';

function testStore() {
  const finalizeCall = vi.fn().mockResolvedValue(undefined);
  const recordToolExecution = vi.fn().mockResolvedValue(undefined);
  const recordTranscript = vi.fn().mockResolvedValue(true);
  const requestHandoff = vi.fn().mockResolvedValue(true);
  const searchKnowledge = vi
    .fn()
    .mockResolvedValue([
      { content: 'We open at nine.', similarity: 0.93, sourceUrl: null, title: 'Hours' },
    ]);
  return {
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

async function flushQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('voice sideband runtime', () => {
  it('persists final transcripts only and uses a sequential, idempotent tool loop', async () => {
    const control = new FakeRealtimeCallControlProvider();
    const socket = new FakeRealtimeSocket();
    const { store, recordToolExecution, recordTranscript, requestHandoff, searchKnowledge } =
      testStore();
    const sessions = new VoiceSessionManager({
      control,
      finalizer: {
        finalize: async ({ callId, endReason, status }) => {
          await store.finalizeCall({ externalCallId: callId, endReason, status });
        },
      },
    });
    sessions.start('rtc_1', socket);
    const runtime = new VoiceSidebandRuntime({
      configuration: {
        enabled: true,
        providerTransferEnabled: false,
        transferEnabled: false,
        transferTargetE164: null,
        voice: 'marin',
      },
      context: {
        callId: 'rtc_1',
        contactId: null,
        conversationId: '00000000-0000-0000-0000-000000000010',
        industry: veterinaryPack,
        locationId: '00000000-0000-0000-0000-000000000011',
        organizationId: '00000000-0000-0000-0000-000000000012',
        phoneNumberId: '00000000-0000-0000-0000-000000000013',
      },
      control,
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
      sessions,
      socket,
      store,
    });
    runtime.attach();

    socket.emitMessage({
      event_id: 'evt_partial',
      item_id: 'item_partial',
      transcript: 'partial words',
      type: 'response.output_audio_transcript.delta',
    });
    socket.emitMessage({
      event_id: 'evt_caller',
      item_id: 'item_caller',
      transcript: 'My dog ate chocolate and is shaking.',
      type: 'conversation.item.input_audio_transcription.completed',
    });
    socket.emitMessage({
      event_id: 'evt_assistant',
      item_id: 'item_assistant',
      transcript: 'I am getting the clinic team to help.',
      type: 'response.output_audio_transcript.done',
    });
    socket.emitMessage({
      arguments: '{"query":"What are your hours?"}',
      call_id: 'function_1',
      event_id: 'evt_function',
      name: 'search_business_knowledge',
      type: 'response.function_call_arguments.done',
    });
    socket.emitMessage({
      arguments: '{"query":"What are your hours?"}',
      call_id: 'function_1',
      event_id: 'evt_function_replay',
      name: 'search_business_knowledge',
      type: 'response.function_call_arguments.done',
    });
    await flushQueue();

    expect(recordTranscript).toHaveBeenCalledTimes(2);
    expect(recordTranscript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ direction: 'inbound' }),
    );
    expect(recordTranscript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ direction: 'outbound' }),
    );
    expect(requestHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'safety:item_caller', urgency: 'urgent' }),
    );
    expect(searchKnowledge).toHaveBeenCalledOnce();
    expect(recordToolExecution).toHaveBeenCalledOnce();
    expect(socket.sent.filter((event) => event.type === 'conversation.item.create')).toHaveLength(
      1,
    );
    expect(socket.sent.filter((event) => event.type === 'response.create')).toHaveLength(1);
  });

  it('suppresses replayed human-help and transfer tool events', async () => {
    const control = new FakeRealtimeCallControlProvider();
    const socket = new FakeRealtimeSocket();
    const { store, recordToolExecution, requestHandoff } = testStore();
    const sessions = new VoiceSessionManager({
      control,
      finalizer: {
        finalize: async ({ callId, endReason, status }) => {
          await store.finalizeCall({ externalCallId: callId, endReason, status });
        },
      },
    });
    sessions.start('rtc_replays', socket);
    const runtime = new VoiceSidebandRuntime({
      configuration: {
        enabled: true,
        providerTransferEnabled: true,
        transferEnabled: true,
        transferTargetE164: '+14155550124',
        voice: 'marin',
      },
      context: {
        callId: 'rtc_replays',
        contactId: null,
        conversationId: '00000000-0000-0000-0000-000000000010',
        industry: veterinaryPack,
        locationId: '00000000-0000-0000-0000-000000000011',
        organizationId: '00000000-0000-0000-0000-000000000012',
        phoneNumberId: '00000000-0000-0000-0000-000000000013',
      },
      control,
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
      sessions,
      socket,
      store,
    });
    runtime.attach();

    const humanHelp = {
      arguments: '{"reason":"Please connect me with a person.","urgency":"normal"}',
      call_id: 'function_handoff',
      event_id: 'evt_handoff',
      name: 'request_human_help',
      type: 'response.function_call_arguments.done' as const,
    };
    socket.emitMessage(humanHelp);
    socket.emitMessage(humanHelp);
    await flushQueue();

    expect(requestHandoff).toHaveBeenCalledOnce();
    expect(recordToolExecution).toHaveBeenCalledOnce();
    expect(socket.sent.filter((item) => item.type === 'conversation.item.create')).toHaveLength(1);
    expect(socket.sent.filter((item) => item.type === 'response.create')).toHaveLength(1);

    const transfer = {
      arguments: '{"reason":"Please transfer me to a person."}',
      call_id: 'function_transfer',
      event_id: 'evt_transfer',
      name: 'transfer_call',
      type: 'response.function_call_arguments.done' as const,
    };
    socket.emitMessage(transfer);
    socket.emitMessage(transfer);
    await flushQueue();

    expect(control.referred).toEqual([{ callId: 'rtc_replays', target: '+14155550124' }]);
    expect(control.hungUp).toEqual([]);
    expect(requestHandoff).toHaveBeenCalledTimes(2);
    expect(recordToolExecution).toHaveBeenCalledTimes(2);
    expect(socket.sent.filter((item) => item.type === 'conversation.item.create')).toHaveLength(2);
    expect(socket.sent.filter((item) => item.type === 'response.create')).toHaveLength(1);
  });
});
