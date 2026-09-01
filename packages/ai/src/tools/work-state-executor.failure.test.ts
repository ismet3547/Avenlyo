import { describe, expect, it, vi } from 'vitest';

import type {
  AgentConversationWorkState,
  AgentExecutionContext,
  AgentFunctionTool,
  AgentToolCall,
} from '../agent/types';
import type { ToolExecutionResult, ToolExecutor } from './types';
import { WorkStateToolExecutor } from './work-state-executor';

const context: AgentExecutionContext = {
  conversationId: 'conversation-1',
  industryId: 'veterinary',
  locationId: 'location-1',
  mode: 'customer',
  organizationId: 'organization-1',
};

const pending: AgentConversationWorkState = {
  control: 'ai_active',
  pendingMutation: {
    actionIntentId: '11111111-1111-4111-8111-111111111111',
    intent: 'APPOINTMENT_BOOK',
  },
};

const bookingTool: AgentFunctionTool = {
  description: 'Book the prepared appointment.',
  name: 'book_appointment',
  parameters: {
    additionalProperties: false,
    properties: { booking_intent_id: { type: 'string' } },
    required: ['booking_intent_id'],
    type: 'object',
  },
  strict: true,
};

function call(): AgentToolCall {
  return { arguments: '{}', callId: 'book-1', name: 'book_appointment' };
}

function executorReturning(result: ToolExecutionResult) {
  const execute = vi.fn().mockResolvedValue(result);
  const delegate: ToolExecutor = { execute, tools: [bookingTool] };
  return { execute, scoped: new WorkStateToolExecutor(delegate, pending) };
}

function failed(modelOutput: string): ToolExecutionResult {
  return {
    execution: {
      callId: 'book-1',
      name: 'book_appointment',
      status: 'failed',
      summary: 'Tool execution failed.',
    },
    handoffRequested: false,
    modelOutput,
    sources: [],
  };
}

describe('WorkStateToolExecutor mutation failure classification', () => {
  it('forces human review when an authorized consequential failure has no trusted outcome', async () => {
    const { execute, scoped } = executorReturning(
      failed(JSON.stringify({ ok: false, message: 'The requested action could not be completed.' })),
    );

    const result = await scoped.execute(call(), context);

    expect(result.handoffRequested).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: JSON.stringify({ booking_intent_id: pending.pendingMutation?.actionIntentId }),
      }),
      context,
    );
  });

  it('also forces review when the failed mutation payload cannot be classified as JSON', async () => {
    const { scoped } = executorReturning(failed('not-json'));

    await expect(scoped.execute(call(), context)).resolves.toMatchObject({
      handoffRequested: true,
    });
  });

  it('preserves a trusted classified refusal instead of escalating every failed mutation', async () => {
    const { scoped } = executorReturning(failed(JSON.stringify({ outcome: 'unavailable' })));

    await expect(scoped.execute(call(), context)).resolves.toMatchObject({
      handoffRequested: false,
      modelOutput: JSON.stringify({ outcome: 'unavailable' }),
    });
  });
});
