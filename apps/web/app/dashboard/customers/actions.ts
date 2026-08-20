'use server';

import type { CustomerDirectoryRow } from '@avenlyo/database';

import { safePageCursor, safeSearchTerm } from '@/lib/customers/input';
import { loadCustomerDirectory } from '@/lib/customers/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

/**
 * Customer search.
 *
 * The term travels in the server-action payload, never in a URL. Search supports phone and email,
 * so a query parameter would put customer PII in the address bar, in browser history, in any copied
 * or shared link, and potentially in a referrer — none of which the customer agreed to.
 *
 * Paging a searched result carries the term in the same payload, so the second page is no less
 * private than the first. The cursor is opaque and not PII, but it rides along rather than being
 * re-derived, which keeps keyset paging deterministic.
 */
export interface CustomerSearchResult {
  readonly customers: readonly CustomerDirectoryRow[];
  readonly nextCursor: { readonly identifier: string; readonly timestamp: string } | null;
  readonly status: 'empty' | 'error' | 'ok';
}

/** A form entry is a string or a File; only the string case is ever meaningful here. */
function textField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === 'string' ? value : null;
}

export async function searchCustomersAction(formData: FormData): Promise<CustomerSearchResult> {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();

  if (!auth || !workspace.locationId) {
    return { customers: [], nextCursor: null, status: 'error' };
  }

  // Bounded here so a too-short or oversized term is simply not a search, rather than a database
  // exception the page would have to explain.
  const term = safeSearchTerm(formData.get('term'));
  const cursor = safePageCursor(textField(formData, 'cursorAt'), textField(formData, 'cursorId'));

  try {
    const page = await loadCustomerDirectory(auth.supabase, {
      cursor: cursor ? { contactId: cursor.identifier, lastActivityAt: cursor.timestamp } : null,
      locationId: workspace.locationId,
      search: term,
    });

    return {
      customers: page.customers,
      nextCursor: page.nextCursor
        ? { identifier: page.nextCursor.contactId, timestamp: page.nextCursor.lastActivityAt }
        : null,
      status: page.customers.length === 0 ? 'empty' : 'ok',
    };
  } catch {
    // The term is never echoed into an error, because an error string can end up in a log.
    return { customers: [], nextCursor: null, status: 'error' };
  }
}
