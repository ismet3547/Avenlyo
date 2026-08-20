'use client';

import Link from 'next/link';
import { useState, useTransition, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import type { CustomerDirectoryRow } from '@avenlyo/database';

import { searchCustomersAction, type CustomerSearchResult } from './actions';

/**
 * Customer search.
 *
 * The term is submitted to a server action rather than pushed into the URL. Search matches phone
 * and email, so a query parameter would place customer PII in the address bar, in history, and in
 * any link the operator copies or shares. Nothing is written to storage either: the term lives in
 * component state for the lifetime of the interaction and nowhere else.
 *
 * Results replace the server-rendered list while a search is active; clearing the field returns to
 * it, so the unsearched directory keeps its normal linkable URL.
 */
export interface CustomerSearchProps {
  readonly formatDate: (value: string | null) => string;
}

function CustomerRow({ customer }: { readonly customer: CustomerDirectoryRow }) {
  return (
    <li>
      <Link
        className="block rounded-xl border border-border bg-white p-5 transition-colors hover:border-primary"
        href={`/dashboard/customers/${customer.contact_id}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-ink">{customer.display_name}</p>
            {customer.phone ? (
              <p className="text-xs text-muted-foreground">{customer.phone}</p>
            ) : null}
            {customer.email ? (
              <p className="text-xs text-muted-foreground">{customer.email}</p>
            ) : null}
          </div>
          <p className="text-right text-xs text-muted-foreground">
            {customer.conversation_count} conversations · {customer.call_count} calls ·{' '}
            {customer.appointment_count} appointments
          </p>
        </div>
      </Link>
    </li>
  );
}

export function CustomerSearch({ formatDate }: CustomerSearchProps) {
  const [term, setTerm] = useState('');
  const [result, setResult] = useState<CustomerSearchResult | null>(null);
  const [pending, startTransition] = useTransition();

  function run(cursor: { identifier: string; timestamp: string } | null, append: boolean) {
    const payload = new FormData();
    payload.set('term', term);
    if (cursor) {
      payload.set('cursorAt', cursor.timestamp);
      payload.set('cursorId', cursor.identifier);
    }
    startTransition(async () => {
      const next = await searchCustomersAction(payload);
      setResult((previous) =>
        append && previous
          ? { ...next, customers: [...previous.customers, ...next.customers] }
          : next,
      );
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (term.trim().length < 2) {
      setResult(null);
      return;
    }
    run(null, false);
  }

  function clear() {
    setTerm('');
    setResult(null);
  }

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
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search by name, phone, or email"
          type="search"
          value={term}
        />
        <Button disabled={pending} type="submit" variant="outline">
          {pending ? 'Searching…' : 'Search'}
        </Button>
        {result ? (
          <Button onClick={clear} type="button" variant="outline">
            Clear
          </Button>
        ) : null}
      </form>

      {result ? (
        <div aria-live="polite" className="mt-6" data-testid="customer-search-results">
          {result.status === 'error' ? (
            <p className="rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
              That search could not be completed.
            </p>
          ) : null}
          {result.status === 'empty' ? (
            <p className="rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
              No customers match that search at this location.
            </p>
          ) : null}
          {result.customers.length > 0 ? (
            <>
              <ul className="space-y-3">
                {result.customers.map((customer) => (
                  <CustomerRow customer={customer} key={customer.contact_id} />
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">
                Last activity {formatDate(result.customers.at(-1)?.last_activity_at ?? null)} or
                newer
              </p>
              {/* Paging a search stays in the action payload, so page two is no less private. */}
              {result.nextCursor ? (
                <Button
                  className="mt-3"
                  disabled={pending}
                  onClick={() => run(result.nextCursor, true)}
                  type="button"
                  variant="outline"
                >
                  {pending ? 'Loading…' : 'Show more results'}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
