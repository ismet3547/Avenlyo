import Link from 'next/link';

import {
  appointmentStatusLabel,
  callStatusLabel,
  channelLabel,
  conversationStatusLabel,
  deliveryLabel,
  deliveryTone,
  leadStatusLabel,
  messageAuthorLabel,
} from '@/lib/customers/presentation';
import { safePageCursor, safeUuid } from '@/lib/customers/input';
import { loadConversationDetail, loadConversationTranscript } from '@/lib/customers/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

/**
 * Conversation transcript.
 *
 * Read-only by construction: no mutation RPC is reachable from this page, so claim, reply, release,
 * resolve, and resume stay in the Inbox where they are already implemented once.
 */
interface ConversationDetailPageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ before?: string; beforeId?: string }>;
}

function formatDateTime(value: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

const DELIVERY_CLASSES: Readonly<Record<string, string>> = {
  failed: 'text-red-700',
  neutral: 'text-muted-foreground',
  success: 'text-emerald-700',
  warning: 'text-amber-800',
};

function Unavailable() {
  return (
    <section className="max-w-3xl">
      <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Conversation unavailable
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        This conversation is not available at the selected location.
      </p>
      <Link
        className="mt-6 inline-flex text-sm font-semibold text-primary hover:underline"
        href="/dashboard/conversations"
      >
        Back to conversations
      </Link>
    </section>
  );
}

export default async function ConversationDetailPage({
  params,
  searchParams,
}: ConversationDetailPageProps) {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const { id } = await params;
  const query = await searchParams;

  // A malformed identifier lands in the same place as a foreign or nonexistent one, rather than
  // reaching the database and returning a parse error that says it was malformed.
  const conversationId = safeUuid(id);
  if (!auth || !workspace.locationId || !conversationId) return <Unavailable />;

  const detail = await loadConversationDetail(auth.supabase, {
    conversationId,
    locationId: workspace.locationId,
  });
  // Foreign, cross-location, and test conversations are all simply unavailable. The page never
  // reveals whether the identifier names something real.
  if (!detail) return <Unavailable />;

  const cursor = safePageCursor(query.before, query.beforeId);
  const transcript = await loadConversationTranscript(auth.supabase, {
    conversationId,
    cursor: cursor ? { createdAt: cursor.timestamp, messageId: cursor.identifier } : null,
    locationId: workspace.locationId,
  });

  return (
    <section className="max-w-4xl">
      <Link
        className="text-sm font-semibold text-primary hover:underline"
        href="/dashboard/conversations"
      >
        ← Conversations
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
            {detail.customer_display_name}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {channelLabel(detail.channel)} · {conversationStatusLabel(detail.status)} ·{' '}
            {detail.message_count} message{detail.message_count === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {/* An anonymous visitor gets no link, because there is no customer record to open. */}
          {detail.contact_id ? (
            <Link
              className="inline-flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium"
              href={`/dashboard/customers/${detail.contact_id}`}
            >
              View customer
            </Link>
          ) : null}
          {detail.active_handoff_id ? (
            <Link
              className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
              href="/dashboard/inbox"
            >
              Open in Inbox
            </Link>
          ) : null}
        </div>
      </div>

      {detail.lead_id || detail.appointment_id || detail.call_id ? (
        <div className="mt-5 flex flex-wrap gap-3 text-xs">
          {detail.lead_id ? (
            <Link
              className="rounded-full border border-border px-3 py-1 font-medium text-ink hover:border-primary"
              href={`/dashboard/leads/${detail.lead_id}`}
            >
              Lead: {leadStatusLabel(detail.lead_status)}
            </Link>
          ) : null}
          {detail.appointment_id ? (
            <span className="rounded-full border border-border px-3 py-1 font-medium text-ink">
              {detail.appointment_title} · {appointmentStatusLabel(detail.appointment_status)}
            </span>
          ) : null}
          {detail.call_id ? (
            <span className="rounded-full border border-border px-3 py-1 font-medium text-ink">
              Call · {callStatusLabel(detail.call_status)}
            </span>
          ) : null}
        </div>
      ) : null}

      {transcript.olderCursor ? (
        <Link
          className="mt-6 inline-flex text-sm font-semibold text-primary hover:underline"
          href={{
            pathname: `/dashboard/conversations/${id}`,
            query: {
              before: transcript.olderCursor.createdAt,
              beforeId: transcript.olderCursor.messageId,
            },
          }}
        >
          Show earlier messages
        </Link>
      ) : null}

      <ol className="mt-4 space-y-4" data-testid="transcript">
        {transcript.messages.map((message) => {
          const delivery = deliveryLabel(message.delivery_status);
          return (
            <li className="rounded-xl border border-border bg-white p-4" key={message.message_id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                  {messageAuthorLabel({
                    authorDisplayName: message.author_display_name,
                    authorType: message.author_type,
                  })}
                </p>
                <time className="text-xs text-muted-foreground" dateTime={message.created_at}>
                  {formatDateTime(message.created_at)}
                </time>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">
                {message.body ?? 'No message content was recorded.'}
              </p>
              {/* Durable provider truth, stated in words rather than colour alone. */}
              {delivery ? (
                <p
                  className={`mt-2 text-xs font-medium ${DELIVERY_CLASSES[deliveryTone(message.delivery_status)]}`}
                >
                  {delivery}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {transcript.messages.length === 0 ? (
        <p className="mt-4 rounded-xl border border-border bg-white p-5 text-sm text-muted-foreground">
          No messages were recorded in this conversation.
        </p>
      ) : null}
    </section>
  );
}
