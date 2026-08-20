import Link from 'next/link';
import { MessageCircleMore, PhoneCall, TriangleAlert, UserRound } from 'lucide-react';
import type { HandoffQueueRow } from '@avenlyo/database';

import {
  claimHandoffAction,
  releaseHandoffAction,
  resolveHandoffAction,
  resumeConversationAction,
  sendHumanReplyAction,
  takeOverConversationAction,
} from './actions';
import { QueueAutoRefresh } from './queue-auto-refresh';
import {
  QUEUE_ACTION_MESSAGES,
  QUEUE_FILTERS,
  assigneeLabel,
  conversationTitle,
  deriveCustomerWaiting,
  formatWaitingDuration,
  normalizeQueueFilter,
  operatorActions,
  operatorViewerFromRole,
  sortQueueRows,
} from './queue-view';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { messagingRpc } from '@/lib/messaging/service';

const QUEUE_LIMIT = 60;
const HISTORY_LIMIT = 8;

function timestamp(value: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function leadLabel(status: string): string {
  if (status === 'qualified') return 'Qualified';
  if (status === 'converted') return 'Converted';
  return 'Lead';
}

function Badge({
  children,
  tone,
}: {
  readonly children: React.ReactNode;
  readonly tone: 'neutral' | 'urgent' | 'waiting' | 'lead' | 'owner';
}) {
  const tones = {
    lead: 'bg-primary/10 text-primary',
    neutral: 'bg-muted text-muted-foreground',
    owner: 'bg-ink/10 text-ink',
    urgent: 'bg-destructive/10 text-destructive',
    waiting: 'bg-amber-100 text-amber-900',
  } as const;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly conversation?: string;
    readonly filter?: string;
    readonly outcome?: string;
  }>;
}) {
  // Read the request first so the operator queue always renders per request: a bounded client
  // refresh is only useful if the page is never served from a prerendered shell.
  const { conversation: requestedConversationId, filter, outcome } = await searchParams;
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const activeFilter = normalizeQueueFilter(filter);
  const rpc = auth ? messagingRpc(auth.supabase) : null;

  const summary = rpc
    ? ((await rpc('get_my_handoff_queue_summary', { target_location_id: workspace.locationId }))
        .data?.[0] ?? null)
    : null;
  const queue = rpc
    ? sortQueueRows(
        (
          await rpc('get_my_handoff_queue', {
            target_filter: activeFilter,
            target_limit: QUEUE_LIMIT,
            target_location_id: workspace.locationId,
          })
        ).data ?? [],
      )
    : [];

  let selected: HandoffQueueRow | null =
    queue.find((row) => row.conversation_id === requestedConversationId) ?? queue[0] ?? null;
  // An action can move a conversation out of the active filter. Keep its detail readable instead
  // of silently jumping the operator to an unrelated row.
  if (rpc && requestedConversationId && selected?.conversation_id !== requestedConversationId) {
    const fallback = (
      await rpc('get_my_handoff_queue', {
        target_filter: 'all_active',
        target_limit: 200,
        target_location_id: workspace.locationId,
      })
    ).data;
    selected =
      fallback?.find((row) => row.conversation_id === requestedConversationId) ?? selected ?? null;
  }

  const messages =
    rpc && selected
      ? ((await rpc('get_my_inbox_messages', { target_conversation_id: selected.conversation_id }))
          .data ?? [])
      : [];
  const history =
    rpc && selected
      ? ((
          await rpc('get_my_conversation_handoff_history', {
            target_conversation_id: selected.conversation_id,
            target_limit: HISTORY_LIMIT,
          })
        ).data ?? [])
      : [];

  const now = Date.now();
  // Owner/admin recovery is offered in the UI only because the server already permits it.
  const viewer = operatorViewerFromRole(workspace.role);
  const actions = selected ? operatorActions(selected, viewer) : null;
  const detailWaiting = selected
    ? deriveCustomerWaiting(messages)
    : { since: null, waiting: false };
  const detailWaitingFor = formatWaitingDuration(detailWaiting.since, now);
  const outcomeMessage = outcome ? (QUEUE_ACTION_MESSAGES[outcome] ?? null) : null;

  function filterHref(value: string): string {
    const params = new URLSearchParams();
    if (value !== 'all_active') params.set('filter', value);
    if (selected) params.set('conversation', selected.conversation_id);
    const query = params.toString();
    return query ? `/dashboard/inbox?${query}` : '/dashboard/inbox';
  }

  function rowHref(conversationId: string): string {
    const params = new URLSearchParams({ conversation: conversationId });
    if (activeFilter !== 'all_active') params.set('filter', activeFilter);
    return `/dashboard/inbox?${params.toString()}`;
  }

  return (
    <section className="max-w-6xl">
      <QueueAutoRefresh />
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Inbox
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        Operator queue
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
        AI answers when it can and asks for a person when it should. Claiming a handoff pauses
        automation for that customer; resolving it ends the escalation but leaves automation paused
        until you explicitly resume AI.
      </p>

      <dl className="mt-6 grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Needs attention', value: summary?.needs_attention ?? 0 },
          { label: 'Urgent', value: summary?.urgent ?? 0 },
          { label: 'Assigned to you', value: summary?.assigned_to_me ?? 0 },
        ].map((tile) => (
          <div className="rounded-xl border border-border bg-white px-4 py-3" key={tile.label}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {tile.label}
            </dt>
            <dd className="mt-1 font-display text-2xl font-semibold text-ink">{tile.value}</dd>
          </div>
        ))}
      </dl>

      <nav aria-label="Queue filters" className="mt-6 flex flex-wrap gap-2">
        {QUEUE_FILTERS.map((option) => (
          <Link
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              activeFilter === option.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-ink'
            }`}
            href={filterHref(option.value)}
            key={option.value}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      {outcomeMessage ? (
        <p
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="status"
        >
          {outcomeMessage}
        </p>
      ) : null}

      <div className="mt-6 grid overflow-hidden rounded-2xl border border-border bg-white shadow-sm lg:grid-cols-[22rem_1fr]">
        <aside className="border-b border-border lg:border-r lg:border-b-0">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold text-ink">
            {QUEUE_FILTERS.find((option) => option.value === activeFilter)?.label}
          </div>
          {queue.length ? (
            <ul className="divide-y divide-border">
              {queue.map((row) => (
                <li key={row.conversation_id}>
                  <Link
                    className={`block px-4 py-3 transition hover:bg-muted/60 ${
                      selected?.conversation_id === row.conversation_id ? 'bg-muted/70' : ''
                    }`}
                    href={rowHref(row.conversation_id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-ink">
                        {conversationTitle(row)}
                      </p>
                      <Badge tone="neutral">{row.channel_type}</Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {row.handoff_is_active && row.handoff_urgency === 'urgent' ? (
                        <Badge tone="urgent">Urgent</Badge>
                      ) : null}
                      {row.handoff_is_active ? <Badge tone="owner">Needs human</Badge> : null}
                      {row.customer_waiting ? (
                        <Badge tone="waiting">
                          Waiting {formatWaitingDuration(row.waiting_since, now) ?? ''}
                        </Badge>
                      ) : null}
                      {row.lead_status ? (
                        <Badge tone="lead">{leadLabel(row.lead_status)}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {row.latest_body ?? 'No text message'}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {assigneeLabel(
                        row.handoff_is_active
                          ? row.handoff_assigned_to_me
                          : row.conversation_assigned_to_me,
                        row.handoff_is_active
                          ? row.handoff_assigned_name
                          : row.conversation_assigned_name,
                      ) ?? (row.ai_mode === 'ai' ? 'AI active' : 'Unassigned')}
                      {' · '}
                      {timestamp(row.latest_at)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-4 text-sm leading-6 text-muted-foreground">
              Nothing in this view for the current location.
            </p>
          )}
        </aside>

        <div className="min-h-[31rem] p-5 sm:p-6">
          {selected && actions ? (
            <>
              <header className="border-b border-border pb-5">
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                      {selected.channel_type === 'phone' ? (
                        <PhoneCall aria-hidden="true" className="size-4 text-primary" />
                      ) : (
                        <UserRound aria-hidden="true" className="size-4 text-primary" />
                      )}
                      {conversationTitle(selected)}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selected.channel_type} ·{' '}
                      {selected.ai_mode === 'ai' ? 'AI active' : 'Automation paused'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {actions.canClaim ? (
                      <form action={claimHandoffAction}>
                        <input name="handoffId" type="hidden" value={selected.handoff_id ?? ''} />
                        <input
                          name="conversationId"
                          type="hidden"
                          value={selected.conversation_id}
                        />
                        <button
                          className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90"
                          type="submit"
                        >
                          Claim
                        </button>
                      </form>
                    ) : null}
                    {actions.canRelease ? (
                      <form action={releaseHandoffAction}>
                        <input name="handoffId" type="hidden" value={selected.handoff_id ?? ''} />
                        <input
                          name="conversationId"
                          type="hidden"
                          value={selected.conversation_id}
                        />
                        <button
                          className="rounded-md border border-border px-3 py-2 text-xs font-semibold text-ink transition hover:bg-muted"
                          type="submit"
                        >
                          Release
                        </button>
                      </form>
                    ) : null}
                    {actions.canResolve ? (
                      <form action={resolveHandoffAction}>
                        <input name="handoffId" type="hidden" value={selected.handoff_id ?? ''} />
                        <input
                          name="conversationId"
                          type="hidden"
                          value={selected.conversation_id}
                        />
                        <button
                          className="rounded-md bg-ink px-3 py-2 text-xs font-semibold text-white transition hover:bg-ink/90"
                          type="submit"
                        >
                          Resolve handoff
                        </button>
                      </form>
                    ) : null}
                    {actions.canResumeAi ? (
                      <form action={resumeConversationAction}>
                        <input
                          name="conversationId"
                          type="hidden"
                          value={selected.conversation_id}
                        />
                        <button
                          className="rounded-md border border-border px-3 py-2 text-xs font-semibold text-ink transition hover:bg-muted"
                          type="submit"
                        >
                          Resume AI
                        </button>
                      </form>
                    ) : null}
                    {actions.canTakeOver ? (
                      <form action={takeOverConversationAction}>
                        <input
                          name="conversationId"
                          type="hidden"
                          value={selected.conversation_id}
                        />
                        <button
                          className="rounded-md border border-border px-3 py-2 text-xs font-semibold text-ink transition hover:bg-muted"
                          type="submit"
                        >
                          Take over
                        </button>
                      </form>
                    ) : null}
                  </div>
                </div>

                {selected.handoff_is_active ? (
                  <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <TriangleAlert aria-hidden="true" className="size-4 text-amber-900" />
                      <span className="text-sm font-semibold text-amber-900">
                        Needs human attention
                      </span>
                      <Badge tone={selected.handoff_urgency === 'urgent' ? 'urgent' : 'neutral'}>
                        {selected.handoff_urgency === 'urgent' ? 'Urgent' : 'Normal'}
                      </Badge>
                      {selected.handoff_source === 'voice' ? (
                        <Badge tone="neutral">Voice</Badge>
                      ) : null}
                      {selected.handoff_call_status ? (
                        <Badge tone="neutral">Call {selected.handoff_call_status}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm text-amber-900">{selected.handoff_reason}</p>
                    <p className="mt-2 text-xs text-amber-900/80">
                      {assigneeLabel(
                        selected.handoff_assigned_to_me,
                        selected.handoff_assigned_name,
                      ) ?? 'Unassigned'}
                      {selected.handoff_created_at
                        ? ` · Requested ${timestamp(selected.handoff_created_at)}`
                        : ''}
                      {detailWaitingFor ? ` · Customer waiting ${detailWaitingFor}` : ''}
                    </p>
                    {actions.ownedByOther ? (
                      <p className="mt-2 text-xs font-semibold text-amber-900">
                        {viewer.canOverrideOwnership
                          ? 'A teammate owns this handoff. Release it to hand the work back to the queue.'
                          : 'Read only while a teammate owns this handoff.'}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {!selected.handoff_is_active && actions.ownedByOther ? (
                  <p className="mt-4 rounded-xl border border-border bg-muted/50 p-3 text-xs font-semibold text-muted-foreground">
                    {assigneeLabel(false, selected.conversation_assigned_name) ??
                      'Owned by a teammate'}{' '}
                    · {viewer.canOverrideOwnership ? 'recovery available' : 'read only'}
                  </p>
                ) : null}
              </header>

              <ol aria-label="Messages" className="mt-5 space-y-3">
                {messages.map((message) => (
                  <li
                    className={message.direction === 'inbound' ? 'mr-10' : 'ml-10'}
                    key={message.message_id}
                  >
                    <article
                      className={
                        message.direction === 'inbound'
                          ? 'rounded-xl bg-muted px-4 py-3 text-sm text-ink'
                          : 'rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground'
                      }
                    >
                      <p>{message.body ?? 'Media message'}</p>
                      <p
                        className={
                          message.direction === 'inbound'
                            ? 'mt-2 text-[11px] text-muted-foreground'
                            : 'mt-2 text-[11px] text-primary-foreground/75'
                        }
                      >
                        {message.author_type} · {timestamp(message.created_at)}
                        {message.delivery_status ? ` · ${message.delivery_status}` : ''}
                      </p>
                    </article>
                  </li>
                ))}
              </ol>

              {history.length ? (
                <section className="mt-6 border-t border-border pt-5">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Handoff history
                  </h2>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {history.map((episode) => (
                      <li key={episode.handoff_id}>
                        <span className="font-semibold text-ink">
                          {episode.handoff_source === 'voice' ? 'Voice' : 'Message'} ·{' '}
                          {episode.handoff_urgency === 'urgent' ? 'Urgent' : 'Normal'}
                        </span>{' '}
                        requested {timestamp(episode.requested_at)}
                        {episode.first_acknowledged_at
                          ? ` · acknowledged ${timestamp(episode.first_acknowledged_at)}`
                          : ''}
                        {episode.resolved_at
                          ? ` · resolved ${timestamp(episode.resolved_at)}`
                          : ' · still open'}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {actions.canReply ? (
                <form action={sendHumanReplyAction} className="mt-6 border-t border-border pt-5">
                  <input name="conversationId" type="hidden" value={selected.conversation_id} />
                  <label className="sr-only" htmlFor="inbox-reply">
                    Reply
                  </label>
                  <textarea
                    className="min-h-24 w-full rounded-lg border border-border bg-white p-3 text-sm text-ink outline-none ring-primary transition focus:ring-2"
                    id="inbox-reply"
                    maxLength={2000}
                    name="body"
                    placeholder="Write a human reply…"
                    required
                  />
                  <button
                    className="mt-3 inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-ink/90"
                    type="submit"
                  >
                    <MessageCircleMore aria-hidden="true" className="size-4" /> Send reply
                  </button>
                </form>
              ) : (
                <p className="mt-6 border-t border-border pt-5 text-sm text-muted-foreground">
                  {selected.channel_type === 'phone'
                    ? 'Phone conversations are shown for operational context. Claiming a voice handoff takes ownership of the follow-up; it does not move the live call.'
                    : 'Claim this handoff to reply as a human.'}
                </p>
              )}
            </>
          ) : (
            <div className="flex min-h-[24rem] items-center justify-center text-center text-sm leading-6 text-muted-foreground">
              Nothing needs a person here right now.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
