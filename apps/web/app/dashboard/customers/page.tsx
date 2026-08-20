import Link from 'next/link';

import { loadCustomerDirectory } from '@/lib/customers/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

import { CustomerSearch } from './customer-search';

/**
 * Customer directory.
 *
 * Everyone listed here has durable production activity at the selected location. A contact that
 * belongs to the organization but has never interacted with this location does not appear, and
 * every count shown is this location's, never the organization's total.
 */
interface CustomersPageProps {
  readonly searchParams: Promise<{ after?: string; afterId?: string; q?: string }>;
}

function formatDate(value: string | null): string {
  if (!value) return 'No activity';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(value),
  );
}

export default async function CustomersPage({ searchParams }: CustomersPageProps) {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const params = await searchParams;

  if (!auth || !workspace.locationId) {
    return (
      <section className="max-w-4xl">
        <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
          Customers
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Choose a location to see the people who have contacted it.
        </p>
      </section>
    );
  }

  const search =
    typeof params.q === 'string' && params.q.trim().length >= 2 ? params.q.trim() : null;
  const cursor =
    params.after && params.afterId
      ? { contactId: params.afterId, lastActivityAt: params.after }
      : null;

  const page = await loadCustomerDirectory(auth.supabase, {
    cursor,
    locationId: workspace.locationId,
    search,
  });

  return (
    <section className="max-w-5xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Dashboard
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Customers
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        People who have contacted {workspace.locationName ?? 'this location'}. Activity shown is for
        this location only.
      </p>

      <CustomerSearch initialValue={search ?? ''} />

      {page.customers.length === 0 ? (
        <p className="mt-8 rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
          {search
            ? 'No customers match that search at this location.'
            : 'No customers have interacted with this location yet.'}
        </p>
      ) : (
        <ul className="mt-6 space-y-3" data-testid="customer-list">
          {page.customers.map((customer) => (
            <li key={customer.contact_id}>
              <Link
                className="block rounded-xl border border-border bg-white p-5 transition-colors hover:border-primary"
                href={`/dashboard/customers/${customer.contact_id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{customer.display_name}</p>
                    {/* Phone and email are shown only to staff who hold access to this location. */}
                    {customer.phone ? (
                      <p className="text-xs text-muted-foreground">{customer.phone}</p>
                    ) : null}
                    {customer.email ? (
                      <p className="text-xs text-muted-foreground">{customer.email}</p>
                    ) : null}
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p>Last activity {formatDate(customer.last_activity_at)}</p>
                    <p className="mt-1">
                      {customer.conversation_count} conversations · {customer.call_count} calls ·{' '}
                      {customer.appointment_count} appointments
                    </p>
                  </div>
                </div>
                {customer.lead_status || customer.sms_opted_out ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {customer.lead_status ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-ink">
                        Lead: {customer.lead_status}
                      </span>
                    ) : null}
                    {customer.sms_opted_out ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-950">
                        SMS opted out
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {page.nextCursor ? (
        <Link
          className="mt-6 inline-flex text-sm font-semibold text-primary hover:underline"
          href={{
            pathname: '/dashboard/customers',
            query: {
              after: page.nextCursor.lastActivityAt,
              afterId: page.nextCursor.contactId,
              ...(search ? { q: search } : {}),
            },
          }}
        >
          Show older customers
        </Link>
      ) : null}
    </section>
  );
}
