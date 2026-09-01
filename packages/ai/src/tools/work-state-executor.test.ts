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

function tool(name: string, properties: Record<string, unknown> = {}): AgentFunctionTool {
  return {
    description: name,
    name,
    parameters: {
      additionalProperties: false,
      properties,
      required: Object.keys(properties),
      type: 'object',
    },
    strict: true,
  };
}

function delegate() {
  const execute = vi.fn((call: AgentToolCall): Promise<ToolExecutionResult> =>
    Promise.resolve({
      execution: { callId: call.callId, name: call.name, status: 'succeeded', summary: 'ok' },
      handoffRequested: false,
      modelOutput: call.arguments,
      sources: [],
    }),
  );
  const executor: ToolExecutor = {
    execute,
    tools: [
      tool('search_business_knowledge', { query: { type: 'string' } }),
      tool('prepare_appointment_booking', { candidate_id: { type: 'string' } }),
      tool('book_appointment', { booking_intent_id: { type: 'string' } }),
      tool('prepare_appointment_reschedule', { candidate_id: { type: 'string' } }),
      tool('reschedule_appointment', { change_intent_id: { type: 'string' } }),
      tool('prepare_appointment_cancellation', { appointment_reference: { type: 'string' } }),
      tool('cancel_appointment', { change_intent_id: { type: 'string' } }),
    ],
  };
  return { execute, executor };
}

function state(
  pendingMutation: AgentConversationWorkState['pendingMutation'],
): AgentConversationWorkState {
  return { control: 'ai_active', pendingMutation };
}

