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

function knowledgeExecutor(matches: readonly unknown[]) {
  return new VoiceToolExecutor(
    context,
    {
      requestHumanHelp: vi.fn().mockResolvedValue({ created: true }),
      searchBusinessKnowledge: vi.fn().mockResolvedValue(matches),
      transferCall: vi.fn(),
    },
    false,
  );
}

function knowledgeMatch(similarity: number, title: string) {
  return {
    content: 'Published page text the caller may be answered from.',
    similarity,
    sourceUrl: `https://clinic.test/${title.toLowerCase()}`,
    title,
  };
}

describe('voice trusts knowledge on the same terms as chat', () => {
  // Voice used to hold its own copy of the filter, sharing only the threshold constant. Two copies
  // of a trust rule is one rule and one latent divergence: recalibrating chat alone would have left
  // the phone refusing a question chat had just answered from the same published pages.
  const call = { arguments: '{"query":"hesap"}', callId: 'fc_knowledge', name: 'search_business_knowledge' };

  it('answers from a moderately scored match that clearly leads the field', async () => {
    const executor = knowledgeExecutor([
      knowledgeMatch(0.573, 'Giris'),
      knowledgeMatch(0.422, 'Hesap'),
      knowledgeMatch(0.296, 'Unrelated'),
    ]);

    const result = await executor.execute(call);

    expect(result.status).toBe('succeeded');
    expect(result.modelOutput).toContain('Giris');
    // Only the winner reaches the phone too: the runner-up earned the lead its comparison proved,
    // not the right to answer, and the third result is below the floor.
    expect(result.modelOutput).not.toContain('Hesap');
    expect(result.modelOutput).not.toContain('Unrelated');
  });

  it('refuses a lone moderate match', async () => {
    const executor = knowledgeExecutor([knowledgeMatch(0.44, 'Alone')]);

    const result = await executor.execute(call);

    expect(result.modelOutput).not.toContain('Alone');
  });

  it('does not let a strong match carry weak runners-up', async () => {
    const executor = knowledgeExecutor([
      knowledgeMatch(0.62, 'Strong'),
      knowledgeMatch(0.36, 'Weak'),
    ]);

    const result = await executor.execute(call);

    expect(result.modelOutput).toContain('Strong');
    expect(result.modelOutput).not.toContain('Weak');
  });

  it('refuses a flat, ambiguous field', async () => {
    const executor = knowledgeExecutor([
      knowledgeMatch(0.46, 'One'),
      knowledgeMatch(0.44, 'Two'),
      knowledgeMatch(0.41, 'Three'),
    ]);

    const result = await executor.execute(call);

    expect(result.modelOutput).not.toContain('One');
    expect(result.modelOutput).not.toContain('Two');
  });
});

describe('voice tool boundary', () => {
  it('only exposes transfer when trusted configuration permits it', () => {
    expect(
      activeVoiceTools({ industry: veterinaryPack, transferEnabled: false }).map(
        ({ name }) => name,
      ),
    ).toEqual([
      'search_business_knowledge',
      'request_human_help',
      'capture_lead',
      'prepare_sms_followup_consent',
      'confirm_sms_followup_consent',
    ]);
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

  it('keeps Voice follow-up consent identities outside model arguments', async () => {
    const followupTools = activeVoiceTools({ industry: veterinaryPack, transferEnabled: false });
    expect(
      followupTools.find((tool) => tool.name === 'prepare_sms_followup_consent')?.description,
    ).toContain('before asking the consent question');
    expect(
      followupTools.find((tool) => tool.name === 'confirm_sms_followup_consent')?.description,
    ).toContain('new transcript after the follow-up question');
    const prepare = vi.fn().mockResolvedValue({
      consentIntentId: '00000000-0000-4000-8000-000000000101',
      expiresAt: '2026-08-24T10:10:00.000Z',
    });
    const confirm = vi.fn().mockResolvedValue({ granted: true });
    const executor = new VoiceToolExecutor(
      context,
      {
        followupConsent: { confirm, prepare },
        requestHumanHelp: vi.fn().mockResolvedValue({ created: true }),
        searchBusinessKnowledge: vi.fn().mockResolvedValue([]),
        transferCall: vi.fn(),
      },
      false,
    );
    const transcriptId = '00000000-0000-0000-0000-000000000014';

    await expect(
      executor.execute({
        arguments: '{}',
        callId: 'followup-prepare',
        name: 'prepare_sms_followup_consent',
        triggeringInboundMessageId: transcriptId,
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });
    await expect(
      executor.execute({
        arguments: '{"consent_intent_id":"00000000-0000-4000-8000-000000000101"}',
        callId: 'followup-confirm',
        name: 'confirm_sms_followup_consent',
        triggeringInboundMessageId: transcriptId,
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });

    expect(prepare).toHaveBeenCalledWith({ triggeringInboundMessageId: transcriptId }, context);
    expect(confirm).toHaveBeenCalledWith(
      {
        consentIntentId: '00000000-0000-4000-8000-000000000101',
        triggeringInboundMessageId: transcriptId,
      },
      context,
    );
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

  it('requests one urgent voice handoff when a contradiction remains needs_clarification', async () => {
    const capture = vi.fn().mockResolvedValue({
      missingFields: ['service_category'],
      state: 'needs_clarification' as const,
    });
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
    const call = {
      arguments:
        '{"customerGoal":"appointment","details":{},"serviceCategory":"grooming","urgency":"urgent"}',
      callId: 'lead-voice-urgent-conflict',
      name: 'capture_lead' as const,
      triggeringInboundMessageId: '00000000-0000-0000-0000-000000000014',
    };

    await expect(executor.execute(call)).resolves.toMatchObject({ handoffRequested: true });
    await expect(executor.execute(call)).resolves.toMatchObject({ handoffRequested: true });
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ serviceCategory: 'grooming', urgency: 'urgent' }),
      context,
    );
    expect(requestHumanHelp).toHaveBeenCalledOnce();
    expect(requestHumanHelp).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'lead-voice-urgent-conflict:urgent-lead',
        urgency: 'urgent',
      }),
      context,
    );
  });

  it('does not request a voice handoff for a routine contradiction', async () => {
    const requestHumanHelp = vi.fn().mockResolvedValue({ created: true });
    const executor = new VoiceToolExecutor(
      context,
      {
        leadCapture: {
          capture: vi.fn().mockResolvedValue({
            missingFields: ['service_category'],
            state: 'needs_clarification',
          }),
        },
        requestHumanHelp,
        searchBusinessKnowledge: vi.fn(),
        transferCall: vi.fn(),
      },
      false,
    );

    await expect(
      executor.execute({
        arguments:
          '{"customerGoal":"appointment","details":{},"serviceCategory":"grooming","urgency":"routine"}',
        callId: 'lead-voice-routine-conflict',
        name: 'capture_lead',
        triggeringInboundMessageId: '00000000-0000-0000-0000-000000000014',
      }),
    ).resolves.toMatchObject({ handoffRequested: false });
    expect(requestHumanHelp).not.toHaveBeenCalled();
  });
});
