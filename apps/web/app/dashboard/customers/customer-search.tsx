'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Customer search.
 *
 * The term is submitted as a normal query parameter so the result is linkable and the server owns
 * the query. Phase 14 logging records the normalized route and never the query string, so a search
 * containing a customer's phone number does not end up in a log line.
 */
export function CustomerSearch({ initialValue }: { readonly initialValue: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(initialValue);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = new URLSearchParams(params.toString());
    const term = value.trim();
    if (term.length >= 2) next.set('q', term);
    else next.delete('q');
    // Paging restarts whenever the query changes, or the cursor would belong to a different result.
    next.delete('after');
    next.delete('afterId');
    router.push(`/dashboard/customers?${next.toString()}`);
  }

  return (
    <form className="mt-6 flex gap-2" onSubmit={submit} role="search">
      <label className="sr-only" htmlFor="customer-search">
        Search customers by name, phone, or email
      </label>
      <input
        className="avenlyo-input w-full"
        id="customer-search"
        maxLength={120}
        name="q"
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search by name, phone, or email"
        type="search"
        value={value}
      />
      <Button type="submit" variant="outline">
        Search
      </Button>
    </form>
  );
}
