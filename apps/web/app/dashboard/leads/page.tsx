import Link from 'next/link';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { leadsRpc } from '@/lib/leads/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

const statuses = ['new', 'qualified', 'converted'] as const;
const sources = ['voice', 'sms', 'web'] as const;
const urgencies = ['routine', 'soon', 'urgent', 'unknown'] as const;

function scalar(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function timestamp(value: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function FilterLink({
  filters,
  label,
  name,
  value,
}: {
  readonly filters: Readonly<Record<string, string | null>>;
  readonly label: string;
  readonly name: string;
  readonly value: string;
}) {
  const params = new URLSearchParams(
    Object.entries(filters).flatMap(([key, current]) => (current ? [[key, current]] : [])),
  );
  if (params.get(name) === value) params.delete(name);
  else params.set(name, value);
  return (
    <Link
      className={`rounded-full px-3 py-1 text-xs font-semibold ${filters[name] === value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-ink'}`}
      href={`/dashboard/leads?${params.toString()}`}
    >
      {label}
    </Link>
  );
}

export default async function LeadsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = await searchParams;
  const status = scalar(filters.status);
  const source = scalar(filters.source);
  const urgency = scalar(filters.urgency);
  const selectedFilters = { source, status, urgency };
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const leads = auth
    ? ((
        await leadsRpc(auth.supabase)('get_my_leads', {
          target_location_id: workspace.locationId,
          target_source_channel: sources.includes(source as (typeof sources)[number])
            ? source
            : null,
          target_status: statuses.includes(status as (typeof statuses)[number]) ? status : null,
          target_urgency: urgencies.includes(urgency as (typeof urgencies)[number])
            ? urgency
            : null,
        })
      ).data ?? [])
    : [];
  return (
    <section className="max-w-6xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Leads
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        Service interest, safely captured
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
        Leads are created from trusted customer turns and become converted only after a durable
        booking is persisted.
      </p>
      <div className="mt-6 space-y-3" aria-label="Lead filters">
        <div className="flex flex-wrap gap-2">
          <span className="mr-1 py-1 text-xs font-semibold text-muted-foreground">Status</span>
          {statuses.map((value) => (
            <FilterLink
              key={value}
              filters={selectedFilters}
              label={value}
              name="status"
              value={value}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="mr-1 py-1 text-xs font-semibold text-muted-foreground">Source</span>
          {sources.map((value) => (
            <FilterLink
              key={value}
              filters={selectedFilters}
              label={value}
              name="source"
              value={value}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="mr-1 py-1 text-xs font-semibold text-muted-foreground">Urgency</span>
          {urgencies.map((value) => (
            <FilterLink
              key={value}
              filters={selectedFilters}
              label={value}
              name="urgency"
              value={value}
            />
          ))}
        </div>
      </div>
      <section className="mt-8 overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
        {leads.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Interest</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Urgency</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Captured</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leads.map((lead) => (
                  <tr key={lead.lead_id}>
                    <td className="px-4 py-3 font-medium text-ink">
                      <Link
                        className="hover:text-primary hover:underline"
                        href={`/dashboard/leads/${lead.lead_id}`}
                      >
                        {lead.customer_name ?? 'Customer'}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {lead.service_category ?? 'Needs category'} ·{' '}
                      {lead.customer_goal ?? 'Needs goal'}
                    </td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">
                      {lead.source_channel ?? 'unknown'}
                    </td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">{lead.urgency}</td>
                    <td className="px-4 py-3 capitalize text-ink">{lead.status}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {timestamp(lead.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-6 text-sm leading-6 text-muted-foreground">
            No leads match these filters for this location.
          </p>
        )}
      </section>
    </section>
  );
}
