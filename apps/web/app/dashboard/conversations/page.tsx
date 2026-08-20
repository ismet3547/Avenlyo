import Link from 'next/link';

import {
  channelLabel,
  conversationStatusLabel,
  parseChannelFilter,
  parseStatusFilter,
} from '@/lib/customers/presentation';
import { loadConversationArchive } from '@/lib/customers/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

/**
 * Conversation archive.
 *
 * This is history, not the Inbox. The Inbox is the action queue that owns claim, reply, release,
 * resolve, and resume; this page is read-only and offers none of them, so there is exactly one
 * place where operational ownership changes.
 */
interface ConversationsPageProps {
  readonly searchParams: Promise<{
    after?: string;
    afterId?: string;
    channel?: string;
    q?: string;
    status?: string;
  }>;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

const CHANNEL_TABS = [
  { label: 'All', value: null },
  { label: 'SMS', value: 'sms' },
  { label: 'Web chat', value: 'web' },
  { label: 'Voice', value: 'voice' },
] as const;

const STATUS_TABS = [
  { label: 'All', value: null },
  { label: 'Open', value: 'open' },
  { label: 'Pending', value: 'pending' },
  { label: 'Closed', value: 'closed' },
] as const;

export default async function ConversationsPage({ searchParams }: ConversationsPageProps) {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const params = await searchParams;

  if (!auth || !workspace.locationId) {
    return (
      <section className="max-w-4xl">
        <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
          Conversations
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Choose a location to see its conversation history.
        </p>
      </section>
    );
  }

  // Only canonical values are forwarded; anything else is dropped rather than sent to the database.
  const channel = parseChannelFilter(params.channel);
  const status = parseStatusFilter(params.status);
  const search =
    typeof params.q === 'string' && params.q.trim().length >= 2 ? params.q.trim() : null;
  const cursor =
    params.after && params.afterId
      ? { conversationId: params.afterId, lastActivityAt: params.after }
      : null;

  const page = await loadConversationArchive(auth.supabase, {
    channel,
    cursor,
    locationId: workspace.locationId,
    search,
    status,
  });

  const filterQuery = {
    ...(channel ? { channel } : {}),
    ...(status ? { status } : {}),
    ...(search ? { q: search } : {}),
  };

  return (
    <section className="max-w-5xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Dashboard
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Conversations
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Every customer conversation at {workspace.locationName ?? 'this location'}. To reply or take
        ownership, use the{' '}
        <Link className="font-semibold text-primary hover:underline" href="/dashboard/inbox">
          Inbox
        </Link>
        .
      </p>

      <nav aria-label="Filter by channel" className="mt-6 flex flex-wrap gap-2">
        {CHANNEL_TABS.map((tab) => (
          <Link
            aria-current={channel === tab.value ? 'page' : undefined}
            className={
              channel === tab.value
                ? 'rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground'
                : 'rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary'
            }
            href={{
              pathname: '/dashboard/conversations',
              query: {
                ...filterQuery,
                ...(tab.value ? { channel: tab.value } : { channel: undefined }),
              },
            }}
            key={tab.label}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <nav aria-label="Filter by status" className="mt-3 flex flex-wrap gap-2">
        {STATUS_TABS.map((tab) => (
          <Link
            aria-current={status === tab.value ? 'page' : undefined}
            className={
              status === tab.value
                ? 'rounded-full bg-ink px-3 py-1 text-xs font-semibold text-white'
                : 'rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary'
            }
            href={{
              pathname: '/dashboard/conversations',
              query: {
                ...filterQuery,
                ...(tab.value ? { status: tab.value } : { status: undefined }),
              },
            }}
            key={tab.label}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {page.conversations.length === 0 ? (
        <p className="mt-8 rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
          No customer conversations yet.
        </p>
      ) : (
        <ul className="mt-6 space-y-3" data-testid="conversation-list">
          {page.conversations.map((conversation) => (
            <li key={conversation.conversation_id}>
              <Link
                className="block rounded-xl border border-border bg-white p-5 transition-colors hover:border-primary"
                href={`/dashboard/conversations/${conversation.conversation_id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{conversation.customer_display_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {channelLabel(conversation.channel)} ·{' '}
                      {conversationStatusLabel(conversation.status)} · {conversation.message_count}{' '}
                      message
                      {conversation.message_count === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p>{formatDateTime(conversation.last_activity_at)}</p>
                    {conversation.active_handoff_status ? (
                      <p className="mt-1 font-semibold text-amber-800">
                        Waiting for a teammate
                        {conversation.active_handoff_urgency === 'urgent' ? ' · Urgent' : ''}
                      </p>
                    ) : null}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {page.nextCursor ? (
        <Link
          className="mt-6 inline-flex text-sm font-semibold text-primary hover:underline"
          href={{
            pathname: '/dashboard/conversations',
            query: {
              ...filterQuery,
              after: page.nextCursor.lastActivityAt,
              afterId: page.nextCursor.conversationId,
            },
          }}
        >
          Show older conversations
        </Link>
      ) : null}
    </section>
  );
}
