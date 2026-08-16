import { describe, expect, it, vi } from 'vitest';

import {
  FakeRealtimeCallControlProvider,
  FakeRealtimeSocket,
  VoiceSessionManager,
} from '@avenlyo/voice';

import { VoiceInboundCallService } from './inbound-service.js';
import type { VoiceInboundBootstrap, VoiceStore } from './store.js';

function bootstrap(): VoiceInboundBootstrap {
  return {
    accepted: true,
    businessHours: null,
    businessPhone: '+14155550123',
    callRecordId: '00000000-0000-0000-0000-000000000001',
    contactId: null,
    conversationId: '00000000-0000-0000-0000-000000000002',
    isDuplicate: false,
    locationAddress: null,
    locationId: '00000000-0000-0000-0000-000000000003',
    locationName: 'Downtown',
    locationTimezone: 'America/Los_Angeles',
    organizationId: '00000000-0000-0000-0000-000000000004',
    organizationName: 'Happy Pets',
    phoneNumberId: '00000000-0000-0000-0000-000000000005',
    primaryIndustryId: 'veterinary',
    providerTransferEnabled: true,
    transferEnabled: true,
    transferTargetE164: '+14155550124',
    voice: 'marin',
    websiteUrl: null,
  };
}

function storeWith(result: VoiceInboundBootstrap | null) {
  const bootstrapIncomingCall = vi.fn().mockResolvedValue(result);
  const finalizeCall = vi.fn().mockResolvedValue(undefined);
  const markCallActive = vi.fn().mockResolvedValue(undefined);
  return {
    bootstrapIncomingCall,
    markCallActive,
    store: {
      bootstrapIncomingCall,
      finalizeCall,
      markCallActive,
      recordToolExecution: vi.fn().mockResolvedValue(undefined),
      recordTranscript: vi.fn().mockResolvedValue(true),
      requestHandoff: vi.fn().mockResolvedValue(true),
      searchKnowledge: vi.fn().mockResolvedValue([]),
    } satisfies VoiceStore,
  };
}

const event = {
  created_at: 1,
  data: {
    call_id: 'rtc_inbound_1',
    sip_headers: [
      { name: 'To', value: '<sip:proj_123@sip.api.openai.com>' },
      { name: 'X-Organization-ID', value: 'forged' },
      { name: 'Diversion', value: '<sip:+14155550123@twilio.example>' },
      { name: 'From', value: '<sip:+14155550199@carrier.example>' },
    ],
  },
  id: 'evt_inbound_1',
  type: 'realtime.call.incoming' as const,
};

describe('inbound voice call service', () => {
  it('boots only the routed DID and accepts one sideband session', async () => {
    const control = new FakeRealtimeCallControlProvider();
    control.socket = new FakeRealtimeSocket();
    const { store, bootstrapIncomingCall, markCallActive } = storeWith(bootstrap());
    const sessions = new VoiceSessionManager({
      control,
      finalizer: {
        finalize: async ({ callId, endReason, status }) => {
          await store.finalizeCall({ externalCallId: callId, endReason, status });
        },
      },
    });
    const service = new VoiceInboundCallService({
      control,
      embed: vi.fn().mockResolvedValue([0.1]),
      model: 'gpt-realtime-2.1',
      sessions,
      store,
    });

    await expect(service.handleIncoming(event)).resolves.toBe('accepted');
    expect(bootstrapIncomingCall).toHaveBeenCalledWith({
      callerE164: '+14155550199',
      dialedE164: '+14155550123',
      eventId: 'evt_inbound_1',
      externalCallId: 'rtc_inbound_1',
      sipCallId: 'rtc_inbound_1',
    });
    expect(control.accepted).toHaveLength(1);
    expect(control.accepted[0]?.session.tools.map(({ name }) => name)).toContain('transfer_call');
    expect(markCallActive).toHaveBeenCalledWith('rtc_inbound_1');
  });

  it('rejects unknown or disabled routing and never accepts a generic agent', async () => {
    const control = new FakeRealtimeCallControlProvider();
    const { store } = storeWith(null);
    const sessions = new VoiceSessionManager({
      control,
      finalizer: {
        finalize: async ({ callId, endReason, status }) => {
          await store.finalizeCall({ externalCallId: callId, endReason, status });
        },
      },
    });
    const service = new VoiceInboundCallService({
      control,
      embed: vi.fn(),
      model: 'gpt-realtime-2.1',
      sessions,
      store,
    });

    await expect(service.handleIncoming(event)).resolves.toBe('rejected');
    expect(control.accepted).toEqual([]);
    expect(control.rejected).toEqual([{ callId: 'rtc_inbound_1', statusCode: 404 }]);
  });

  it('does not re-accept a provider call replay already owned by a sideband session', async () => {
    const control = new FakeRealtimeCallControlProvider();
    const duplicate = { ...bootstrap(), accepted: false, isDuplicate: true };
    const { store, bootstrapIncomingCall } = storeWith(duplicate);
    const sessions = new VoiceSessionManager({
      control,
      finalizer: { finalize: vi.fn().mockResolvedValue(undefined) },
    });
    const service = new VoiceInboundCallService({
      control,
      embed: vi.fn(),
      model: 'gpt-realtime-2.1',
      sessions,
      store,
    });

    await expect(service.handleIncoming(event)).resolves.toBe('duplicate');
    await expect(service.handleIncoming({ ...event, id: 'evt_inbound_replay' })).resolves.toBe(
      'duplicate',
    );

    expect(bootstrapIncomingCall).toHaveBeenCalledTimes(2);
    expect(control.accepted).toEqual([]);
    expect(control.rejected).toEqual([]);
    expect(sessions.has(event.data.call_id)).toBe(false);
  });
});
