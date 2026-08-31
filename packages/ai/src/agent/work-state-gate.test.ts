import { veterinaryPack } from '@avenlyo/industries';
import { describe, expect, it } from 'vitest';

import { AgentRuntime } from './runtime';
import type { AgentTurnInput } from './types';
import { ControlledToolExecutor } from '../tools/executor';
import { FakeAgentProvider } from '../testing/fake-provider';

function input(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    business: {
      address: null,
      businessHours: 'Mon-Fri 09:00-17:00',
      locationName: 'Main clinic',
      name: 'Example Veterinary',
      phone: null,
      timezone: 'UTC',
      website: null,
    },
    context: {
      channel: 'web',
      conversationId: 'conversation-1',
      industryId: 'veterinary',
      locationId: 'location-1',
      mode: 'customer',
      organizationId: 'organization-1',
    },
    history: [],
    industry: veterinaryPack,
    userMessage: 'Hello',
    ...overrides,
  };
}

function runtime() {
  const provider = new FakeAgentProvider([{ text: 'Hello.', toolCalls: [] }]);
  const agent = new AgentRuntime(
    provider,
    new ControlledToolExecutor(veterinaryPack, {
      requestHumanHelp: () => Promise.resolve({ created: true }),
      searchBusinessKnowledge: () => Promise.resolve([]),
    }),
    'test-model',
  );
  return { agent, provider };
}

describe('trusted conversation work-state gate', () => {
  it('fails customer traffic closed before the provider when trusted work state is missing', async () => {
    const { agent, provider } = runtime();

    await expect(agent.runTurn(input())).resolves.toMatchObject({
      suppressedReason: 'missing_work_state',
      text: '',
      toolCalls: [],
    });
    expect(provider.inputs).toHaveLength(0);
  });

  it('does not start a normal model turn while conversation control is human-paused', async () => {
    const { agent, provider } = runtime();

    await expect(
      agent.runTurn(
        input({
          workState: { control: 'human_paused', pendingMutation: null },
        }),
      ),
    ).resolves.toMatchObject({
      suppressedReason: 'human_control',
      text: '',
      toolCalls: [],
    });
    expect(provider.inputs).toHaveLength(0);
  });

  it('passes only bounded trusted work-state facts to the model when AI control is active', async () => {
    const { agent, provider } = runtime();
    const internalActionIntentId = 'action-intent-secret-123';

    await expect(
      agent.runTurn(
        input({
          workState: {
            control: 'ai_active',
            pendingMutation: {
              actionIntentId: internalActionIntentId,
              intent: 'APPOINTMENT_RESCHEDULE',
            },
          },
        }),
      ),
    ).resolves.toMatchObject({ text: 'Hello.' });

    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]?.instructions).toContain('Conversation control: ai_active.');
    expect(provider.inputs[0]?.instructions).toContain(
      'Pending consequential mutation: APPOINTMENT_RESCHEDULE.',
    );
    expect(provider.inputs[0]?.instructions).not.toContain(internalActionIntentId);
  });

  it('keeps test mode deterministic without requiring persisted customer work state', async () => {
    const { agent, provider } = runtime();

    await expect(
      agent.runTurn(
        input({
          context: {
            conversationId: 'test-conversation',
            industryId: 'veterinary',
            locationId: 'location-1',
            mode: 'test',
            organizationId: 'organization-1',
          },
        }),
      ),
    ).resolves.toMatchObject({ text: 'Hello.' });
    expect(provider.inputs).toHaveLength(1);
  });
});
