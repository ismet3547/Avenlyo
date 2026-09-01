import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { loadMessageAgentWorkState } from './agent-work-state.js';

function client(row: Record<string, unknown>, handoffId = 'handoff-1') {
  const rpc = vi.fn((name: string) => {
    if (name === 'get_message_agent_work_state_v2') {
      return Promise.resolve({ data: [row], error: null });
    }
    if (name === 'request_message_handoff') {
      return Promise.resolve({ data: [{ handoff_id: handoffId }], error: null });
    }
    return Promise.resolve({ data: null, error: { message: 'unexpected rpc' } });
  });
  return {
    rpc,
    supabase: { rpc } as unknown as SupabaseClient<Database>,
  };
}

function workStateRow(overrides: Record<string, unknown> = {}) {
  return {
    control_state: 'ai_active',
    pending_mutation_count: 0,
    pending_mutation_intent_id: null,
    pending_mutation_intent_type: null,
    review_required: false,
    ...overrides,
  };
}

describe('loadMessageAgentWorkState', () => {
  it('maps one opaque pending booking intent into trusted work state', async () => {
    const { rpc, supabase } = client(
      workStateRow({
        pending_mutation_count: 1,
        pending_mutation_intent_id: '11111111-1111-4111-8111-111111111111',
        pending_mutation_intent_type: 'APPOINTMENT_BOOK',
      }),
    );

    await expect(loadMessageAgentWorkState(supabase, 'message-1')).resolves.toEqual({
      kind: 'ready',
      workState: {
        control: 'ai_active',
        pendingMutation: {
          actionIntentId: '11111111-1111-4111-8111-111111111111',
          intent: 'APPOINTMENT_BOOK',
        },
      },
    });
    expect(rpc).toHaveBeenCalledWith('get_message_agent_work_state_v2', {
      target_message_id: 'message-1',
    });
  });

  it('preserves human control without inventing a pending action', async () => {
    const { supabase } = client(workStateRow({ control_state: 'human_paused' }));

    await expect(loadMessageAgentWorkState(supabase, 'message-2')).resolves.toEqual({
      kind: 'ready',
      workState: { control: 'human_paused', pendingMutation: null },
    });
  });

  it('fails closed when more than one consequential mutation awaits confirmation', async () => {
    const { supabase } = client(workStateRow({ pending_mutation_count: 2 }));

    await expect(loadMessageAgentWorkState(supabase, 'message-3')).resolves.toEqual({
      kind: 'conflict',
    });
  });

  it('recreates durable human work before a provider-crossed retry can become a normal AI turn', async () => {
    const { rpc, supabase } = client(workStateRow({ review_required: true }));

    await expect(loadMessageAgentWorkState(supabase, 'message-review')).resolves.toEqual({
      kind: 'conflict',
    });
    expect(rpc).toHaveBeenCalledWith('request_message_handoff', {
      target_inbound_message_id: 'message-review',
      target_reason:
        'An appointment action has an unresolved provider outcome and requires human review.',
      target_tool_call_id: 'provider-review-message-review',
      target_urgency: 'normal',
    });
  });

  it('does not hide an unresolved provider mutation when durable handoff persistence fails', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'get_message_agent_work_state_v2') {
        return Promise.resolve({ data: [workStateRow({ review_required: true })], error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'database unavailable' } });
    });
    const supabase = { rpc } as unknown as SupabaseClient<Database>;

    await expect(loadMessageAgentWorkState(supabase, 'message-review-failure')).rejects.toThrow(
      'Unresolved provider mutation could not be handed off.',
    );
  });
});
