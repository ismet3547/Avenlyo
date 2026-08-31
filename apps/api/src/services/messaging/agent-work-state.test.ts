import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { loadMessageAgentWorkState } from './agent-work-state.js';

function client(row: Record<string, unknown>) {
  const rpc = vi.fn().mockResolvedValue({ data: [row], error: null });
  return {
    rpc,
    supabase: { rpc } as unknown as SupabaseClient<Database>,
  };
}

describe('loadMessageAgentWorkState', () => {
  it('maps one opaque pending booking intent into trusted work state', async () => {
    const { rpc, supabase } = client({
      control_state: 'ai_active',
      pending_mutation_count: 1,
      pending_mutation_intent_id: '11111111-1111-4111-8111-111111111111',
      pending_mutation_intent_type: 'APPOINTMENT_BOOK',
    });

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
    expect(rpc).toHaveBeenCalledWith('get_message_agent_work_state', {
      target_message_id: 'message-1',
    });
  });

  it('preserves human control without inventing a pending action', async () => {
    const { supabase } = client({
      control_state: 'human_paused',
      pending_mutation_count: 0,
      pending_mutation_intent_id: null,
      pending_mutation_intent_type: null,
    });

    await expect(loadMessageAgentWorkState(supabase, 'message-2')).resolves.toEqual({
      kind: 'ready',
      workState: { control: 'human_paused', pendingMutation: null },
    });
  });

  it('fails closed when more than one consequential mutation awaits confirmation', async () => {
    const { supabase } = client({
      control_state: 'ai_active',
      pending_mutation_count: 2,
      pending_mutation_intent_id: null,
      pending_mutation_intent_type: null,
    });

    await expect(loadMessageAgentWorkState(supabase, 'message-3')).resolves.toEqual({
      kind: 'conflict',
    });
  });
});
