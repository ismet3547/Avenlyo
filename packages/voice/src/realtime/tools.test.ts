import { describe, expect, it, vi } from 'vitest';

import { veterinaryPack } from '@avenlyo/industries';

import { activeVoiceTools, VoiceToolExecutor } from './tools';

const context = {
  callId: 'rtc_voice_1',
  contactId: null,
  conversationId: '00000000-0000-0000-0000-000000000010',
  industry: veterinaryPack,
  locationId: '00000000-0000-0000-0000-000000000011',
  organizationId: '00000000-0000-0000-0000-000000000012',
  phoneNumberId: '00000000-0000-0000-0000-000000000013',
} as const;

describe('voice tool boundary', () => {
  it('only exposes transfer when trusted configuration permits it', () => {
    expect(
      activeVoiceTools({ industry: veterinaryPack, transferEnabled: false }).map(
        ({ name }) => name,
      ),
    ).toEqual(['search_business_knowledge', 'request_human_help', 'capture_lead']);
    expect(
      activeVoiceTools({ industry: veterinaryPack, transferEnabled: true }).map(({ name }) => name),
    ).toContain('transfer_call');
    expect(
      activeVoiceTools({ industry: veterinaryPack, transferEnabled: true }).at(-1)?.parameters,
    ).not.toHaveProperty('transfer_target');
  });

  it('uses only the configured server transfer service and deduplicates provider call IDs', async () => {
    const transferCall = vi.fn().mockResolvedValue({ transferred: true });
    const executor = new VoiceToolExecutor(
      context,
      {
        requestHumanHelp: vi.fn().mockResolvedValue({ created: true }),
        searchBusinessKnowledge: vi.fn().mockResolvedValue([]),
        transferCall,
      },
      true,
    );
    const call = {
      arguments: '{"reason":"Caller requested a person."}',
      callId: 'fc_1',
      name: 'transfer_call',
    };

    await expect(executor.execute(call)).resolves.toMatchObject({
      status: 'succeeded',
      transferred: true,
    });
    await executor.execute(call);
    expect(transferCall).toHaveBeenCalledOnce();
    expect(transferCall).toHaveBeenCalledWith(
      { reason: 'Caller requested a person.', toolCallId: 'fc_1' },
      context,
    );
  });

  it('exposes veterinary scheduling only when trusted runtime configuration enables it and blocks it after safety escalation', async () => {
    const getAvailableAppointments = vi.fn().mockResolvedValue([
      {
        candidateId: '00000000-0000-4000-8000-000000000101',
        endsAt: '2026-09-01T10:30:00.000Z',
        expiresAt: '2026-09-01T09:10:00.000Z',
        resourceName: 'Dr Ray',
        startsAt: '2026-09-01T10:00:00.000Z',
        timezone: 'UTC',
        typeName: 'Wellness',
      },
    ]);
    expect(
      activeVoiceTools({
        industry: veterinaryPack,
        schedulingEnabled: true,
        transferEnabled: false,
      }).map(({ name }) => name),
    ).toContain('book_appointment');
    const executor = new VoiceToolExecutor(
      context,
      {
        requestHumanHelp: vi.fn().mockResolvedValue({ created: true }),
        scheduling: {
          bookAppointment: vi.fn().mockResolvedValue({ outcome: 'booked' }),
          getAvailableAppointments,
          isEnabledForCall: vi.fn().mockResolvedValue(true),
          prepareAppointmentBooking: vi
            .fn()
            .mockResolvedValue({ intent: null, outcome: 'not_found' }),
        },
        searchBusinessKnowledge: vi.fn().mockResolvedValue([]),
        transferCall: vi.fn().mockResolvedValue({ transferred: false }),
      },
      false,
      true,
    );
    await expect(
      executor.execute({
        arguments: '{"appointment_type":"Wellness","dates":["2026-09-01"]}',
        callId: 'fc_slots',
        name: 'get_available_appointments',
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });
    await expect(
      executor.execute({
        arguments: '{"appointment_type":"Wellness","dates":["2026-09-01"]}',
        callId: 'fc_slots_blocked',
        name: 'get_available_appointments',
        schedulingBlocked: true,
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(getAvailableAppointments).toHaveBeenCalledOnce();
  });

  it('rejects malformed and unknown model tool calls without side effects', async () => {
    const requestHumanHelp = vi.fn();
    const executor = new VoiceToolExecutor(
      context,
      {
        requestHumanHelp,
        searchBusinessKnowledge: vi.fn(),
        transferCall: vi.fn(),
      },
      false,
    );
    await expect(
      executor.execute({ arguments: '{', callId: 'fc_bad', name: 'request_human_help' }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      executor.execute({ arguments: '{}', callId: 'fc_unknown', name: 'book_appointment' }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(requestHumanHelp).not.toHaveBeenCalled();
  });

  it('captures voice lead facts against the latest trusted transcript and requests urgent follow-up', async () => {
    const capture = vi.fn().mockResolvedValue({ missingFields: [], state: 'needs_human' as const });
    const requestHumanHelp = vi.fn().mockResolvedValue({ created: true });
    const executor = new VoiceToolExecutor(
      context,
      {
        leadCapture: { capture },
        requestHumanHelp,
        searchBusinessKnowledge: vi.fn(),
        transferCall: vi.fn(),
      },
      false,
    );
    await expect(
      executor.execute({
        arguments: JSON.stringify({
          customerGoal: 'service',
          details: {},
          serviceCategory: 'wellness',
          urgency: 'urgent',
        }),
        callId: 'lead-voice-1',
        name: 'capture_lead',
        triggeringInboundMessageId: '00000000-0000-0000-0000-000000000014',
      }),
    ).resolves.toMatchObject({ handoffRequested: true, status: 'succeeded' });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        triggeringInboundMessageId: '00000000-0000-0000-0000-000000000014',
      }),
      context,
    );
    expect(requestHumanHelp).toHaveBeenCalledWith(
      expect.objectContaining({ urgency: 'urgent' }),
      context,
    );
  });
});
