import { describe, expect, it, vi } from 'vitest';

import type {
  AgentExecutionContext,
  AgentFunctionTool,
  AgentToolCall,
} from '../agent/types';
import type { ToolExecutionResult, ToolExecutor } from './types';
import { CustomerCapabilityToolExecutor } from './customer-capability-executor';

const context: AgentExecutionContext = {
  conversationId: 'conversation-1',
  industryId: 'veterinary',
  locationId: 'location-1',
  mode: 'customer',
  organizationId: 'organization-1',
};

function tool(name: string): AgentFunctionTool {
  return {
    description: name,
    name,
    parameters: { additionalProperties: false, properties: {}, required: [], type: 'object' },
    strict: true,
  };
}

function delegate() {
  const execute = vi.fn((call: AgentToolCall): Promise<ToolExecutionResult> =>
    Promise.resolve({
      execution: { callId: call.callId, name: call.name, status: 'succeeded', summary: 'ok' },
      handoffRequested: false,
      modelOutput: '{}',
      sources: [],
    }),
  );
  const executor: ToolExecutor = {
    execute,
    tools: [
      tool('search_business_knowledge'),
      tool('request_human_help'),
      tool('get_available_appointments'),
      tool('prepare_appointment_booking'),
      tool('book_appointment'),
      tool('get_upcoming_appointments'),
      tool('get_reschedule_options'),
      tool('prepare_appointment_reschedule'),
      tool('reschedule_appointment'),
      tool('prepare_appointment_cancellation'),
      tool('cancel_appointment'),
    ],
  };
  return { execute, executor };
}

describe('CustomerCapabilityToolExecutor', () => {
  it('keeps unrelated tools while removing unsupported scheduling operations', () => {
    const { executor } = delegate();
    const scoped = new CustomerCapabilityToolExecutor(executor, {
      booking: true,
      cancel: true,
      lookup: true,
      reschedule: false,
    });

    expect(scoped.tools.map((entry) => entry.name)).toEqual([
      'search_business_knowledge',
      'request_human_help',
      'get_available_appointments',
      'prepare_appointment_booking',
      'book_appointment',
      'get_upcoming_appointments',
      'prepare_appointment_cancellation',
      'cancel_appointment',
    ]);
  });

  it('retains appointment lookup when lifecycle mutation capabilities are disabled', () => {
    const { executor } = delegate();
    const scoped = new CustomerCapabilityToolExecutor(executor, {
      booking: false,
      cancel: false,
      lookup: true,
      reschedule: false,
    });

    expect(scoped.tools.map((entry) => entry.name)).toEqual([
      'search_business_knowledge',
      'request_human_help',
      'get_upcoming_appointments',
    ]);
  });

  it('rejects a forged unsupported tool call without reaching the delegate', async () => {
    const { execute, executor } = delegate();
    const scoped = new CustomerCapabilityToolExecutor(executor, {
      booking: false,
      cancel: true,
      lookup: true,
      reschedule: false,
    });

    await expect(
      scoped.execute({ arguments: '{}', callId: 'forged-1', name: 'reschedule_appointment' }, context),
    ).resolves.toMatchObject({ execution: { status: 'rejected' } });
    expect(execute).not.toHaveBeenCalled();
  });
});
