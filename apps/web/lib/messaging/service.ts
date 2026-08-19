import type {
  ConversationResumeResultRow,
  ConversationTakeoverResultRow,
  HandoffClaimResultRow,
  HandoffHistoryRow,
  HandoffQueueRow,
  HandoffQueueSummaryRow,
  HandoffReleaseResultRow,
  HandoffResolveResultRow,
  HumanReplyResultRow,
  InboxConversationRow,
  InboxMessageRow,
  WebChatWidgetConfigurationRow,
} from '@avenlyo/database';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

export interface MessagingRpcCaller {
  (
    name: 'get_my_inbox_conversations',
    args: { readonly target_location_id: string | null },
  ): PromiseLike<{
    readonly data: readonly InboxConversationRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'get_my_inbox_messages',
    args: { readonly target_conversation_id: string },
  ): PromiseLike<{
    readonly data: readonly InboxMessageRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'get_my_handoff_queue',
    args: {
      readonly target_location_id: string | null;
      readonly target_filter: string;
      readonly target_limit: number;
    },
  ): PromiseLike<{
    readonly data: readonly HandoffQueueRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'get_my_handoff_queue_summary',
    args: { readonly target_location_id: string | null },
  ): PromiseLike<{
    readonly data: readonly HandoffQueueSummaryRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'get_my_conversation_handoff_history',
    args: { readonly target_conversation_id: string; readonly target_limit: number },
  ): PromiseLike<{
    readonly data: readonly HandoffHistoryRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'claim_my_handoff',
    args: { readonly target_handoff_id: string },
  ): PromiseLike<{
    readonly data: readonly HandoffClaimResultRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'release_my_handoff',
    args: { readonly target_handoff_id: string },
  ): PromiseLike<{
    readonly data: readonly HandoffReleaseResultRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'resolve_my_handoff',
    args: { readonly target_handoff_id: string },
  ): PromiseLike<{
    readonly data: readonly HandoffResolveResultRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'take_over_my_conversation',
    args: { readonly target_conversation_id: string },
  ): PromiseLike<{
    readonly data: readonly ConversationTakeoverResultRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'resume_my_conversation_ai',
    args: { readonly target_conversation_id: string },
  ): PromiseLike<{
    readonly data: readonly ConversationResumeResultRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'create_my_human_reply',
    args: { readonly target_conversation_id: string; readonly target_body: string },
  ): PromiseLike<{
    readonly data: readonly HumanReplyResultRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'get_my_web_chat_widget',
    args: { readonly target_location_id: string },
  ): PromiseLike<{
    readonly data: readonly WebChatWidgetConfigurationRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
  (
    name: 'upsert_my_web_chat_widget',
    args: {
      readonly target_location_id: string;
      readonly target_enabled: boolean;
      readonly target_allowed_origins: readonly string[];
      readonly target_welcome_message: string | null;
    },
  ): PromiseLike<{
    readonly data: readonly WebChatWidgetConfigurationRow[] | null;
    readonly error: { readonly message: string } | null;
  }>;
}

/** Keeps SSR calls strict while Supabase's generic RPC inference remains intentionally narrow. */
export function messagingRpc(client: AvenlyoSupabaseClient): MessagingRpcCaller {
  return client.rpc.bind(client);
}
