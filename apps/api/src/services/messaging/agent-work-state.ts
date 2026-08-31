import type { AgentConversationWorkState } from '@avenlyo/ai';
import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type PendingIntent = NonNullable<AgentConversationWorkState['pendingMutation']>['intent'];

interface WorkStateRpcRow {
  readonly control_state: 'ai_active' | 'human_paused';
  readonly pending_mutation_count: number;
  readonly pending_mutation_intent_id: string | null;
  readonly pending_mutation_intent_type: PendingIntent | null;
}

interface WorkStateRpc {
  (
    name: 'get_message_agent_work_state',
    args: { target_message_id: string },
  ): PromiseLike<{ data: WorkStateRpcRow[] | null; error: unknown }>;
}

export type MessageAgentWorkState =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'ready'; readonly workState: AgentConversationWorkState };

/** Loads model-independent conversation control and pending mutation identity from trusted SQL. */
export async function loadMessageAgentWorkState(
  supabase: SupabaseClient<Database>,
  inboundMessageId: string,
): Promise<MessageAgentWorkState> {
  const rpc = supabase.rpc.bind(supabase) as unknown as WorkStateRpc;
  const { data, error } = await rpc('get_message_agent_work_state', {
    target_message_id: inboundMessageId,
  });
  const row = data?.[0];
  if (error || !row) throw new Error('Message agent work state is unavailable.');

  if (row.pending_mutation_count > 1) return { kind: 'conflict' };
  if (row.pending_mutation_count === 0) {
    return {
      kind: 'ready',
      workState: { control: row.control_state, pendingMutation: null },
    };
  }
  if (!row.pending_mutation_intent_id || !row.pending_mutation_intent_type) {
    throw new Error('Message agent work state is inconsistent.');
  }
  return {
    kind: 'ready',
    workState: {
      control: row.control_state,
      pendingMutation: {
        actionIntentId: row.pending_mutation_intent_id,
        intent: row.pending_mutation_intent_type,
      },
    },
  };
}
