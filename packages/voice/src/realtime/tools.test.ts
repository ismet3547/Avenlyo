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
    ).toEqual(['search_business_knowledge', 'request_human_help']);
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
});
