import { veterinaryPack } from '@avenlyo/industries';
import { describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from './runtime';
import type {
  AgentFunctionTool,
  AgentProviderResult,
  AgentToolCall,
  AgentTurnInput,
} from './types';
import { FakeAgentProvider } from '../testing/fake-provider';
import type { ToolExecutionResult, ToolExecutor } from '../tools/types';

function functionTool(name: string): AgentFunctionTool {
  return {
    description: name,
    name,
    parameters: { additionalProperties: false, properties: {}, required: [], type: 'object' },
    strict: true,
  };
}

function providerResult(toolCalls: AgentProviderResult['toolCalls']): AgentProviderResult {
  return { text: '', toolCalls };
}

const baseTurn: Omit<AgentTurnInput, 'userMessage'> = {
  business: {
    address: '1 Clinic Way',
    businessHours: 'Mon-Fri 09:00-17:00',
    locationName: 'Main Clinic',
    name: 'Example Veterinary',
    phone: '+1 555 0100',
    timezone: 'UTC',
    website: 'https://clinic.example',
  },
  context: {
    conversationId: 'conversation-1',
    industryId: 'veterinary',
    locationId: 'location-1',
    mode: 'test',
    organizationId: 'organization-1',
  },
  history: [],
  industry: veterinaryPack,
};

function execution(
  call: AgentToolCall,
  input: { readonly handoffRequested?: boolean; readonly status?: 'failed' | 'succeeded' },
): ToolExecutionResult {
  return {
    execution: {
      callId: call.callId,
      name: call.name,
      status: input.status ?? 'succeeded',
      summary: 'trusted result',
    },
    handoffRequested: input.handoffRequested ?? false,
    modelOutput: JSON.stringify({ ok: true }),
    sources: [],
  };
}

function runtimeFor(input: {
  readonly providerScript: readonly AgentProviderResult[];
  readonly execute: (call: AgentToolCall) => Promise<ToolExecutionResult>;
  readonly toolNames: readonly string[];
}) {
  const provider = new FakeAgentProvider(input.providerScript);
  const execute = vi.fn(input.execute);
  const executor: ToolExecutor = {
    execute: (call) => execute(call),
    tools: input.toolNames.map(functionTool),
  };
  return {
    execute,
    provider,
    runtime: new AgentRuntime(provider, executor, 'test-agent-model'),
  };
}

describe('AgentRuntime terminal action boundaries', () => {
  it('executes an explicit human-help interrupt before a mutation from the same provider batch', async () => {
    const booking = { arguments: '{}', callId: 'book-1', name: 'book_appointment' };
    const handoff = {
      arguments: JSON.stringify({ reason: 'Customer requested a human.', urgency: 'normal' }),
      callId: 'handoff-1',
      name: 'request_human_help',
    };
    const { execute, runtime } = runtimeFor({
      execute: (call) =>
        Promise.resolve(
          call.name === 'request_human_help'
            ? execution(call, { handoffRequested: true })
            : execution(call, {}),
        ),
      providerScript: [providerResult([booking, handoff])],
      toolNames: ['book_appointment', 'request_human_help'],
    });

    const result = await runtime.runTurn({
      ...baseTurn,
      userMessage: 'Yes, but I want a person to handle this.',
    });

    expect(result).toMatchObject({
      handoffRequested: true,
      text: "I've asked the team to help with this.",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].name).toBe('request_human_help');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('ends the turn immediately after trusted booking success without another model round', async () => {
    const booking = { arguments: '{}', callId: 'book-success', name: 'book_appointment' };
    const { execute, provider, runtime } = runtimeFor({
      execute: (call) => Promise.resolve(execution(call, {})),
      providerScript: [providerResult([booking])],
      toolNames: ['book_appointment'],
    });

    const result = await runtime.runTurn({ ...baseTurn, userMessage: 'Yes, book it.' });

    expect(result).toMatchObject({
      handoffRequested: false,
      text: 'Your appointment has been booked.',
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(provider.inputs).toHaveLength(1);
  });

  it('ends the turn with uncertainty after an unknown booking outcome and never retries', async () => {
    const booking = { arguments: '{}', callId: 'book-unknown', name: 'book_appointment' };
    const { execute, provider, runtime } = runtimeFor({
      execute: (call) =>
        Promise.resolve(execution(call, { handoffRequested: true, status: 'failed' })),
      providerScript: [providerResult([booking])],
      toolNames: ['book_appointment'],
    });

    const result = await runtime.runTurn({ ...baseTurn, userMessage: 'Yes, book it.' });

    expect(result).toMatchObject({
      handoffRequested: true,
      text: "I couldn't verify whether the appointment was booked. I've asked the team to review it before anything is retried.",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(provider.inputs).toHaveLength(1);
  });

  it.each([
    ['reschedule_appointment', 'Your appointment has been rescheduled.'],
    ['cancel_appointment', 'Your appointment has been canceled.'],
  ] as const)('uses deterministic trusted completion for %s', async (name, expectedText) => {
    const { provider, runtime } = runtimeFor({
      execute: (call) => Promise.resolve(execution(call, {})),
      providerScript: [providerResult([{ arguments: '{}', callId: `call-${name}`, name }])],
      toolNames: [name],
    });

    await expect(runtime.runTurn({ ...baseTurn, userMessage: 'Yes.' })).resolves.toMatchObject({
      text: expectedText,
    });
    expect(provider.inputs).toHaveLength(1);
  });
});