describe('WorkStateToolExecutor', () => {
  it('hides all execution tools when there is no trusted pending mutation', () => {
    const { executor } = delegate();
    const scoped = new WorkStateToolExecutor(executor, state(null));

    expect(scoped.tools.map((entry) => entry.name)).toEqual([
      'search_business_knowledge',
      'prepare_appointment_booking',
      'prepare_appointment_reschedule',
      'prepare_appointment_cancellation',
    ]);
  });

  it('exposes only the matching execution tool while retaining prepare tools for corrections', () => {
    const { executor } = delegate();
    const scoped = new WorkStateToolExecutor(
      executor,
      state({ actionIntentId: '11111111-1111-4111-8111-111111111111', intent: 'APPOINTMENT_BOOK' }),
    );

    const names = scoped.tools.map((entry) => entry.name);
    expect(names).toContain('book_appointment');
    expect(names).not.toContain('reschedule_appointment');
    expect(names).not.toContain('cancel_appointment');
    expect(names).toContain('prepare_appointment_booking');
    expect(names).toContain('prepare_appointment_reschedule');
    expect(names).toContain('prepare_appointment_cancellation');
    expect(scoped.tools.find((entry) => entry.name === 'book_appointment')?.parameters).toEqual({
      additionalProperties: false,
      properties: {},
      required: [],
      type: 'object',
    });
  });

  it('binds booking execution to the trusted pending action id and ignores model arguments', async () => {
    const { execute, executor } = delegate();
    const trustedId = '11111111-1111-4111-8111-111111111111';
    const scoped = new WorkStateToolExecutor(
      executor,
      state({ actionIntentId: trustedId, intent: 'APPOINTMENT_BOOK' }),
    );

    await scoped.execute(
      {
        arguments: JSON.stringify({ booking_intent_id: '99999999-9999-4999-8999-999999999999' }),
        callId: 'book-1',
        name: 'book_appointment',
      },
      context,
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: JSON.stringify({ booking_intent_id: trustedId }) }),
      context,
    );
  });

  it('revalidates exact pending authority before a consequential execution', async () => {
    const { execute, executor } = delegate();
    const trustedId = '11111111-1111-4111-8111-111111111111';
    const revalidate = vi.fn().mockResolvedValue(true);
    const scoped = new WorkStateToolExecutor(
      executor,
      state({ actionIntentId: trustedId, intent: 'APPOINTMENT_BOOK' }),
      revalidate,
    );

    await scoped.execute(
      { arguments: '{}', callId: 'book-revalidated', name: 'book_appointment' },
      context,
    );

    expect(revalidate).toHaveBeenCalledWith(
      { actionIntentId: trustedId, intent: 'APPOINTMENT_BOOK' },
      context,
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it('fails closed when takeover, expiry, correction, or conflict invalidates authority', async () => {
    const { execute, executor } = delegate();
    const revalidate = vi.fn().mockResolvedValue(false);
    const scoped = new WorkStateToolExecutor(
      executor,
      state({
        actionIntentId: '22222222-2222-4222-8222-222222222222',
        intent: 'APPOINTMENT_CANCEL',
      }),
      revalidate,
    );

    const result = await scoped.execute(
      { arguments: '{}', callId: 'cancel-stale', name: 'cancel_appointment' },
      context,
    );

    expect(result.execution.status).toBe('rejected');
    expect(result.execution.summary).toBe('Trusted mutation authority changed before execution.');
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when authority revalidation itself is unavailable', async () => {
    const { execute, executor } = delegate();
    const revalidate = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const scoped = new WorkStateToolExecutor(
      executor,
      state({
        actionIntentId: '22222222-2222-4222-8222-222222222222',
        intent: 'APPOINTMENT_CANCEL',
      }),
      revalidate,
    );

    const result = await scoped.execute(
      { arguments: '{}', callId: 'cancel-db-failure', name: 'cancel_appointment' },
      context,
    );

    expect(result.execution.status).toBe('rejected');
    expect(result.execution.summary).toBe(
      'Trusted mutation authority could not be revalidated.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows correction preparation while pending and redacts replacement authority ids', async () => {
    const authorityId = '33333333-3333-4333-8333-333333333333';
    const execute = vi.fn().mockResolvedValue({
      execution: {
        callId: 'prepare-1',
        name: 'prepare_appointment_booking',
        status: 'succeeded',
        summary: 'ready',
      },
      handoffRequested: false,
      modelOutput: JSON.stringify({
        intent: {
          bookingIntentId: authorityId,
          startsAt: '2026-09-01T10:00:00Z',
          timezone: 'UTC',
          typeName: 'Consultation',
        },
        outcome: 'ready',
      }),
      sources: [],
    } satisfies ToolExecutionResult);
    const executor: ToolExecutor = {
      execute,
      tools: [tool('prepare_appointment_booking', { candidate_id: { type: 'string' } })],
    };
    const scoped = new WorkStateToolExecutor(
      executor,
      state({
        actionIntentId: '11111111-1111-4111-8111-111111111111',
        intent: 'APPOINTMENT_BOOK',
      }),
    );

    const result = await scoped.execute(
      {
        arguments: JSON.stringify({ candidate_id: '44444444-4444-4444-8444-444444444444' }),
        callId: 'prepare-1',
        name: 'prepare_appointment_booking',
      },
      context,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result.modelOutput).not.toContain(authorityId);
    expect(JSON.parse(result.modelOutput)).toEqual({
      intent: {
        startsAt: '2026-09-01T10:00:00Z',
        timezone: 'UTC',
        typeName: 'Consultation',
      },
      outcome: 'ready',
    });
  });

  it('rejects a mismatched execution tool without reaching the delegate', async () => {
    const { execute, executor } = delegate();
    const scoped = new WorkStateToolExecutor(
      executor,
      state({
        actionIntentId: '22222222-2222-4222-8222-222222222222',
        intent: 'APPOINTMENT_CANCEL',
      }),
    );

    const result = await scoped.execute(
      { arguments: '{}', callId: 'wrong-1', name: 'reschedule_appointment' },
      context,
    );

    expect(result.execution.status).toBe('rejected');
    expect(execute).not.toHaveBeenCalled();
  });
});
