'use client';

import Link from 'next/link';
import { useReducer, useTransition, type FormEvent } from 'react';

import type { CustomerDirectoryRow } from '@avenlyo/database';

import { Button } from '@/components/ui/button';
import { formatActivityDate } from '@/lib/customers/presentation';
import {
  initialSearchState,
  isSearchActive,
  searchReducer,
  searchRequest,
  type SearchCursor,
} from '@/lib/customers/search-state';

import { searchCustomersAction } from './actions';

/**
 * The customer directory, in one place.
 *
 * The list lives here rather than in the page so there is a single presentation: when a search is
 * active its results replace the directory instead of appearing above it. Rendering both at once
 * showed matches on top of every other customer, which reads as if the search had failed.
 *
 * Every prop crossing from the server is plain data. The search term is not one of them: it is
 * typed here, submitted in a server-action payload, and never written to a URL or to storage,
 * because search matches phone and email.
 */
export interface CustomerDirectoryProps {
  readonly customers: readonly CustomerDirectoryRow[];
  readonly locationName: string;
  readonly nextCursor: SearchCursor | null;
}

function CustomerCard({ customer }: { readonly customer: CustomerDirectoryRow }) {
  return (
    <li>
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
            <p>Last activity {formatActivityDate(customer.last_activity_at)}</p>
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
  );
}

export function CustomerDirectory({ customers, locationName, nextCursor }: CustomerDirectoryProps) {
  const [state, dispatch] = useReducer(searchReducer, initialSearchState);
  const [pending, startTransition] = useTransition();

  /**
   * Builds the request from submitted state only, so an unsubmitted edit to the field cannot
   * change which predicate "Show more results" continues.
   */
  function send(mode: 'more' | 'submit') {
    const request = searchRequest(state, mode);
    if (!request) return;

    const payload = new FormData();
    payload.set('term', request.term);
    if (request.cursor) {
      payload.set('cursorAt', request.cursor.timestamp);
      payload.set('cursorId', request.cursor.identifier);
    }

    startTransition(async () => {
      const next = await searchCustomersAction(payload);
      dispatch({
        append: mode === 'more',
        customers: next.customers,
        cursor: next.nextCursor,
        status: next.status,
        // The term travels with its own response, so a slow reply cannot overwrite a newer search.
        term: request.term,
        type: 'result',
      });
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    dispatch({ type: 'submit' });
    send('submit');
  }

  const searching = isSearchActive(state);

  return (
    <div>
      <form className="mt-6 flex gap-2" onSubmit={submit} role="search">
        <label className="sr-only" htmlFor="customer-search">
          Search customers by name, phone, or email
        </label>
        <input
          autoComplete="off"
          className="avenlyo-input w-full"
          id="customer-search"
          maxLength={120}
          name="term"
          onChange={(event) => dispatch({ type: 'draft', value: event.target.value })}
          placeholder="Search by name, phone, or email"
          type="search"
          value={state.draftTerm}
        />
        <Button disabled={pending} type="submit" variant="outline">
          {pending ? 'Searching…' : 'Search'}
        </Button>
        {searching ? (
          <Button onClick={() => dispatch({ type: 'clear' })} type="button" variant="outline">
            Clear
          </Button>
        ) : null}
      </form>

      {/* One view at a time: a search replaces the directory rather than sitting on top of it. */}
      {searching ? (
        <div aria-live="polite" className="mt-6" data-testid="customer-search-results">
          {state.status === 'error' ? (
            <p className="rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
              That search could not be completed.
            </p>
          ) : null}
          {state.status === 'empty' ? (
            <p className="rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
              No customers match that search at this location.
            </p>
          ) : null}
          {state.customers.length > 0 ? (
            <>
              <ul className="space-y-3">
                {state.customers.map((customer) => (
                  <CustomerCard customer={customer} key={customer.contact_id} />
                ))}
              </ul>
              {/* Paging a search stays in the action payload and continues the submitted term. */}
              {state.cursor ? (
                <Button
                  className="mt-3"
                  disabled={pending}
                  onClick={() => send('more')}
                  type="button"
                  variant="outline"
                >
                  {pending ? 'Loading…' : 'Show more results'}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <div data-testid="customer-directory">
          {customers.length === 0 ? (
            <p className="mt-8 rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
              No customers have interacted with {locationName} yet.
            </p>
          ) : (
            <ul className="mt-6 space-y-3" data-testid="customer-list">
              {customers.map((customer) => (
                <CustomerCard customer={customer} key={customer.contact_id} />
              ))}
            </ul>
          )}

          {/* The unsearched directory keeps a linkable cursor: a timestamp and a UUID are not
              customer content, so paging it in the URL is safe. */}
          {nextCursor ? (
            <Link
              className="mt-6 inline-flex text-sm font-semibold text-primary hover:underline"
              href={{
                pathname: '/dashboard/customers',
                query: { after: nextCursor.timestamp, afterId: nextCursor.identifier },
              }}
            >
              Show older customers
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}
