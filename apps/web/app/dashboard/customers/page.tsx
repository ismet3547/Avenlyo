import { safePageCursor } from '@/lib/customers/input';
import { loadCustomerDirectory } from '@/lib/customers/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

import { CustomerDirectory } from './customer-directory';

/**
 * Customer directory.
 *
 * Everyone listed here has durable production activity at the selected location. A contact that
 * belongs to the organization but has never interacted with this location does not appear, and
 * every count shown is this location's, never the organization's total.
 *
 * The page fetches the unsearched page and hands it to the client component as plain data. Every
 * prop crossing this boundary is serializable: a formatter would not be, and making one a Server
 * Action to satisfy the boundary would put a round trip behind rendering a date.
 */
interface CustomersPageProps {
  // No search parameter: a customer search term matches phone and email, so it never travels in a
  // URL. The search interaction is a server action instead.
  readonly searchParams: Promise<{ after?: string; afterId?: string }>;
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

  // A malformed or partial cursor restarts paging rather than reaching the database.
  const cursor = safePageCursor(params.after, params.afterId);

  const page = await loadCustomerDirectory(auth.supabase, {
    cursor: cursor ? { contactId: cursor.identifier, lastActivityAt: cursor.timestamp } : null,
    locationId: workspace.locationId,
    search: null,
  });

  const locationName = workspace.locationName ?? 'this location';

  return (
    <section className="max-w-5xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Dashboard
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Customers
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        People who have contacted {locationName}. Activity shown is for this location only.
      </p>

      <CustomerDirectory
        customers={page.customers}
        locationName={locationName}
        nextCursor={
          page.nextCursor
            ? { identifier: page.nextCursor.contactId, timestamp: page.nextCursor.lastActivityAt }
            : null
        }
      />
    </section>
  );
}
