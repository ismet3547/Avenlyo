import { dentalPack } from '@avenlyo/industries';
import { describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from './runtime';
import type { AgentBusinessContext } from './types';
import { ControlledToolExecutor } from '../tools/executor';

const business: AgentBusinessContext = {
  address: 'Synthetic address',
  businessHours: JSON.stringify({
    monday: { closed: false, open: '09:00', close: '18:00' },
    tuesday: { closed: false, open: '09:00', close: '18:00' },
    wednesday: { closed: false, open: '09:00', close: '18:00' },
    thursday: { closed: false, open: '09:00', close: '18:00' },
    friday: { closed: false, open: '09:00', close: '18:00' },
    saturday: { closed: false, open: '10:00', close: '15:00' },
    sunday: { closed: true, open: null, close: null },
  }),
  locationName: 'Demo Clinic',
  name: 'Avenlyo Dental Demo Clinic',
  phone: null,
  timezone: 'Europe/Istanbul',
  website: null,
};

function input(userMessage: string) {
  return {
    business,
    context: {
      conversationId: 'conversation-1',
      industryId: dentalPack.id,
      locationId: 'location-1',
      mode: 'test' as const,
      organizationId: 'organization-1',
    },
    history: [],
    industry: dentalPack,
    userMessage,
  };
}

function executor(requestHumanHelp = vi.fn(() => Promise.resolve({ created: true }))) {
  return {
    requestHumanHelp,
    tools: new ControlledToolExecutor(dentalPack, {
      requestHumanHelp,
      searchBusinessKnowledge: () => Promise.resolve([]),
    }),
  };
}

describe('cost-aware routing runtime boundary', () => {
  it('answers authoritative business hours with no provider at all', async () => {
    const { tools } = executor();
    const runtime = new AgentRuntime(null, tools, 'gpt-5.6');

    await expect(runtime.runTurn(input('Cumartesi açık mısınız?'))).resolves.toMatchObject({
      handoffRequested: false,
      model: 'deterministic',
      text: 'Cumartesi günleri 10:00–15:00 arasında açığız.',
      toolCalls: [],
    });
  });

  it('executes an urgent deterministic handoff without a provider', async () => {
    const { requestHumanHelp, tools } = executor();
    const runtime = new AgentRuntime(null, tools, 'gpt-5.6');

    const result = await runtime.runTurn(input('Dişim çok ağrıyor ve yüzüm şişti, ne yapmalıyım?'));

    expect(result).toMatchObject({ handoffRequested: true, model: 'deterministic' });
    expect(requestHumanHelp).toHaveBeenCalledOnce();
    expect(requestHumanHelp).toHaveBeenCalledWith(
      expect.objectContaining({ urgency: 'urgent' }),
      expect.anything(),
    );
  });

  it('fails closed when a model route has no provider', async () => {
    const { tools } = executor();
    const runtime = new AgentRuntime(null, tools, 'gpt-5.6');

    await expect(runtime.runTurn(input('İngilizce konuşuyor musunuz?'))).resolves.toMatchObject({
      failureCode: 'provider_error',
      handoffRequested: false,
      model: 'gpt-5.6',
    });
  });
});
