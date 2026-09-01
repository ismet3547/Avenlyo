import type { AgentConversationWorkState } from '@avenlyo/ai';
import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type PendingIntent = NonNullable<AgentConversationWorkState['pendingMutation']>['intent'];

interface WorkStateRpcRow {
  readonly control_state: 'ai_active' | 'human_paused';
  readonly pending_mutation_count: number;
  readonly pending_mutation_intent_id: string | null;
  readonly pending_mutation_intent_type: PendingIntent | null;
  readonly review_required: boolean;
}

interface WorkStateRpc {
  (
    name: 'get_message_agent_work_state_v2',
    args: { target_message_id: string },
  ): PromiseLike<{ data: WorkStateRpcRow[] | null; error: unknown }>;
}

interface ReviewHandoffRpc {
  (
    name: 'request_message_handoff',
    args: {
      target_inbound_message_id: string;
      target_reason: string;
      target_tool_call_id: string;
      target_urgency: 'normal';
    },
  ): PromiseLike<{
    data: { handoff_id: string | null }[] | null;
    error: unknown;
  }>;
}

const PROVIDER_REVIEW_REASON =
  'An appointment action has an unresolved provider outcome and requires human review.';

export type MessageAgentWorkState =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'ready'; readonly workState: AgentConversationWorkState };

/**
 * Loads model-independent conversation control and mutation identity from trusted SQL.
 *
 * An unresolved provider-crossed action is not ordinary zero-pending work. If a previous attempt
 * could not persist its handoff, the exact inbound retry recreates/coalesces that durable human work
 * here before returning the existing fail-closed conflict signal. This makes the retry path
 * self-healing without ever asking the model to infer provider truth.
 */
export async function loadMessageAgentWorkState(
  supabase: SupabaseClient<Database>,
  inboundMessageId: string,
): Promise<MessageAgentWorkState> {
  const rpc = supabase.rpc.bind(supabase) as unknown as WorkStateRpc;
  const { data, error } = await rpc('get_message_agent_work_state_v2', {
    target_message_id: inboundMessageId,
  });
  const row = data?.[0];
  if (error || !row) throw new Error('Message agent work state is unavailable.');

  if (row.review_required) {
    const handoffRpc = supabase.rpc.bind(supabase) as unknown as ReviewHandoffRpc;
    const { data: handoff, error: handoffError } = await handoffRpc('request_message_handoff', {
      target_inbound_message_id: inboundMessageId,
      target_reason: PROVIDER_REVIEW_REASON,
      target_tool_call_id: `provider-review-${inboundMessageId}`,
      target_urgency: 'normal',
    });
    if (handoffError || !handoff?.[0]?.handoff_id) {
      throw new Error('Unresolved provider mutation could not be handed off.');
    }
    return { kind: 'conflict' };
  }

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
