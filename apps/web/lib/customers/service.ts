import type {
  ConversationArchiveRow,
  ConversationDetailRow,
  ConversationTranscriptRow,
  CustomerDirectoryRow,
  CustomerOverviewRow,
  CustomerTimelineRow,
} from '@avenlyo/database';
import { z } from 'zod';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

/**
 * Customer history data access.
 *
 * Every call is one bounded RPC that verifies location access at the database boundary. The browser
 * never queries contacts, conversations, messages, calls, appointments, leads, or deliveries
 * directly, so there is no N+1 to avoid and no place for a page to widen its own scope.
 */

export const CUSTOMER_PAGE_SIZE = 25;
export const TRANSCRIPT_PAGE_SIZE = 50;

interface CustomerRpcCaller {
  (
    name: 'get_my_customer_directory',
    args: {
      target_location_id: string;
      target_search: string | null;
      cursor_last_activity_at: string | null;
      cursor_contact_id: string | null;
      page_limit: number;
    },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  (
    name: 'get_my_customer_overview',
    args: { target_location_id: string; target_contact_id: string },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  (
    name: 'get_my_customer_timeline',
    args: {
      target_location_id: string;
      target_contact_id: string;
      cursor_event_at: string | null;
      cursor_event_kind: string | null;
      cursor_event_id: string | null;
      page_limit: number;
    },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  (
    name: 'get_my_conversation_archive',
    args: {
      target_location_id: string;
      target_channel: string | null;
      target_status: string | null;
      target_search: string | null;
      cursor_activity_at: string | null;
      cursor_conversation_id: string | null;
      page_limit: number;
    },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  (
    name: 'get_my_conversation_detail',
    args: { target_location_id: string; target_conversation_id: string },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  (
    name: 'get_my_conversation_transcript',
    args: {
      target_location_id: string;
      target_conversation_id: string;
      cursor_created_at: string | null;
      cursor_message_id: string | null;
      page_limit: number;
    },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

function customerRpc(client: AvenlyoSupabaseClient): CustomerRpcCaller {
  return client.rpc.bind(client);
}

export class CustomerHistoryError extends Error {
  public constructor(view: string) {
    super(`The ${view} could not be loaded.`);
    this.name = 'CustomerHistoryError';
  }
}

const directoryRowSchema = z.object({
  contact_id: z.string().uuid(),
  display_name: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  first_activity_at: z.string().nullable(),
  last_activity_at: z.string().nullable(),
  conversation_count: z.number().int().nonnegative(),
  call_count: z.number().int().nonnegative(),
  appointment_count: z.number().int().nonnegative(),
  lead_status: z.string().nullable(),
  sms_opted_out: z.boolean(),
});

const timelineRowSchema = z.object({
  event_kind: z.enum(['appointment', 'call', 'conversation', 'handoff', 'lead']),
  event_id: z.string().uuid(),
  event_at: z.string(),
  conversation_id: z.string().uuid().nullable(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  detail: z.string().nullable(),
  channel: z.string().nullable(),
  ai_mode: z.string().nullable(),
  message_count: z.number().int().nullable(),
  ends_at: z.string().nullable(),
  has_active_handoff: z.boolean(),
});

const archiveRowSchema = z.object({
  conversation_id: z.string().uuid(),
  contact_id: z.string().uuid().nullable(),
  customer_display_name: z.string(),
  channel: z.string(),
  status: z.string(),
  ai_mode: z.string(),
  created_at: z.string(),
  last_activity_at: z.string(),
  message_count: z.number().int().nonnegative(),
  assigned_display_name: z.string().nullable(),
  active_handoff_status: z.string().nullable(),
  active_handoff_urgency: z.string().nullable(),
});

const transcriptRowSchema = z.object({
  message_id: z.string().uuid(),
  author_type: z.string(),
  direction: z.string(),
  source_channel: z.string(),
  message_type: z.string(),
  body: z.string().nullable(),
  created_at: z.string(),
  sent_at: z.string().nullable(),
  author_display_name: z.string().nullable(),
  in_reply_to_message_id: z.string().uuid().nullable(),
  delivery_status: z.string().nullable(),
  delivery_updated_at: z.string().nullable(),
});

export interface CustomerDirectoryCursor {
  readonly contactId: string;
  readonly lastActivityAt: string;
}

export interface CustomerDirectoryPage {
  readonly customers: readonly CustomerDirectoryRow[];
  /** Present only when a further page exists, so the UI never renders a dead control. */
  readonly nextCursor: CustomerDirectoryCursor | null;
}

async function rows(
  view: string,
  request: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<unknown[]> {
  const { data, error } = await request;
  if (error || data === null) throw new CustomerHistoryError(view);
  return data;
}

export async function loadCustomerDirectory(
  supabase: AvenlyoSupabaseClient,
  input: {
    readonly cursor?: CustomerDirectoryCursor | null;
    readonly locationId: string;
    readonly search?: string | null;
  },
): Promise<CustomerDirectoryPage> {
  const data = await rows(
    'customer directory',
    customerRpc(supabase)('get_my_customer_directory', {
      cursor_contact_id: input.cursor?.contactId ?? null,
      cursor_last_activity_at: input.cursor?.lastActivityAt ?? null,
      page_limit: CUSTOMER_PAGE_SIZE,
      target_location_id: input.locationId,
      target_search: input.search?.trim() || null,
    }),
  );

  const customers: CustomerDirectoryRow[] = z.array(directoryRowSchema).parse(data);
  // A full page implies there may be more; a short page is definitively the end.
  const last = customers.length === CUSTOMER_PAGE_SIZE ? customers.at(-1) : undefined;
  return {
    customers,
    nextCursor:
      last && last.last_activity_at
        ? { contactId: last.contact_id, lastActivityAt: last.last_activity_at }
        : null,
  };
}

export async function loadCustomerOverview(
  supabase: AvenlyoSupabaseClient,
  input: { readonly contactId: string; readonly locationId: string },
): Promise<CustomerOverviewRow | null> {
  const data = await rows(
    'customer',
    customerRpc(supabase)('get_my_customer_overview', {
      target_contact_id: input.contactId,
      target_location_id: input.locationId,
    }),
  );
  // No row means not visible at this location. Deliberately indistinguishable from not existing.
  return (data[0] as CustomerOverviewRow | undefined) ?? null;
}

export interface CustomerTimelineCursor {
  readonly eventAt: string;
  readonly eventId: string;
  readonly eventKind: string;
}

export interface CustomerTimelinePage {
  readonly events: readonly CustomerTimelineRow[];
  readonly nextCursor: CustomerTimelineCursor | null;
}

export async function loadCustomerTimeline(
  supabase: AvenlyoSupabaseClient,
  input: {
    readonly contactId: string;
    readonly cursor?: CustomerTimelineCursor | null;
    readonly locationId: string;
  },
): Promise<CustomerTimelinePage> {
  const data = await rows(
    'customer activity',
    customerRpc(supabase)('get_my_customer_timeline', {
      cursor_event_at: input.cursor?.eventAt ?? null,
      cursor_event_id: input.cursor?.eventId ?? null,
      cursor_event_kind: input.cursor?.eventKind ?? null,
      page_limit: CUSTOMER_PAGE_SIZE,
      target_contact_id: input.contactId,
      target_location_id: input.locationId,
    }),
  );

  const events: CustomerTimelineRow[] = z.array(timelineRowSchema).parse(data);
  const last = events.length === CUSTOMER_PAGE_SIZE ? events.at(-1) : undefined;
  return {
    events,
    nextCursor: last
      ? { eventAt: last.event_at, eventId: last.event_id, eventKind: last.event_kind }
      : null,
  };
}

export interface ConversationArchiveCursor {
  readonly conversationId: string;
  readonly lastActivityAt: string;
}

export interface ConversationArchivePage {
  readonly conversations: readonly ConversationArchiveRow[];
  readonly nextCursor: ConversationArchiveCursor | null;
}

export async function loadConversationArchive(
  supabase: AvenlyoSupabaseClient,
  input: {
    readonly channel?: string | null;
    readonly cursor?: ConversationArchiveCursor | null;
    readonly locationId: string;
    readonly search?: string | null;
    readonly status?: string | null;
  },
): Promise<ConversationArchivePage> {
  const data = await rows(
    'conversation archive',
    customerRpc(supabase)('get_my_conversation_archive', {
      cursor_activity_at: input.cursor?.lastActivityAt ?? null,
      cursor_conversation_id: input.cursor?.conversationId ?? null,
      page_limit: CUSTOMER_PAGE_SIZE,
      target_channel: input.channel ?? null,
      target_location_id: input.locationId,
      target_search: input.search?.trim() || null,
      target_status: input.status ?? null,
    }),
  );

  const conversations: ConversationArchiveRow[] = z.array(archiveRowSchema).parse(data);
  const last = conversations.length === CUSTOMER_PAGE_SIZE ? conversations.at(-1) : undefined;
  return {
    conversations,
    nextCursor: last
      ? { conversationId: last.conversation_id, lastActivityAt: last.last_activity_at }
      : null,
  };
}

export async function loadConversationDetail(
  supabase: AvenlyoSupabaseClient,
  input: { readonly conversationId: string; readonly locationId: string },
): Promise<ConversationDetailRow | null> {
  const data = await rows(
    'conversation',
    customerRpc(supabase)('get_my_conversation_detail', {
      target_conversation_id: input.conversationId,
      target_location_id: input.locationId,
    }),
  );
  return (data[0] as ConversationDetailRow | undefined) ?? null;
}

export interface TranscriptPage {
  /** Oldest to newest within the window, which is how a transcript reads. */
  readonly messages: readonly ConversationTranscriptRow[];
  /** Cursor for the next older window, or null at the beginning of the conversation. */
  readonly olderCursor: { readonly createdAt: string; readonly messageId: string } | null;
}

export async function loadConversationTranscript(
  supabase: AvenlyoSupabaseClient,
  input: {
    readonly conversationId: string;
    readonly cursor?: { readonly createdAt: string; readonly messageId: string } | null;
    readonly locationId: string;
  },
): Promise<TranscriptPage> {
  const data = await rows(
    'conversation transcript',
    customerRpc(supabase)('get_my_conversation_transcript', {
      cursor_created_at: input.cursor?.createdAt ?? null,
      cursor_message_id: input.cursor?.messageId ?? null,
      page_limit: TRANSCRIPT_PAGE_SIZE,
      target_conversation_id: input.conversationId,
      target_location_id: input.locationId,
    }),
  );

  // The query walks backwards so paging is stable as new messages arrive; the window is reversed
  // here so the reader sees a conversation rather than a stack.
  const newestFirst: ConversationTranscriptRow[] = z.array(transcriptRowSchema).parse(data);
  const oldest = newestFirst.length === TRANSCRIPT_PAGE_SIZE ? newestFirst.at(-1) : undefined;
  return {
    messages: [...newestFirst].reverse(),
    olderCursor: oldest ? { createdAt: oldest.created_at, messageId: oldest.message_id } : null,
  };
}
