import { MessageCircleMore, UserRound } from 'lucide-react';

import {
  resumeConversationAction,
  sendHumanReplyAction,
  takeOverConversationAction,
} from './actions';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { messagingRpc } from '@/lib/messaging/service';
import { leadsRpc } from '@/lib/leads/service';

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

export default async function InboxPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly conversation?: string }>;
}) {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const { conversation: requestedConversationId } = await searchParams;
  const conversations = auth
    ? ((
        await messagingRpc(auth.supabase)('get_my_inbox_conversations', {
          target_location_id: workspace.locationId,
        })
      ).data ?? [])
    : [];
  const selected =
    conversations.find(
      (conversation) => conversation.conversation_id === requestedConversationId,
    ) ??
    conversations[0] ??
    null;
  const leadIndicators = auth
    ? ((
        await leadsRpc(auth.supabase)('get_my_inbox_lead_indicators', {
          target_location_id: workspace.locationId,
        })
      ).data ?? [])
    : [];
  const leadByConversation = new Map(
    leadIndicators.map((lead) => [lead.conversation_id, lead] as const),
  );
  const messages =
    auth && selected
      ? ((
          await messagingRpc(auth.supabase)('get_my_inbox_messages', {
            target_conversation_id: selected.conversation_id,
          })
        ).data ?? [])
      : [];

  return (
    <section className="max-w-6xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Inbox
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        Customer conversations
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
        One operational inbox for phone, SMS, and web chat. Taking over pauses automation
        immediately; resuming AI waits for the customer&apos;s next message.
      </p>
      <div className="mt-8 grid overflow-hidden rounded-2xl border border-border bg-white shadow-sm lg:grid-cols-[20rem_1fr]">
        <aside className="border-b border-border lg:border-r lg:border-b-0">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold text-ink">
            Recent
          </div>
          {conversations.length ? (
            <ul className="divide-y divide-border">
              {conversations.map((conversation) => (
                <li className="p-4" key={conversation.conversation_id}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-ink">
                      {conversation.contact_name ?? conversation.contact_phone ?? 'Website visitor'}
                    </p>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {conversation.channel_type}
                    </span>
                    {leadByConversation.has(conversation.conversation_id) ? (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        {leadLabel(
                          leadByConversation.get(conversation.conversation_id)!.lead_status,
                        )}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {conversation.latest_body ?? 'No text message'}
                  </p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {timestamp(conversation.latest_at)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-4 text-sm leading-6 text-muted-foreground">
              No customer messages for this location yet.
            </p>
          )}
        </aside>
        <div className="min-h-[31rem] p-5 sm:p-6">
          {selected ? (
            <>
              <header className="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-start">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <UserRound aria-hidden="true" className="size-4 text-primary" />
                    {selected.contact_name ?? selected.contact_phone ?? 'Website visitor'}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selected.channel_type} ·{' '}
                    {selected.ai_mode === 'ai' ? 'AI active' : 'Human takeover'}
                    {selected.handoff_open ? ' · Needs attention' : ''}
                  </p>
                </div>
                <div className="flex gap-2">
                  <form action={takeOverConversationAction}>
                    <input name="conversationId" type="hidden" value={selected.conversation_id} />
                    <button
                      className="rounded-md border border-border px-3 py-2 text-xs font-semibold text-ink transition hover:bg-muted"
                      type="submit"
                    >
                      Take over
                    </button>
                  </form>
                  <form action={resumeConversationAction}>
                    <input name="conversationId" type="hidden" value={selected.conversation_id} />
                    <button
                      className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90"
                      type="submit"
                    >
                      Resume AI
                    </button>
                  </form>
                </div>
              </header>
              <ol className="mt-5 space-y-3" aria-label="Messages">
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
              {selected.channel_type === 'sms' || selected.channel_type === 'web' ? (
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
                  Phone conversations are shown for context. Use the configured calling tools to
                  reply.
                </p>
              )}
            </>
          ) : (
            <div className="flex min-h-[24rem] items-center justify-center text-center text-sm leading-6 text-muted-foreground">
              New SMS and web chat conversations will appear here after they are safely persisted.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
