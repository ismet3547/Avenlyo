import Link from 'next/link';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { leadsRpc } from '@/lib/leads/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

function timestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}

export default async function LeadDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  await requireCompletedWorkspace();
  const { id } = await params;
  const auth = await getRequiredAuthContext();
  const lead = auth
    ? (await leadsRpc(auth.supabase)('get_my_lead_detail', { target_lead_id: id })).data?.[0]
    : null;
  if (!lead)
    return (
      <section>
        <h1 className="font-display text-3xl font-semibold text-ink">Lead unavailable</h1>
        <Link
          className="mt-4 inline-flex text-sm font-semibold text-primary hover:underline"
          href="/dashboard/leads"
        >
          Back to leads
        </Link>
      </section>
    );
  const customerName =
    typeof lead.details.customer_name === 'string' ? lead.details.customer_name : 'Customer';
  const conversationHref = lead.conversation_id
    ? `/dashboard/inbox?conversation=${encodeURIComponent(lead.conversation_id)}`
    : null;
  return (
    <section className="max-w-3xl">
      <Link className="text-sm font-semibold text-primary hover:underline" href="/dashboard/leads">
        ← Back to leads
      </Link>
      <p className="mt-7 font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Lead detail
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        {customerName}
      </h1>
      {conversationHref ? (
        <Link
          className="mt-3 inline-flex text-sm font-semibold text-primary hover:underline"
          href={conversationHref}
        >
          View related conversation
        </Link>
      ) : null}
      <dl className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2">
        {[
          ['Status', lead.status],
          ['Service', lead.service_category ?? 'Not captured'],
          ['Goal', lead.customer_goal ?? 'Not captured'],
          ['Urgency', lead.urgency],
          ['Source', lead.source_channel ?? 'Unknown'],
          ['Qualification', lead.qualification_reason ?? 'Pending'],
        ].map(([label, value]) => (
          <div className="bg-white p-4" key={label}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {label}
            </dt>
            <dd className="mt-1 capitalize text-sm font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <section className="mt-6 rounded-2xl border border-border bg-white p-5">
        <h2 className="font-semibold text-ink">Captured details</h2>
        <dl className="mt-4 space-y-3 text-sm">
          {Object.entries(lead.details).map(([key, value]) => (
            <div className="flex justify-between gap-6" key={key}>
              <dt className="capitalize text-muted-foreground">{key.replaceAll('_', ' ')}</dt>
              <dd className="text-right text-ink">{typeof value === 'string' ? value : '—'}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="mt-6 rounded-2xl border border-border bg-white p-5">
        <h2 className="font-semibold text-ink">Lifecycle</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          {[
            ['Created', timestamp(lead.created_at, lead.location_timezone)],
            [
              'Qualified',
              lead.qualified_at
                ? timestamp(lead.qualified_at, lead.location_timezone)
                : 'Not qualified',
            ],
            [
              'Converted',
              lead.converted_at
                ? timestamp(lead.converted_at, lead.location_timezone)
                : 'Not converted',
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </dt>
              <dd className="mt-1 text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        {lead.conversion_appointment_starts_at && lead.conversion_appointment_status ? (
          <div className="mt-5 border-t border-border pt-4 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Converted appointment
            </p>
            <p className="mt-1 font-medium text-ink">
              {timestamp(lead.conversion_appointment_starts_at, lead.location_timezone)}
            </p>
            <p className="mt-1 capitalize text-muted-foreground">
              {lead.conversion_appointment_status}
            </p>
          </div>
        ) : null}
      </section>
    </section>
  );
}
