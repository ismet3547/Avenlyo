import Link from 'next/link';

import {
  appointmentStatusLabel,
  callDurationMinutes,
  callStatusLabel,
  channelLabel,
  conversationStatusLabel,
  leadStatusLabel,
  timelineEventLabel,
} from '@/lib/customers/presentation';
import { loadCustomerOverview, loadCustomerTimeline } from '@/lib/customers/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

/**
 * Customer 360.
 *
 * Deterministic database truth for one person at one location. No summary is generated, no status
 * is invented, and nothing on this page mutates anything: it is a read of records other phases own.
 */
interface CustomerPageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ after?: string; afterId?: string; afterKind?: string }>;
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Not recorded';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function Unavailable() {
  return (
    <section className="max-w-3xl">
      <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Customer unavailable
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        This customer is not available at the selected location.
      </p>
      <Link
        className="mt-6 inline-flex text-sm font-semibold text-primary hover:underline"
        href="/dashboard/customers"
      >
        Back to customers
      </Link>
    </section>
  );
}

export default async function CustomerDetailPage({ params, searchParams }: CustomerPageProps) {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const { id } = await params;
  const query = await searchParams;

  if (!auth || !workspace.locationId) return <Unavailable />;

  const overview = await loadCustomerOverview(auth.supabase, {
    contactId: id,
    locationId: workspace.locationId,
  });

  // A guessed identifier, a customer from another organization, and one with no activity here all
  // land in exactly the same place. Nothing distinguishes them.
  if (!overview) return <Unavailable />;

  const cursor =
    query.after && query.afterId && query.afterKind
      ? { eventAt: query.after, eventId: query.afterId, eventKind: query.afterKind }
      : null;
  const timeline = await loadCustomerTimeline(auth.supabase, {
    contactId: id,
    cursor,
    locationId: workspace.locationId,
  });

  return (
    <section className="max-w-4xl">
      <Link
        className="text-sm font-semibold text-primary hover:underline"
        href="/dashboard/customers"
      >
        ← Customers
      </Link>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        {overview.display_name}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Activity at {workspace.locationName ?? 'this location'}
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <dl className="rounded-xl border border-border bg-white p-5 text-sm">
          <h2 className="font-display text-base font-semibold text-ink">Identity</h2>
          {overview.phone ? (
            <div className="mt-3 flex justify-between gap-4">
              <dt className="text-muted-foreground">Phone</dt>
              <dd className="font-medium text-ink">{overview.phone}</dd>
            </div>
          ) : null}
          {overview.email ? (
            <div className="mt-2 flex justify-between gap-4">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="font-medium text-ink">{overview.email}</dd>
            </div>
          ) : null}
          <div className="mt-2 flex justify-between gap-4">
            <dt className="text-muted-foreground">First seen</dt>
            <dd className="font-medium text-ink">{formatDateTime(overview.first_activity_at)}</dd>
          </div>
          <div className="mt-2 flex justify-between gap-4">
            <dt className="text-muted-foreground">Last activity</dt>
            <dd className="font-medium text-ink">{formatDateTime(overview.last_activity_at)}</dd>
          </div>
          {/* Consent comes from its own durable record, never inferred from having a phone. */}
          {overview.sms_opted_out ? (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950">
              This customer opted out of SMS on {formatDateTime(overview.sms_opted_out_at)}.
            </p>
          ) : null}
        </dl>

        <dl className="rounded-xl border border-border bg-white p-5 text-sm">
          <h2 className="font-display text-base font-semibold text-ink">
            Activity at this location
          </h2>
          <div className="mt-3 flex justify-between gap-4">
            <dt className="text-muted-foreground">Conversations</dt>
            <dd className="font-medium text-ink">{overview.conversation_count}</dd>
          </div>
          <div className="mt-2 flex justify-between gap-4">
            <dt className="text-muted-foreground">Calls</dt>
            <dd className="font-medium text-ink">{overview.call_count}</dd>
          </div>
          <div className="mt-2 flex justify-between gap-4">
            <dt className="text-muted-foreground">Appointments</dt>
            <dd className="font-medium text-ink">{overview.appointment_count}</dd>
          </div>
          {overview.active_handoff_count > 0 ? (
            <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-950">
              {overview.active_handoff_count} conversation
              {overview.active_handoff_count === 1 ? '' : 's'} waiting for a teammate. Handle them
              in the{' '}
              <Link className="font-semibold underline" href="/dashboard/inbox">
                Inbox
              </Link>
              .
            </p>
          ) : null}
        </dl>
      </div>

      {overview.next_appointment_id || overview.recent_appointment_id || overview.lead_id ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {overview.next_appointment_id ? (
            <div className="rounded-xl border border-border bg-white p-5 text-sm">
              <h2 className="font-display text-base font-semibold text-ink">Next appointment</h2>
              <p className="mt-2 font-medium text-ink">{overview.next_appointment_title}</p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(overview.next_appointment_starts_at)} ·{' '}
                {appointmentStatusLabel(overview.next_appointment_status)}
              </p>
            </div>
          ) : overview.recent_appointment_id ? (
            <div className="rounded-xl border border-border bg-white p-5 text-sm">
              <h2 className="font-display text-base font-semibold text-ink">
                Most recent appointment
              </h2>
              <p className="mt-2 font-medium text-ink">{overview.recent_appointment_title}</p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(overview.recent_appointment_starts_at)} ·{' '}
                {appointmentStatusLabel(overview.recent_appointment_status)}
              </p>
            </div>
          ) : null}

          {overview.lead_id ? (
            <div className="rounded-xl border border-border bg-white p-5 text-sm">
              <h2 className="font-display text-base font-semibold text-ink">Lead</h2>
              <p className="mt-2 font-medium text-ink">{leadStatusLabel(overview.lead_status)}</p>
              {/* Links to the Phase 10 lead surface, which owns lead state. Nothing here edits it. */}
              <Link
                className="mt-2 inline-flex text-xs font-semibold text-primary hover:underline"
                href={`/dashboard/leads/${overview.lead_id}`}
              >
                Open lead
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      <h2 className="mt-8 font-display text-lg font-semibold text-ink">Activity</h2>
      {timeline.events.length === 0 ? (
        <p className="mt-3 rounded-xl border border-border bg-white p-5 text-sm text-muted-foreground">
          No recorded activity at this location yet.
        </p>
      ) : (
        <ol className="mt-3 space-y-3" data-testid="customer-timeline">
          {timeline.events.map((event) => (
            <li
              className="rounded-xl border border-border bg-white p-5 text-sm"
              key={`${event.event_kind}:${event.event_id}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                    {timelineEventLabel(event.event_kind)}
                  </p>
                  <p className="mt-1 font-medium text-ink">
                    {event.event_kind === 'conversation'
                      ? `${channelLabel(event.channel)} · ${conversationStatusLabel(event.status)}`
                      : null}
                    {event.event_kind === 'call'
                      ? `${callStatusLabel(event.status)}${
                          callDurationMinutes(event.event_at, event.ends_at)
                            ? ` · ${callDurationMinutes(event.event_at, event.ends_at)} min`
                            : ''
                        }`
                      : null}
                    {event.event_kind === 'appointment'
                      ? `${event.title} · ${appointmentStatusLabel(event.status)}`
                      : null}
                    {event.event_kind === 'lead' ? leadStatusLabel(event.status) : null}
                    {event.event_kind === 'handoff'
                      ? `${event.status === 'resolved' ? 'Resolved' : 'Waiting for a teammate'}${
                          event.detail === 'urgent' ? ' · Urgent' : ''
                        }`
                      : null}
                  </p>
                  {event.event_kind === 'conversation' && event.message_count !== null ? (
                    <p className="text-xs text-muted-foreground">
                      {event.message_count} message{event.message_count === 1 ? '' : 's'}
                    </p>
                  ) : null}
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">{formatDateTime(event.event_at)}</p>
                  {event.conversation_id ? (
                    <Link
                      className="mt-1 inline-flex text-xs font-semibold text-primary hover:underline"
                      href={`/dashboard/conversations/${event.conversation_id}`}
                    >
                      Open conversation
                    </Link>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {timeline.nextCursor ? (
        <Link
          className="mt-5 inline-flex text-sm font-semibold text-primary hover:underline"
          href={{
            pathname: `/dashboard/customers/${id}`,
            query: {
              after: timeline.nextCursor.eventAt,
              afterId: timeline.nextCursor.eventId,
              afterKind: timeline.nextCursor.eventKind,
            },
          }}
        >
          Show older activity
        </Link>
      ) : null}
    </section>
  );
}
