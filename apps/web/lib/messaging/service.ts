import type {
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
    name: 'take_over_my_conversation' | 'resume_my_conversation_ai',
    args: { readonly target_conversation_id: string },
  ): PromiseLike<{ readonly data: null; readonly error: { readonly message: string } | null }>;
  (
    name: 'create_my_human_reply',
    args: { readonly target_conversation_id: string; readonly target_body: string },
  ): PromiseLike<{
    readonly data:
      readonly { readonly message_id: string; readonly source_channel: string }[] | null;
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
